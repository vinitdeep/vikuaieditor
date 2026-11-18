import { create } from 'zustand'
import type { CaptureEvent, GenMeta, PromptItem } from '@shared/ipc'
import { api } from '@/api'
import type { Cutaway, Reel } from '@/api/types'
import { toast, useApp } from '@/state/app'
import { saveNow, useEditor } from '@/state/editor'
import { useJobs } from '@/state/jobs'
import { cutawayPrompt, imagePrompt, readableName, useLibraryIndex } from './cutaways'

/**
 * AI Studio generation for empty cutaways.
 * The prompt queue lives in the main process and is persisted to %APPDATA%\Viku\gemini-queue.json together with what
 * each prompt is for (reel id, cutaway index + start time, slug). So a reload or a restart keeps the link: queued
 * prompts still show as queued on their cutaways, and a capture that arrived while the editor was closed is attached
 * on the next start (resumeQueue).
 */

interface GenState {
  /** key = reelId@t0 → prompt id in the Sign-in window's queue */
  queued: Record<string, string>
  setAll: (q: Record<string, string>) => void
}

export const useGen = create<GenState>((set) => ({
  queued: {},
  setAll: (queued) => set({ queued })
}))

export const genKey = (reelId: string, t0: number): string => `${reelId}@${t0.toFixed(2)}`

/** prompt ids being attached right now (capture event + resume can race) */
const attaching = new Set<string>()

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

/** Show the AI pictures drawer in the main window (never a separate window while pictures are being made). */
export function openAiPanel(): void {
  useApp.getState().set({ aiOpen: true, activityOpen: false })
}

const extensionOn = (): boolean => Boolean(useApp.getState().gemini?.extension?.connected)

/** Queue an empty cutaway's prompt for AI Studio; the picture is attached to the cutaway automatically. */
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
    openAiPanel()
    return
  }
  // a line typed in the Cutaway inspector becomes the scene of a full picture prompt (see imagePrompt)
  const prompt = imagePrompt(promptOverride?.trim() || cutawayPrompt(c, captionTextUnder(reel, c.t0, c.t1)))
  const meta: GenMeta = { reelId, index, t0: c.t0, slug: c.need?.slug }
  try {
    const items = await bridge.signin.queue([{ prompt, name: plannedName(reel, index), meta }])
    syncQueue(items)
    openAiPanel()
    toast('info', extensionOn() ? 'Picture queued — AI Studio makes it in your browser and it lands on the cutaway by itself.' : 'Picture queued — add the Viku extension (AI pictures panel) and it is made automatically.')
  } catch (e) {
    toast('error', `Could not queue the prompt: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Queue a new AI picture for every empty cutaway of these reels (any project — Automate's reels need not be open), in
 * one batch, then show the AI pictures drawer. Used by Automate with "Illustrations: Gemini".
 */
export async function queueEmptyCutaways(reels: Reel[]): Promise<number> {
  const bridge = window.viku
  if (!bridge) return 0
  const queued = useGen.getState().queued
  const batch = reels.flatMap((reel) =>
    reel.cutaways.flatMap((c, index) =>
      c.img || queued[genKey(reel.id, c.t0)]
        ? []
        : [{ prompt: imagePrompt(cutawayPrompt(c, captionTextUnder(reel, c.t0, c.t1))), name: plannedName(reel, index), meta: { reelId: reel.id, index, t0: c.t0, slug: c.need?.slug } as GenMeta }]
    )
  )
  if (!batch.length) return 0
  try {
    syncQueue(await bridge.signin.queue(batch))
    openAiPanel()
    const what = `${batch.length} new picture${batch.length === 1 ? '' : 's'}`
    toast(
      'info',
      extensionOn()
        ? `${what} queued — AI Studio makes them one at a time in your browser. Each lands on its cutaway, and the reel re-renders when its last picture is in.`
        : `${what} queued — add the Viku extension (AI pictures panel) and they are made automatically.`
    )
  } catch (e) {
    toast('error', `Could not queue the AI pictures: ${e instanceof Error ? e.message : String(e)}`)
    return 0
  }
  return batch.length
}

/** reels re-rendering because new pictures arrived; `again` = another picture landed during that render */
const rerendering = new Map<string, { again: boolean }>()

/**
 * A captured picture only changes the cutaway: the reel's MP4 still lacks it. Once a reel that was already rendered has
 * no AI Studio prompts left waiting, render it again so the new pictures are in the video.
 */
async function rerenderWhenComplete(reelId: string): Promise<void> {
  const bridge = window.viku
  if (!bridge) return
  const items = await bridge.signin.list().catch(() => [] as PromptItem[])
  if (items.some((i) => i.meta?.reelId === reelId && (i.status === 'queued' || i.status === 'sent'))) return
  const busy = rerendering.get(reelId)
  if (busy) {
    busy.again = true
    return
  }
  // the engine's copy is the truth (the open editor may not have seen the last render); the open one is the fallback
  const open = useEditor.getState().project
  const local = open?.reels.find((r) => r.id === reelId)
  let reel: Reel | undefined
  try {
    reel = (await api().getProject(local && open ? open.id : reelId.split('~')[0])).reels.find((r) => r.id === reelId)
  } catch {
    reel = undefined
  }
  reel ??= local
  // not rendered yet: the editor's own render will include the pictures
  if (!reel || (reel.status !== 'rendered' && !reel.exports.length)) return
  const st = useEditor.getState()
  if (st.dirty && st.project?.reels.some((r) => r.id === reelId)) await saveNow()
  const state = { again: false }
  rerendering.set(reelId, state)
  const finish = (): void => {
    rerendering.delete(reelId)
    if (state.again) void rerenderWhenComplete(reelId)
  }
  try {
    const ref = await api().render(reelId)
    useJobs.getState().track(ref, `Render · ${reel.title || reelId} (new pictures)`, {
      onDone: () => {
        finish()
        void useEditor.getState().refresh()
        toast('success', `${reel?.title || 'Reel'} re-rendered with its new pictures`)
      },
      onError: finish,
      onCancel: finish
    })
    toast('info', `All pictures are in — re-rendering ${reel.title || 'the reel'}`)
  } catch (e) {
    finish()
    toast('warn', `New pictures are on ${reel.title || 'the reel'}, but the re-render did not start: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Queue every empty cutaway of a reel. */
export async function generateAllForReel(reelId: string): Promise<void> {
  const reel = useEditor.getState().project?.reels.find((r) => r.id === reelId)
  if (!reel) return
  const idx = reel.cutaways.map((c, i) => (!c.img && !useGen.getState().queued[genKey(reelId, c.t0)] ? i : -1)).filter((i) => i >= 0)
  for (const i of idx) await generateForCutaway(reelId, i)
}

/** Rebuild the "queued" badges from the (persisted) queue: every prompt still waiting for its image. */
export function syncQueue(items: PromptItem[]): void {
  const q: Record<string, string> = {}
  for (const i of items) {
    if (i.meta && (i.status === 'queued' || i.status === 'sent')) q[genKey(i.meta.reelId, i.meta.t0)] = i.id
  }
  useGen.getState().setAll(q)
}

/** After a reload / restart: show queued prompts and attach captures that arrived while the editor was not listening. */
export async function resumeQueue(): Promise<void> {
  const bridge = window.viku
  if (!bridge) return
  let items: PromptItem[]
  try {
    items = await bridge.signin.list()
  } catch {
    return
  }
  syncQueue(items)
  const waiting = items.filter((i) => i.status === 'captured' && i.file && i.meta && !i.meta.attached)
  for (const i of waiting) await handleCapture({ promptId: i.id, meta: i.meta, file: i.file as string, via: i.via ?? 'download', width: 0, height: 0 })
  const open = items.filter((i) => i.meta && (i.status === 'queued' || i.status === 'sent')).length
  if (open)
    toast('info', `${open} AI picture${open === 1 ? ' is' : 's are'} still waiting${extensionOn() ? ' — AI Studio carries on in your browser' : ''}.`, { label: 'Show', run: openAiPanel })
}

function cutawayIndex(cutaways: Cutaway[], meta: GenMeta): number {
  const byTime = cutaways.findIndex((x) => Math.abs(x.t0 - meta.t0) < 0.02)
  if (byTime >= 0) return byTime
  // the cutaway moved: fall back to the index when it is still an empty one
  const c = cutaways[meta.index]
  return c && !c.img ? meta.index : -1
}

export async function handleCapture(ev: CaptureEvent): Promise<void> {
  const bridge = window.viku
  if (!ev.promptId || !ev.meta || ev.meta.attached || attaching.has(ev.promptId)) return
  attaching.add(ev.promptId)
  try {
    await attach(ev.promptId, ev.meta, ev.file)
  } finally {
    attaching.delete(ev.promptId)
    if (bridge) syncQueue(await bridge.signin.list().catch(() => []))
  }
}

async function attach(promptId: string, meta: GenMeta, file: string): Promise<void> {
  const name = file.split(/[\\/]/).pop()
  const st = useEditor.getState()
  const openReel = st.project?.reels.find((r) => r.id === meta.reelId)
  let reel: Reel | undefined = openReel
  if (!reel) {
    // the reel's project is not open: attach through the engine directly
    const projectId = meta.reelId.split('~')[0]
    try {
      reel = (await api().getProject(projectId)).reels.find((r) => r.id === meta.reelId)
    } catch {
      reel = undefined
    }
  }
  const index = reel ? cutawayIndex(reel.cutaways, meta) : -1
  if (!reel || index < 0) {
    toast('warn', `Captured ${name}, but its cutaway is gone — the file is in the captures folder.`)
    await window.viku?.signin.markAttached(promptId)
    return
  }
  // the engine reads the saved project: flush local edits first so the index matches
  if (openReel && st.dirty) await saveNow()
  let fromEngine: Cutaway | null = null
  try {
    fromEngine = await api().attachCutawayImage(reel.id, index, file)
  } catch (e) {
    if (!openReel) {
      toast('warn', `Engine could not file ${name} (${e instanceof Error ? e.message : String(e)}) — it will be retried next start.`)
      return
    }
    toast('warn', `Engine could not file the image (${e instanceof Error ? e.message : String(e)}) — placed it locally.`)
  }
  if (openReel) {
    useEditor.getState().editReel(reel.id, 'Generated image', (r) => {
      const c = r.cutaways[index]
      if (!c) return
      if (fromEngine) {
        Object.assign(c, fromEngine)
        if (!fromEngine.need) delete c.need
      } else {
        c.img = file
        if (c.need) {
          c.need_done = c.need
          delete c.need
        }
      }
    })
  }
  await window.viku?.signin.markAttached(promptId)
  if (fromEngine) void useLibraryIndex.getState().load(true)
  void rerenderWhenComplete(reel.id)
  const slug = meta.slug ?? reel.cutaways[index]?.need?.slug ?? ''
  toast('success', `Image placed on cutaway ${index + 1}${slug ? ` (${readableName(slug)})` : ''}${openReel ? '' : ` of reel ${reel.title || reel.id}`}`)
}
