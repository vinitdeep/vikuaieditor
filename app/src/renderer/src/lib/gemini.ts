import { create } from 'zustand'
import type { CaptureEvent } from '@shared/ipc'
import { api } from '@/api'
import type { Reel } from '@/api/types'
import { toast } from '@/state/app'
import { saveNow, useEditor } from '@/state/editor'
import { cutawayPrompt, readableName, useLibraryIndex } from './cutaways'

/** prompt id → the cutaway it should fill when AI Studio produces the image (matched by start time: indices shift) */
interface Pending {
  reelId: string
  t0: number
}

interface GenState {
  /** key = reelId@t0 → prompt id in the Sign-in window's queue */
  queued: Record<string, string>
  set: (key: string, promptId: string | null) => void
}

export const useGen = create<GenState>((set, get) => ({
  queued: {},
  set: (key, promptId) => {
    const q = { ...get().queued }
    if (promptId) q[key] = promptId
    else delete q[key]
    set({ queued: q })
  }
}))

const pending = new Map<string, Pending>()
export const genKey = (reelId: string, t0: number): string => `${reelId}@${t0.toFixed(2)}`

function captionTextUnder(reel: Reel, t0: number, t1: number): string {
  return reel.captions
    .filter((c) => c.t1 > t0 && c.t0 < t1)
    .map((c) => c.text)
    .join(' ')
}

function plannedName(reel: Reel, index: number): string {
  const c = reel.cutaways[index]
  const n = reel.id.split('~').pop() ?? reel.id
  const slug = c.need?.slug ?? `cut${String(index + 1).padStart(2, '0')}`
  return `reel${n}-${slug}`.replace(/[^\w.-]+/g, '-')
}

/** Queue an empty cutaway's prompt in the Sign-in window (AI Studio); the capture is attached automatically. */
export async function generateForCutaway(reelId: string, index: number, promptOverride?: string): Promise<void> {
  const bridge = window.viku
  if (!bridge) {
    toast('warn', 'AI Studio capture needs the desktop app')
    return
  }
  const reel = useEditor.getState().project?.reels.find((r) => r.id === reelId)
  const c = reel?.cutaways[index]
  if (!reel || !c) return
  const key = genKey(reelId, c.t0)
  if (useGen.getState().queued[key]) {
    await bridge.signin.open('gemini')
    return
  }
  const prompt = promptOverride?.trim() || cutawayPrompt(c, captionTextUnder(reel, c.t0, c.t1))
  try {
    const before = new Set((await bridge.signin.list()).map((i) => i.id))
    const items = await bridge.signin.queue([{ prompt, name: plannedName(reel, index) }])
    const added = items.find((i) => !before.has(i.id))
    if (added) {
      pending.set(added.id, { reelId, t0: c.t0 })
      useGen.getState().set(key, added.id)
    }
    await bridge.signin.open('gemini')
    toast('info', 'Prompt queued in AI Studio — press “Send next” in the Sign-in window. The image lands on the cutaway by itself.')
  } catch (e) {
    toast('error', `Could not queue the prompt: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Queue every empty cutaway of a reel. */
export async function generateAllForReel(reelId: string): Promise<void> {
  const reel = useEditor.getState().project?.reels.find((r) => r.id === reelId)
  if (!reel) return
  const idx = reel.cutaways.map((c, i) => (!c.img && !useGen.getState().queued[genKey(reelId, c.t0)] ? i : -1)).filter((i) => i >= 0)
  for (const i of idx) await generateForCutaway(reelId, i)
}

/** Forget a queued generation (prompt removed from the queue). */
export function syncQueue(ids: Set<string>): void {
  for (const [pid, p] of pending) {
    if (!ids.has(pid)) {
      pending.delete(pid)
      useGen.getState().set(genKey(p.reelId, p.t0), null)
    }
  }
}

export async function handleCapture(ev: CaptureEvent): Promise<void> {
  if (!ev.promptId) return
  const target = pending.get(ev.promptId)
  if (!target) return
  pending.delete(ev.promptId)
  useGen.getState().set(genKey(target.reelId, target.t0), null)
  const st = useEditor.getState()
  const reel = st.project?.reels.find((r) => r.id === target.reelId)
  const index = reel ? reel.cutaways.findIndex((x) => Math.abs(x.t0 - target.t0) < 0.02) : -1
  if (!reel || index < 0) {
    toast('warn', `Captured ${ev.file.split(/[\\/]/).pop()}, but its cutaway is gone — the file is in the captures folder.`)
    return
  }
  // the engine reads the saved project: flush local edits first so the index matches
  if (st.dirty) await saveNow()
  let fromEngine = null
  try {
    fromEngine = await api().attachCutawayImage(reel.id, index, ev.file)
  } catch (e) {
    toast('warn', `Engine could not file the image (${e instanceof Error ? e.message : String(e)}) — placed it locally.`)
  }
  useEditor.getState().editReel(reel.id, 'Generated image', (r) => {
    const c = r.cutaways[index]
    if (!c) return
    if (fromEngine) {
      Object.assign(c, fromEngine)
      if (!fromEngine.need) delete c.need
    } else {
      c.img = ev.file
      if (c.need) {
        c.need_done = c.need
        delete c.need
      }
    }
  })
  if (fromEngine) void useLibraryIndex.getState().load(true)
  toast('success', `Image placed on cutaway ${index + 1}${reel.cutaways[index].need ? ` (${readableName(reel.cutaways[index].need?.slug ?? '')})` : ''}`)
}
