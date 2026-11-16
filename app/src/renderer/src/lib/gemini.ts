import type { CaptureEvent } from '@shared/ipc'
import { toast } from '@/state/app'
import { useEditor } from '@/state/editor'

/** prompt id → cutaway it should fill when AI Studio produces the image */
const pending = new Map<string, { reelId: string; t0: number }>()

export async function generateCutaway(reelId: string, t0: number, prompt: string, name: string): Promise<void> {
  const bridge = window.viku
  if (!bridge) {
    toast('warn', 'Gemini capture needs the desktop app')
    return
  }
  const before = new Set((await bridge.signin.list()).map((i) => i.id))
  const items = await bridge.signin.queue([{ prompt, name }])
  const added = items.find((i) => !before.has(i.id))
  if (added) pending.set(added.id, { reelId, t0 })
  await bridge.signin.open('gemini')
  toast('info', 'Prompt queued in the Sign-in window — press “Send next” there (AI Studio)')
}

export function handleCapture(ev: CaptureEvent): void {
  if (!ev.promptId) return
  const target = pending.get(ev.promptId)
  if (!target) return
  pending.delete(ev.promptId)
  const st = useEditor.getState()
  if (st.reelId !== target.reelId) st.openReel(target.reelId)
  st.edit('Gemini image', (r) => {
    const c = r.cutaways.find((x) => Math.abs(x.t0 - target.t0) < 0.01)
    if (c) c.img = ev.file
  })
  toast('success', 'Gemini image placed on the cutaway')
}
