import { useEffect } from 'react'
import { useApp } from '@/state/app'
import { currentReel, saveNow, useEditor } from '@/state/editor'
import { normalizeRanges, useTranscriptSel } from '@/state/transcriptSel'
import { usePlayback } from '@/state/playback'
import { bladeAt, editPoints, reelDuration, rippleDelete } from './reel'

const FPS = 30

function typing(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/** I / O: mark the transcript line under the source playhead as in / out point (Shift+O adds a range). */
function markInOut(which: 'in' | 'out', add: boolean): void {
  const lines = useEditor.getState().project?.transcript ?? []
  const t = usePlayback.getState().srcT
  let idx = lines.findIndex((l) => t >= l.start - 0.01 && t < l.end)
  if (idx < 0) idx = Math.max(0, lines.findIndex((l) => l.start > t) - 1)
  if (idx < 0) idx = lines.length - 1
  const sel = useTranscriptSel.getState()
  useApp.getState().set({ browserTab: 'transcript' })
  if (which === 'in') {
    sel.setMarkIn(idx)
    if (!add) sel.setRanges([])
    useApp.getState().toast('info', `In-point at ${fmt(lines[idx].start)} — move to the last line and press O`)
    return
  }
  const a = sel.markIn ?? idx
  sel.setRanges(normalizeRanges([...(add ? sel.ranges : []), [a, idx]]))
  sel.setMarkIn(null)
}

function fmt(t: number): string {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Keyboard-first editing (FCP-like defaults, original bindings). */
export function useHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (typing(e)) return
      const app = useApp.getState()
      // a modal owns the keyboard (it closes itself on Esc)
      if (app.onboardingOpen || app.settingsOpen || app.exportOpen) return
      if (app.shortcutsOpen) {
        if (e.key === 'Escape' || e.key === '?') {
          e.preventDefault()
          app.set({ shortcutsOpen: false })
        }
        return
      }
      const ed = useEditor.getState()
      const pb = usePlayback.getState()
      const reel = currentReel()
      const ctrl = e.ctrlKey || e.metaKey
      const k = e.key
      const dur = pb.viewer === 'reel' ? (reel ? reelDuration(reel) : 0) : (ed.project?.duration ?? 0)
      const seekBy = (d: number): void => {
        pb.set({ playing: false })
        if (pb.viewer === 'reel') pb.seek(Math.min(dur, Math.max(0, pb.t + d)))
        else pb.seekSource(Math.min(dur, Math.max(0, pb.srcT + d)))
      }
      let handled = true

      if (k === '?' || (k === '/' && e.shiftKey)) app.set({ shortcutsOpen: true })
      else if (ctrl && (k === 's' || k === 'S')) void saveNow({ announce: true })
      else if (ctrl && (k === 'z' || k === 'Z') && !e.shiftKey) ed.undo()
      else if (ctrl && (k === 'y' || ((k === 'z' || k === 'Z') && e.shiftKey))) ed.redo()
      else if (ctrl && k === ',') app.set({ settingsOpen: true })
      else if (ctrl && (k === 'e' || k === 'E')) app.set({ exportOpen: true })
      else if (ctrl && (k === '=' || k === '+')) app.set({ zoom: Math.min(400, app.zoom * 1.25) })
      else if (ctrl && k === '-') app.set({ zoom: Math.max(4, app.zoom / 1.25) })
      else if (ctrl && (k === 'b' || k === 'B')) {
        if (reel) ed.edit('Blade at playhead', (r) => void bladeAt(r, pb.t))
      } else if (ctrl) handled = false
      else if (k === ' ') pb.toggle()
      else if (k === '+' || k === '=') app.set({ zoom: Math.min(400, app.zoom * 1.25) })
      else if (k === '-' || k === '_') app.set({ zoom: Math.max(4, app.zoom / 1.25) })
      else if ((k === 'i' || k === 'I' || k === 'o' || k === 'O') && app.mode === 'manual' && ed.project?.transcript.length) {
        markInOut(k.toLowerCase() === 'i' ? 'in' : 'out', e.shiftKey)
      }
      else if (k === 'k' || k === 'K') pb.set({ playing: false, rate: 1 })
      else if (k === 'l' || k === 'L') pb.set({ playing: true, rate: pb.playing && pb.rate > 0 ? Math.min(8, pb.rate * 2) : 1 })
      else if (k === 'j' || k === 'J') pb.set({ playing: true, rate: pb.playing && pb.rate < 0 ? Math.max(-8, pb.rate * 2) : -1 })
      else if (k === 'ArrowLeft') seekBy(e.shiftKey ? -1 : -1 / FPS)
      else if (k === 'ArrowRight') seekBy(e.shiftKey ? 1 : 1 / FPS)
      else if ((k === 'ArrowUp' || k === 'ArrowDown') && reel && pb.viewer === 'reel') {
        const pts = editPoints(reel)
        const t = pb.t
        const target = k === 'ArrowUp' ? [...pts].reverse().find((p) => p < t - 0.01) : pts.find((p) => p > t + 0.01)
        if (target !== undefined) pb.set({ t: target, playing: false })
      } else if (k === 'Home') {
        pb.set({ playing: false })
        if (pb.viewer === 'reel') pb.seek(0)
        else pb.seekSource(0)
      } else if (k === 'End') {
        pb.set({ playing: false })
        if (pb.viewer === 'reel') pb.seek(dur)
        else pb.seekSource(dur)
      } else if (k === 'a' || k === 'A') app.set({ tool: 'select' })
      else if (k === 'b' || k === 'B') app.set({ tool: 'blade' })
      else if (k === 't' || k === 'T') app.set({ tool: 'trim' })
      else if (k === 'S' && e.shiftKey) pb.set({ safeZone: !pb.safeZone })
      else if (k === 's') app.set({ skimming: !app.skimming })
      else if (k === 'n' || k === 'N') app.set({ snapping: !app.snapping })
      else if (k === 'Z' && e.shiftKey) {
        const el = document.querySelector('.tl-scroll') as HTMLElement | null
        if (reel && el) app.set({ zoom: Math.max(4, Math.min(400, (el.clientWidth - 60) / Math.max(1, reelDuration(reel)))) })
      } else if (k === 'Escape') {
        ed.select(null)
        useTranscriptSel.getState().setMarkIn(null)
        app.set({ activityOpen: false })
      } else if ((k === 'Delete' || k === 'Backspace') && reel && ed.selection) {
        const s = ed.selection
        if (s.kind === 'segment') ed.edit('Ripple delete', (r) => rippleDelete(r, s.index))
        else if (s.kind === 'caption') ed.edit('Delete caption', (r) => void r.captions.splice(s.index, 1))
        else if (s.kind === 'verse') ed.edit('Delete verse', (r) => void r.verses.splice(s.index, 1))
        else if (s.kind === 'cutaway') ed.edit('Delete cutaway', (r) => void r.cutaways.splice(s.index, 1))
        else if (s.kind === 'sfx') ed.edit('Delete SFX', (r) => void r.sfx.splice(s.index, 1))
        else if (s.kind === 'music') ed.edit('Remove music', (r) => void (r.music = null))
        ed.select(null)
      } else if (k === '1' && !e.shiftKey) pb.set({ viewer: 'reel', playing: false })
      else if (k === '2' && !e.shiftKey) pb.set({ viewer: 'source', playing: false })
      else handled = false

      if (handled) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
