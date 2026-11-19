import { api } from '@/api'
import type { Framing, Seg } from '@/api/types'
import { DEFAULT_LAYOUT, toast, useApp, type SettingsTab } from '@/state/app'
import { currentReel, saveNow, useEditor } from '@/state/editor'
import { useJobs } from '@/state/jobs'
import { usePlayback } from '@/state/playback'
import { normalizeRanges, useTranscriptSel } from '@/state/transcriptSel'
import { importSermon } from '@/components/browser/MediaTab'
import { autobuildReel, newAiPictures, renderReel } from '@/components/inspector/ReelPanel'
import { trackSpeaker } from '@/components/inspector/FramingSwitch'
import { bladeAt, editPoints, reelDuration, rippleDelete, setFraming } from './reel'
import { duration } from './time'

/**
 * Editor commands shared by the keyboard (lib/hotkeys.ts) and the menu bar (components/MenuBar.tsx),
 * so a menu item and its shortcut always do the same thing.
 */

export const FPS = 30
const ZOOM_MIN = 4
const ZOOM_MAX = 400

function viewerDuration(): number {
  const pb = usePlayback.getState()
  if (pb.viewer === 'reel') {
    const reel = currentReel()
    return reel ? reelDuration(reel) : 0
  }
  return useEditor.getState().project?.duration ?? 0
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function fmt(t: number): string {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** the transcript line under the source playhead (or the one just before it) */
function lineAtSource(): number {
  const lines = useEditor.getState().project?.transcript ?? []
  const t = usePlayback.getState().srcT
  let idx = lines.findIndex((l) => t >= l.start - 0.01 && t < l.end)
  if (idx < 0) idx = Math.max(0, lines.findIndex((l) => l.start > t) - 1)
  if (idx < 0) idx = lines.length - 1
  return idx
}

/** the selected transcript lines as source segments (same padding as the Transcript tab's "Create reel") */
export function selectionSegments(): Seg[] {
  const lines = useEditor.getState().project?.transcript ?? []
  return useTranscriptSel
    .getState()
    .ranges.filter(([a, b]) => lines[a] && lines[b])
    .map(([a, b]) => [Math.max(0, lines[a].start - 0.12), lines[b].end + 0.2] as Seg)
}

export const cmd = {
  // ---------- file ----------
  save: (): void => void saveNow({ announce: true }),
  settings: (tab: SettingsTab = 'general'): void => useApp.getState().set({ settingsOpen: true, settingsTab: tab }),
  export: (): void => useApp.getState().set({ exportOpen: true }),
  shortcuts: (): void => useApp.getState().set({ shortcutsOpen: true }),
  /** choose a sermon video -> new project, analysed in the background (same as Media -> Import) */
  importSermon: (): void => {
    const app = useApp.getState()
    app.set({ mode: 'manual', browserTab: 'media' })
    void importSermon(app.settings?.default_language ?? 'auto')
  },
  importIllustrations: async (): Promise<void> => {
    const files = (await window.viku?.dialog.openFile({ title: 'Add illustrations', multi: true, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })) ?? []
    if (!files.length) return
    useApp.getState().set({ mode: 'manual', browserTab: 'library', libraryTab: 'illustrations' })
    try {
      const ref = await api().libraryImport(files, [])
      if (ref) useJobs.getState().track(ref, `Import ${files.length} illustrations`, { onDone: () => toast('success', `${files.length} illustration${files.length > 1 ? 's' : ''} added to the Library`) })
    } catch (e) {
      toast('error', `Import failed: ${errText(e)}`)
    }
  },
  /** the project list lives in the Media panel */
  showProjects: (): void => {
    useApp.getState().set({ mode: 'manual', browserTab: 'media' })
    void useEditor.getState().loadProjects()
  },
  openProject: (id: string): void => void useEditor.getState().openProject(id),
  closeProject: async (): Promise<void> => {
    if (!useEditor.getState().project) return
    await saveNow()
    useEditor.setState({ project: null, reelId: null, selection: null, candidates: [], rejected: [], kept: [], past: [], future: [] })
    useTranscriptSel.setState({ ranges: [], markIn: null })
    usePlayback.setState({ t: 0, srcT: 0, playing: false, preview: null, rendered: null })
  },
  revealVideo: (): void => {
    const p = useEditor.getState().project
    if (p?.video_path) void window.viku?.shell.reveal(p.video_path)
  },
  openFolder: (which: 'exports_dir' | 'projects_dir' | 'library_dir' | 'music_dir'): void => {
    const dir = useApp.getState().settings?.[which]
    if (dir) void window.viku?.shell.openPath(dir)
    else toast('warn', 'That folder is not set yet (Settings → Folders)')
  },
  exit: (): void => window.close(),

  // ---------- edit ----------
  undo: (): void => useEditor.getState().undo(),
  redo: (): void => useEditor.getState().redo(),
  deselect: (): void => {
    useEditor.getState().select(null)
    useTranscriptSel.getState().setMarkIn(null)
  },
  deleteSelection: (): void => {
    const ed = useEditor.getState()
    const s = ed.selection
    if (!currentReel() || !s) return
    if (s.kind === 'segment') ed.edit('Ripple delete', (r) => rippleDelete(r, s.index))
    else if (s.kind === 'caption') ed.edit('Delete caption', (r) => void r.captions.splice(s.index, 1))
    else if (s.kind === 'verse') ed.edit('Delete verse', (r) => void r.verses.splice(s.index, 1))
    else if (s.kind === 'cutaway') ed.edit('Delete cutaway', (r) => void r.cutaways.splice(s.index, 1))
    else if (s.kind === 'sfx') ed.edit('Delete SFX', (r) => void r.sfx.splice(s.index, 1))
    else if (s.kind === 'music') ed.edit('Remove music', (r) => void (r.music = null))
    ed.select(null)
  },

  // ---------- clip ----------
  blade: (): void => {
    if (currentReel()) useEditor.getState().edit('Blade at playhead', (r) => void bladeAt(r, usePlayback.getState().t))
  },
  /** select the clip (segment) under the reel playhead */
  selectClipAtPlayhead: (): void => {
    const reel = currentReel()
    if (!reel) return
    const t = usePlayback.getState().t
    let acc = 0
    const i = reel.segments.findIndex(([s, e]) => {
      const hit = t >= acc - 1e-3 && t < acc + (e - s)
      acc += e - s
      return hit
    })
    useEditor.getState().select({ kind: 'segment', index: i < 0 ? reel.segments.length - 1 : i })
  },
  setFraming: (mode: Framing): void => {
    if (currentReel()) useEditor.getState().edit(mode === 'follow' ? 'Auto framing on' : 'Auto framing off', (r) => setFraming(r, mode))
  },
  trackSpeaker: (): void => {
    const reel = currentReel()
    if (reel) void trackSpeaker(reel)
  },

  // ---------- sequence (reel) ----------
  newReelFromSelection: async (): Promise<void> => {
    const segs = selectionSegments()
    const lines = useEditor.getState().project?.transcript ?? []
    const first = lines[useTranscriptSel.getState().ranges[0]?.[0] ?? -1]
    if (!segs.length || !first) {
      useApp.getState().set({ mode: 'manual', browserTab: 'transcript' })
      toast('info', 'Select transcript lines first (drag across them, or press I then O)')
      return
    }
    const title = first.text.length > 40 ? first.text.slice(0, 38) + '…' : first.text
    const total = segs.reduce((acc, [s, e]) => acc + e - s, 0)
    const r = await useEditor.getState().createReel(segs, title, '')
    if (r) {
      useTranscriptSel.getState().setRanges([])
      toast('success', `Reel created from ${segs.length} range${segs.length > 1 ? 's' : ''} (${duration(total)})`)
    }
  },
  findClips: async (): Promise<void> => {
    const project = useEditor.getState().project
    if (!project) return
    useApp.getState().set({ mode: 'manual', browserTab: 'suggestions' })
    try {
      const ref = await api().suggest(project.id)
      useJobs.getState().track(ref, 'Find clips (Viku Brain)', {
        onDone: async () => {
          const c = await api().candidates(project.id)
          useEditor.getState().setCandidates(c)
          toast('success', `Viku Brain found ${c.length} candidate reels`)
        }
      })
    } catch (e) {
      toast('error', `Clip finder failed: ${errText(e)}`)
    }
  },
  autobuild: (): void => {
    const reel = currentReel()
    if (reel) void saveNow().then(() => autobuildReel(reel))
  },
  aiPictures: (): void => {
    const reel = currentReel()
    if (reel) void newAiPictures(reel)
  },
  render: (): void => {
    const reel = currentReel()
    if (!reel) return
    void saveNow().then(() => renderReel(reel))
    useApp.getState().set({ activityOpen: true, aiOpen: false })
  },
  renderAll: (): void => {
    const reels = useEditor.getState().project?.reels ?? []
    if (!reels.length) return
    void saveNow().then(() => reels.forEach((r) => void renderReel(r)))
    useApp.getState().set({ activityOpen: true, aiOpen: false })
  },
  renderThumbnail: async (): Promise<void> => {
    const reel = currentReel()
    if (!reel) return
    try {
      await saveNow()
      const ref = await api().thumbnail(reel.id)
      useJobs.getState().track(ref, `Thumbnail · ${reel.title}`, { onDone: () => toast('success', 'Thumbnail rendered to exports') })
    } catch (e) {
      toast('error', `Thumbnail failed: ${errText(e)}`)
    }
  },

  // ---------- markers (transcript in / out) ----------
  markIn: (): void => {
    const lines = useEditor.getState().project?.transcript ?? []
    if (!lines.length) return
    const idx = lineAtSource()
    useApp.getState().set({ mode: 'manual', browserTab: 'transcript' })
    useTranscriptSel.getState().setMarkIn(idx)
    useTranscriptSel.getState().setRanges([])
    toast('info', `In-point at ${fmt(lines[idx].start)} — move to the last line and press O`)
  },
  markOut: (add = false): void => {
    const lines = useEditor.getState().project?.transcript ?? []
    if (!lines.length) return
    const idx = lineAtSource()
    const sel = useTranscriptSel.getState()
    useApp.getState().set({ mode: 'manual', browserTab: 'transcript' })
    const a = sel.markIn ?? idx
    sel.setRanges(normalizeRanges([...(add ? sel.ranges : []), [a, idx]]))
    sel.setMarkIn(null)
  },
  goToIn: (): void => {
    const lines = useEditor.getState().project?.transcript ?? []
    const sel = useTranscriptSel.getState()
    const i = sel.ranges[0]?.[0] ?? sel.markIn
    if (i == null || !lines[i]) return
    usePlayback.setState({ viewer: 'source', srcT: lines[i].start, playing: false, preview: null })
  },
  goToOut: (): void => {
    const lines = useEditor.getState().project?.transcript ?? []
    const r = useTranscriptSel.getState().ranges
    const i = r[r.length - 1]?.[1]
    if (i == null || !lines[i]) return
    usePlayback.setState({ viewer: 'source', srcT: Math.max(lines[i].start, lines[i].end - 0.05), playing: false, preview: null })
  },
  clearInOut: (): void => {
    useTranscriptSel.getState().setRanges([])
    useTranscriptSel.getState().setMarkIn(null)
  },
  /** play only the selected lines in the source viewer */
  previewSelection: (): void => {
    const segs = selectionSegments()
    if (!segs.length) return
    usePlayback.setState({ viewer: 'source', srcT: segs[0][0], preview: segs, playing: true, rate: 1 })
  },

  // ---------- graphics and titles ----------
  addCaption: (): void => {
    const reel = currentReel()
    if (!reel) return
    const t = usePlayback.getState().t
    const end = Math.min(reelDuration(reel), t + 3)
    useEditor.getState().edit('Add caption', (r) => {
      r.captions.push({ t0: t, t1: end, text: '…', flags: [] })
      r.captions.sort((a, b) => a.t0 - b.t0)
    })
    const idx = currentReel()?.captions.findIndex((c) => Math.abs(c.t0 - t) < 1e-3) ?? -1
    if (idx >= 0) useEditor.getState().select({ kind: 'caption', index: idx })
  },
  checkCaptions: async (): Promise<void> => {
    const reel = currentReel()
    if (!reel || !reel.captions.length) return
    try {
      const results = await Promise.all(reel.captions.map((c) => api().captionsFix(c.text, reel.language)))
      useEditor.getState().editReel(reel.id, 'Check all captions', (r) => {
        results.forEach((res, i) => {
          if (r.captions[i]) r.captions[i].flags = res.flags
        })
      })
      const n = results.reduce((a, r) => a + r.flags.length, 0)
      toast(n ? 'warn' : 'success', n ? `${n} flagged word${n > 1 ? 's' : ''} across ${reel.captions.length} captions` : 'All captions look good')
      useApp.getState().set({ inspectorTab: 'caption' })
    } catch (e) {
      toast('error', `Caption check failed: ${errText(e)}`)
    }
  },
  addCutaway: (): void => {
    const reel = currentReel()
    if (!reel) return
    const t = usePlayback.getState().t
    const end = Math.min(reelDuration(reel), t + 4)
    useEditor.getState().edit('Add cutaway', (r) => {
      r.cutaways.push({ t0: t, t1: end, img: '', z0: 1, z1: 1.1, pan: [0, 0] })
      r.cutaways.sort((a, b) => a.t0 - b.t0)
    })
    const idx = currentReel()?.cutaways.findIndex((c) => Math.abs(c.t0 - t) < 1e-3) ?? -1
    if (idx >= 0) useEditor.getState().select({ kind: 'cutaway', index: idx })
  },

  // ---------- view / window ----------
  zoomIn: (): void => {
    const app = useApp.getState()
    app.set({ zoom: Math.min(ZOOM_MAX, app.zoom * 1.25) })
  },
  zoomOut: (): void => {
    const app = useApp.getState()
    app.set({ zoom: Math.max(ZOOM_MIN, app.zoom / 1.25) })
  },
  zoomFit: (): void => {
    const reel = currentReel()
    const el = document.querySelector('.tl-scroll') as HTMLElement | null
    if (reel && el) useApp.getState().set({ zoom: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (el.clientWidth - 60) / Math.max(1, reelDuration(reel)))) })
  },
  resetLayout: (): void => useApp.getState().setLayout({ ...DEFAULT_LAYOUT }),
  fullScreen: (): void => void window.viku?.win.toggleFullScreen(),

  // ---------- playback ----------
  togglePlay: (): void => usePlayback.getState().toggle(),
  seekBy: (d: number): void => {
    const pb = usePlayback.getState()
    const dur = viewerDuration()
    pb.set({ playing: false })
    if (pb.viewer === 'reel') pb.seek(Math.min(dur, Math.max(0, pb.t + d)))
    else pb.seekSource(Math.min(dur, Math.max(0, pb.srcT + d)))
  },
  goStart: (): void => {
    const pb = usePlayback.getState()
    pb.set({ playing: false })
    if (pb.viewer === 'reel') pb.seek(0)
    else pb.seekSource(0)
  },
  goEnd: (): void => {
    const pb = usePlayback.getState()
    const dur = viewerDuration()
    pb.set({ playing: false })
    if (pb.viewer === 'reel') pb.seek(dur)
    else pb.seekSource(dur)
  },
  /** jump to the previous / next cut in the reel (reel viewer only) */
  edit: (dir: -1 | 1): void => {
    const reel = currentReel()
    const pb = usePlayback.getState()
    if (!reel || pb.viewer !== 'reel') return
    const pts = editPoints(reel)
    const t = pb.t
    const target = dir < 0 ? [...pts].reverse().find((p) => p < t - 0.01) : pts.find((p) => p > t + 0.01)
    if (target !== undefined) pb.set({ t: target, playing: false })
  }
}
