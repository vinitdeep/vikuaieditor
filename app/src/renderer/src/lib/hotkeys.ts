import { useEffect } from 'react'
import { useApp } from '@/state/app'
import { currentReel, useEditor } from '@/state/editor'
import { usePlayback } from '@/state/playback'
import { cmd, FPS } from './commands'

function typing(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true
  // the menu bar handles its own keys (arrows, Enter, Space, Esc)
  return Boolean(el.closest?.('[role="menubar"]'))
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
      const pb = usePlayback.getState()
      const ctrl = e.ctrlKey || e.metaKey
      const k = e.key
      let handled = true

      if (k === '?' || (k === '/' && e.shiftKey)) cmd.shortcuts()
      else if (ctrl && (k === 's' || k === 'S')) cmd.save()
      else if (ctrl && (k === 'z' || k === 'Z') && !e.shiftKey) cmd.undo()
      else if (ctrl && (k === 'y' || ((k === 'z' || k === 'Z') && e.shiftKey))) cmd.redo()
      else if (ctrl && k === ',') cmd.settings()
      else if (ctrl && (k === 'e' || k === 'E')) cmd.export()
      else if (ctrl && (k === 'n' || k === 'N')) cmd.importSermon()
      else if (ctrl && (k === 'o' || k === 'O')) cmd.showProjects()
      else if (ctrl && (k === 'q' || k === 'Q')) cmd.exit()
      else if (ctrl && e.shiftKey && (k === 'a' || k === 'A')) cmd.deselect()
      else if (ctrl && e.shiftKey && (k === 'w' || k === 'W')) void cmd.closeProject()
      else if (ctrl && (k === '=' || k === '+')) cmd.zoomIn()
      else if (ctrl && k === '-') cmd.zoomOut()
      else if (ctrl && (k === 'b' || k === 'B')) cmd.blade()
      else if (ctrl) handled = false
      else if (k === ' ') cmd.togglePlay()
      else if (k === '+' || k === '=') cmd.zoomIn()
      else if (k === '-' || k === '_') cmd.zoomOut()
      else if ((k === 'i' || k === 'I' || k === 'o' || k === 'O') && app.mode === 'manual' && useEditor.getState().project?.transcript.length) {
        if (k.toLowerCase() === 'i') cmd.markIn()
        else cmd.markOut(e.shiftKey)
      }
      else if (k === 'k' || k === 'K') pb.set({ playing: false, rate: 1 })
      else if (k === 'l' || k === 'L') pb.set({ playing: true, rate: pb.playing && pb.rate > 0 ? Math.min(8, pb.rate * 2) : 1 })
      else if (k === 'j' || k === 'J') pb.set({ playing: true, rate: pb.playing && pb.rate < 0 ? Math.max(-8, pb.rate * 2) : -1 })
      else if (k === 'ArrowLeft') cmd.seekBy(e.shiftKey ? -1 : -1 / FPS)
      else if (k === 'ArrowRight') cmd.seekBy(e.shiftKey ? 1 : 1 / FPS)
      else if ((k === 'ArrowUp' || k === 'ArrowDown') && pb.viewer === 'reel' && currentReel()) cmd.edit(k === 'ArrowUp' ? -1 : 1)
      else if (k === 'Home') cmd.goStart()
      else if (k === 'End') cmd.goEnd()
      else if (k === 'a' || k === 'A') app.set({ tool: 'select' })
      else if (k === 'b' || k === 'B') app.set({ tool: 'blade' })
      else if (k === 't' || k === 'T') app.set({ tool: 'trim' })
      else if (k === 'S' && e.shiftKey) pb.set({ safeZone: !pb.safeZone })
      else if (k === 's') app.set({ skimming: !app.skimming })
      else if (k === 'n' || k === 'N') app.set({ snapping: !app.snapping })
      else if (k === 'Z' && e.shiftKey) cmd.zoomFit()
      else if (k === 'F11') cmd.fullScreen()
      else if (k === 'Escape') {
        cmd.deselect()
        app.set({ activityOpen: false })
      } else if ((k === 'Delete' || k === 'Backspace') && currentReel() && useEditor.getState().selection) cmd.deleteSelection()
      else if (k === '1' && !e.shiftKey) pb.set({ viewer: 'reel', playing: false })
      else if (k === '2' && !e.shiftKey) pb.set({ viewer: 'source', playing: false })
      else handled = false

      if (handled) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
