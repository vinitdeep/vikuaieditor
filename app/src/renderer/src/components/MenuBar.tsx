import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import type { WinEditCmd } from '@shared/ipc'
import { useApp, type BrowserTab, type InspectorTab, type SettingsTab } from '@/state/app'
import { useEditor, useReel } from '@/state/editor'
import { usePlayback } from '@/state/playback'
import { useTranscriptSel } from '@/state/transcriptSel'
import { cmd, FPS } from '@/lib/commands'

/**
 * Premiere-style menu bar: File / Edit / Clip / Sequence / Markers / Graphics and Titles / View / Window / Help.
 * The window is frameless, so it is drawn here instead of a native menu. Every item runs real code (mostly
 * lib/commands.ts, the same functions the keyboard shortcuts run); an item that has nothing to act on right
 * now (no project, no reel, nothing selected) is shown greyed out, like Premiere does.
 * Mouse: click to open, hover to switch while one is open, hover a ▸ row for its sub-menu.
 * Keys: Alt+F/E/C/S/M/G/V/W/H, arrows (Right opens a sub-menu, Left closes it), Enter, Esc.
 */

interface Item {
  kind: 'item'
  label: string
  run: () => void
  kbd?: string
  disabled?: boolean
  checked?: boolean
  radio?: boolean
}
interface Sub {
  kind: 'sub'
  label: string
  entries: Entry[]
  disabled?: boolean
}
type Entry = Item | Sub | { kind: 'sep' } | { kind: 'head'; label: string }

interface MenuDef {
  id: string
  label: string
  /** Alt+key opens it */
  key: string
  entries: Entry[]
}

const sep: Entry = { kind: 'sep' }
const head = (label: string): Entry => ({ kind: 'head', label })
const item = (label: string, run: () => void, o: Partial<Omit<Item, 'kind' | 'label' | 'run'>> = {}): Item => ({ kind: 'item', label, run, ...o })
const sub = (label: string, entries: Entry[], disabled?: boolean): Sub => ({ kind: 'sub', label, entries, disabled: disabled || !entries.some((e) => (e.kind === 'item' || e.kind === 'sub') && !e.disabled) })

const BROWSER_TABS: [BrowserTab, string][] = [
  ['media', 'Media'],
  ['transcript', 'Transcript'],
  ['suggestions', 'Suggestions'],
  ['library', 'Library'],
  ['bible', 'Bible']
]
const INSPECTOR_TABS: [InspectorTab, string][] = [
  ['reel', 'Reel'],
  ['clip', 'Clip'],
  ['caption', 'Caption'],
  ['verse', 'Verse'],
  ['cutaway', 'Cutaway'],
  ['audio', 'Audio'],
  ['thumbnail', 'Thumbnail']
]
const SETTINGS_TABS: [SettingsTab, string][] = [
  ['general', 'General…'],
  ['pictures', 'AI pictures…'],
  ['folders', 'Folders…'],
  ['export', 'Export presets…'],
  ['models', 'Models…'],
  ['engine', 'Engine…']
]

function isTextField(el: Element | null): boolean {
  if (!el) return false
  const h = el as HTMLElement
  if (h.isContentEditable) return true
  if (el.tagName === 'TEXTAREA') return !(el as HTMLTextAreaElement).readOnly
  if (el.tagName !== 'INPUT') return false
  const t = (el as HTMLInputElement).type
  return ['text', 'search', 'url', 'email', 'number', 'tel', 'password', ''].includes(t) && !(el as HTMLInputElement).readOnly
}

function useMenus(textFocus: boolean): MenuDef[] {
  const app = useApp()
  const set = app.set
  const projects = useEditor((s) => s.projects)
  const project = useEditor((s) => s.project)
  const past = useEditor((s) => s.past)
  const future = useEditor((s) => s.future)
  const selection = useEditor((s) => s.selection)
  const reel = useReel()
  const viewer = usePlayback((s) => s.viewer)
  const safeZone = usePlayback((s) => s.safeZone)
  const showOverlays = usePlayback((s) => s.showOverlays)
  const rendered = usePlayback((s) => s.rendered)
  const playing = usePlayback((s) => s.playing)
  const ranges = useTranscriptSel((s) => s.ranges)
  const markIn = useTranscriptSel((s) => s.markIn)
  const pb = usePlayback.getState
  const manual = app.mode === 'manual'
  const noProject = !project
  const noReel = !reel
  const hasLines = Boolean(project?.transcript.length)
  const undoLabel = past[past.length - 1]?.label
  const redoLabel = future[future.length - 1]?.label
  const reels = project?.reels.length ?? 0
  const winEdit = (c: WinEditCmd) => (): void => void window.viku?.win.edit(c)
  const panel = (patch: Parameters<typeof set>[0]) => (): void => set({ mode: 'manual', ...patch })

  const file: Entry[] = [
    sub('New', [
      item('Project from sermon video…', cmd.importSermon, { kbd: 'Ctrl+N' }),
      item('Reel from transcript selection', () => void cmd.newReelFromSelection(), { disabled: noProject || !hasLines })
    ]),
    item('Open Project…', cmd.showProjects, { kbd: 'Ctrl+O' }),
    sub(
      'Open Recent',
      projects.slice(0, 10).map((p) => item(p.name, () => cmd.openProject(p.id), { radio: true, checked: project?.id === p.id }))
    ),
    sep,
    item('Close Project', () => void cmd.closeProject(), { kbd: 'Ctrl+Shift+W', disabled: noProject }),
    sep,
    item('Save', cmd.save, { kbd: 'Ctrl+S', disabled: noProject }),
    sep,
    sub('Import', [item('Sermon video…', cmd.importSermon), item('Illustrations…', () => void cmd.importIllustrations())]),
    sub('Export', [
      item('Reel…', cmd.export, { kbd: 'Ctrl+E', disabled: noReel && manual }),
      item('Render this reel', cmd.render, { disabled: noReel }),
      item(`Render all reels${reels ? ` (${reels})` : ''}`, cmd.renderAll, { disabled: !reels }),
      item('Thumbnail', () => void cmd.renderThumbnail(), { disabled: noReel })
    ]),
    sep,
    item('Show Sermon Video in Explorer', cmd.revealVideo, { disabled: !project?.video_path }),
    sub('Open Folder', [
      item('Exports', () => cmd.openFolder('exports_dir')),
      item('Projects', () => cmd.openFolder('projects_dir')),
      item('Library', () => cmd.openFolder('library_dir')),
      item('Music', () => cmd.openFolder('music_dir'))
    ]),
    sep,
    item('Exit', cmd.exit, { kbd: 'Ctrl+Q' })
  ]

  const edit: Entry[] = [
    item(undoLabel ? `Undo ${undoLabel}` : 'Undo', cmd.undo, { kbd: 'Ctrl+Z', disabled: !past.length }),
    item(redoLabel ? `Redo ${redoLabel}` : 'Redo', cmd.redo, { kbd: 'Ctrl+Shift+Z', disabled: !future.length }),
    sep,
    item('Cut', winEdit('cut'), { kbd: 'Ctrl+X', disabled: !textFocus }),
    item('Copy', winEdit('copy'), { kbd: 'Ctrl+C', disabled: !textFocus }),
    item('Paste', winEdit('paste'), { kbd: 'Ctrl+V', disabled: !textFocus }),
    item('Select All', winEdit('selectAll'), { kbd: 'Ctrl+A', disabled: !textFocus }),
    sep,
    item(selection?.kind === 'segment' ? 'Ripple Delete' : 'Clear', cmd.deleteSelection, { kbd: 'Delete', disabled: noReel || !selection }),
    item('Deselect All', cmd.deselect, { kbd: 'Ctrl+Shift+A', disabled: !selection && markIn === null }),
    sep,
    item('Keyboard Shortcuts…', cmd.shortcuts, { kbd: '?' }),
    sub(
      'Preferences',
      SETTINGS_TABS.map(([id, label]) => item(label, () => cmd.settings(id), { kbd: id === 'general' ? 'Ctrl+,' : undefined }))
    )
  ]

  const clip: Entry[] = [
    item('Select Clip at Playhead', cmd.selectClipAtPlayhead, { disabled: noReel || !reel?.segments.length }),
    item('Clip Properties…', () => {
      if (selection?.kind !== 'segment') cmd.selectClipAtPlayhead()
      set({ inspectorTab: 'clip' })
    }, { disabled: noReel || !reel?.segments.length }),
    sep,
    item('Add Edit (Blade at Playhead)', cmd.blade, { kbd: 'Ctrl+B', disabled: noReel }),
    item('Ripple Delete Clip', cmd.deleteSelection, { kbd: 'Delete', disabled: noReel || selection?.kind !== 'segment' }),
    sep,
    sub(
      'Auto Framing',
      [
        item('Follow speaker', () => cmd.setFraming('follow'), { radio: true, checked: reel?.framing === 'follow' }),
        item('Fixed crop', () => cmd.setFraming('fixed'), { radio: true, checked: reel?.framing === 'fixed' }),
        sep,
        item('Track Speaker Again', cmd.trackSpeaker)
      ],
      noReel
    )
  ]

  const sequence: Entry[] = [
    item('New Reel from Transcript Selection', () => void cmd.newReelFromSelection(), { disabled: noProject || !hasLines }),
    item('Find Clips with Viku Brain', () => void cmd.findClips(), { disabled: !hasLines }),
    sep,
    item('Auto-build Captions, Verses, Cutaways & Music', cmd.autobuild, { disabled: noReel }),
    item('New AI Pictures for Every Cutaway', cmd.aiPictures, { disabled: noReel || !reel?.cutaways.length }),
    sep,
    item('Render Reel', cmd.render, { disabled: noReel }),
    item('Render All Reels', cmd.renderAll, { disabled: !reels }),
    item('Render Thumbnail', () => void cmd.renderThumbnail(), { disabled: noReel }),
    sep,
    item('Zoom In', cmd.zoomIn, { kbd: '=' }),
    item('Zoom Out', cmd.zoomOut, { kbd: '-' }),
    item('Zoom to Fit', cmd.zoomFit, { kbd: 'Shift+Z', disabled: noReel || !manual }),
    sep,
    item('Snap in Timeline', () => set({ snapping: !app.snapping }), { kbd: 'N', checked: app.snapping }),
    item('Skimming', () => set({ skimming: !app.skimming }), { kbd: 'S', checked: app.skimming }),
    sub('Tools', [
      item('Selection', () => set({ tool: 'select' }), { kbd: 'A', radio: true, checked: app.tool === 'select' }),
      item('Blade', () => set({ tool: 'blade' }), { kbd: 'B', radio: true, checked: app.tool === 'blade' }),
      item('Trim', () => set({ tool: 'trim' }), { kbd: 'T', radio: true, checked: app.tool === 'trim' })
    ])
  ]

  const markers: Entry[] = [
    item('Mark In', cmd.markIn, { kbd: 'I', disabled: !hasLines }),
    item('Mark Out', () => cmd.markOut(false), { kbd: 'O', disabled: !hasLines }),
    item('Mark Out and Add to Selection', () => cmd.markOut(true), { kbd: 'Shift+O', disabled: !hasLines || !ranges.length }),
    sep,
    item('Go to In', cmd.goToIn, { disabled: !ranges.length && markIn === null }),
    item('Go to Out', cmd.goToOut, { disabled: !ranges.length }),
    item('Play In to Out', cmd.previewSelection, { disabled: !ranges.length }),
    sep,
    item('Clear In and Out', cmd.clearInOut, { disabled: !ranges.length && markIn === null }),
    sep,
    item('New Reel from In to Out', () => void cmd.newReelFromSelection(), { disabled: !ranges.length })
  ]

  const graphics: Entry[] = [
    item('Add Caption at Playhead', cmd.addCaption, { disabled: noReel }),
    item('Check All Captions', () => void cmd.checkCaptions(), { disabled: noReel || !reel?.captions.length }),
    sep,
    item('Insert Bible Verse…', panel({ browserTab: 'bible' }), { disabled: noReel }),
    sep,
    item('Add Empty Cutaway at Playhead', cmd.addCutaway, { disabled: noReel }),
    item('Add Illustration from Library…', panel({ browserTab: 'library', libraryTab: 'illustrations' }), { disabled: noReel }),
    item('Generate Pictures with AI Studio…', () => set({ aiOpen: true, activityOpen: false })),
    sep,
    item('Reel Title & Subtitle…', () => set({ inspectorTab: 'reel' }), { disabled: noReel }),
    item('Thumbnail…', () => set({ inspectorTab: 'thumbnail' }), { disabled: noReel })
  ]

  const view: Entry[] = [
    item('Reel 9:16', () => pb().set({ viewer: 'reel', playing: false }), { kbd: '1', radio: true, checked: viewer === 'reel' }),
    item('Source 16:9', () => pb().set({ viewer: 'source', playing: false }), { kbd: '2', radio: true, checked: viewer === 'source' }),
    item('Rendered Video', () => pb().set({ viewer: 'rendered', playing: false }), { radio: true, checked: viewer === 'rendered', disabled: !rendered }),
    sep,
    item('Show Titles, Captions & Verses', () => pb().set({ showOverlays: !showOverlays }), { checked: showOverlays }),
    item('Show Safe Zones', () => pb().set({ safeZone: !safeZone }), { kbd: 'Shift+S', checked: safeZone }),
    sep,
    sub('Playback', [
      item(playing ? 'Pause' : 'Play', cmd.togglePlay, { kbd: 'Space' }),
      sep,
      item('Back One Frame', () => cmd.seekBy(-1 / FPS), { kbd: 'Left' }),
      item('Forward One Frame', () => cmd.seekBy(1 / FPS), { kbd: 'Right' }),
      item('Back One Second', () => cmd.seekBy(-1), { kbd: 'Shift+Left' }),
      item('Forward One Second', () => cmd.seekBy(1), { kbd: 'Shift+Right' })
    ]),
    sub('Go To', [
      item('Start', cmd.goStart, { kbd: 'Home' }),
      item('End', cmd.goEnd, { kbd: 'End' }),
      item('Previous Edit', () => cmd.edit(-1), { kbd: 'Up', disabled: noReel || viewer !== 'reel' }),
      item('Next Edit', () => cmd.edit(1), { kbd: 'Down', disabled: noReel || viewer !== 'reel' })
    ])
  ]

  const win: Entry[] = [
    sub('Workspaces', [
      item('Automate', () => set({ mode: 'automate' }), { radio: true, checked: !manual }),
      item('Manual', () => set({ mode: 'manual' }), { radio: true, checked: manual }),
      sep,
      item('Reset Panel Sizes', cmd.resetLayout)
    ]),
    sep,
    ...BROWSER_TABS.map(([id, label]) => item(label, panel({ browserTab: id }), { radio: true, checked: manual && app.browserTab === id })),
    sub(
      'Inspector',
      INSPECTOR_TABS.map(([id, label]) => item(label, panel({ inspectorTab: id }), { radio: true, checked: app.inspectorTab === id })),
      noReel
    ),
    sep,
    item('Activity', () => set({ activityOpen: !app.activityOpen, aiOpen: false }), { checked: app.activityOpen }),
    item('AI Pictures', () => set({ aiOpen: !app.aiOpen, activityOpen: false }), { checked: app.aiOpen }),
    sep,
    item('Full Screen', cmd.fullScreen, { kbd: 'F11' })
  ]

  const help: Entry[] = [
    item('Keyboard Shortcuts', cmd.shortcuts, { kbd: '?' }),
    item('Setup Guide…', () => set({ onboardingOpen: true })),
    sep,
    head('Connections'),
    item('AI Pictures (Google AI Studio)…', () => set({ aiOpen: true, activityOpen: false })),
    item('HeyGen Music Sign-in…', () => void window.viku?.signin.open('heygen')),
    item('Download Bibles (eBible)…', () => void window.viku?.signin.open('ebible')),
    sep,
    item('About Viku', () => set({ aboutOpen: true }))
  ]

  return [
    { id: 'file', label: 'File', key: 'f', entries: file },
    { id: 'edit', label: 'Edit', key: 'e', entries: edit },
    { id: 'clip', label: 'Clip', key: 'c', entries: clip },
    { id: 'sequence', label: 'Sequence', key: 's', entries: sequence },
    { id: 'markers', label: 'Markers', key: 'm', entries: markers },
    { id: 'graphics', label: 'Graphics and Titles', key: 'g', entries: graphics },
    { id: 'view', label: 'View', key: 'v', entries: view },
    { id: 'window', label: 'Window', key: 'w', entries: win },
    { id: 'help', label: 'Help', key: 'h', entries: help }
  ]
}

const live = (e: Entry): boolean => (e.kind === 'item' || e.kind === 'sub') && !e.disabled
function liveIdx(entries: Entry[]): number[] {
  return entries.flatMap((e, i) => (live(e) ? [i] : []))
}
function step(entries: Entry[], cur: number | null, d: 1 | -1): number | null {
  const idx = liveIdx(entries)
  if (!idx.length) return null
  const pos = cur === null ? (d > 0 ? -1 : 0) : idx.indexOf(cur)
  return idx[(pos + d + idx.length) % idx.length]
}

function Row({ e, active, onEnter, onClick, refFn, subOpen }: { e: Item | Sub; active: boolean; onEnter: () => void; onClick: () => void; refFn: (el: HTMLButtonElement | null) => void; subOpen?: boolean }) {
  const isItem = e.kind === 'item'
  const role = !isItem || e.checked === undefined ? 'menuitem' : e.radio ? 'menuitemradio' : 'menuitemcheckbox'
  return (
    <button
      type="button"
      tabIndex={-1}
      ref={refFn}
      role={role}
      aria-checked={isItem && e.checked !== undefined ? e.checked : undefined}
      aria-disabled={e.disabled || undefined}
      aria-haspopup={isItem ? undefined : 'menu'}
      aria-expanded={isItem ? undefined : Boolean(subOpen)}
      className={`mb-item${active ? ' active' : ''}${e.disabled ? ' disabled' : ''}`}
      onPointerEnter={onEnter}
      onClick={onClick}
    >
      <span className="mb-check" aria-hidden>
        {isItem && e.checked && (e.radio ? <span className="mb-dot" /> : <Check size={13} strokeWidth={2.4} />)}
      </span>
      <span className="mb-label">{e.label}</span>
      {isItem && e.kbd && <span className="mb-kbd">{e.kbd}</span>}
      {!isItem && <ChevronRight size={13} className="mb-arrow" aria-hidden />}
    </button>
  )
}

export function MenuBar() {
  const [textFocus, setTextFocus] = useState(false)
  const menus = useMenus(textFocus)
  const [open, setOpen] = useState<number | null>(null)
  const [active, setActive] = useState<number | null>(null)
  const [subOpen, setSubOpen] = useState<number | null>(null)
  const [subActive, setSubActive] = useState<number | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const topRefs = useRef<(HTMLButtonElement | null)[]>([])
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const subRefs = useRef<(HTMLButtonElement | null)[]>([])
  /** what had the focus before the menu opened: given back on close, and the target of Cut / Copy / Paste */
  const lastFocus = useRef<HTMLElement | null>(null)

  const close = (refocusTop = false): void => {
    const was = open
    setOpen(null)
    setActive(null)
    setSubOpen(null)
    setSubActive(null)
    if (refocusTop && was !== null) topRefs.current[was]?.focus()
    else {
      const el = lastFocus.current
      if (el && el.isConnected && el !== document.body) el.focus({ preventScroll: true })
      else (document.activeElement as HTMLElement | null)?.blur?.()
    }
  }
  const openMenu = (i: number, focusFirst: boolean): void => {
    if (open === null) {
      const el = document.activeElement as HTMLElement | null
      const inBar = Boolean(el && barRef.current?.contains(el))
      lastFocus.current = inBar ? lastFocus.current : el
      setTextFocus(isTextField(inBar ? lastFocus.current : el))
    }
    setOpen(i)
    setSubOpen(null)
    setSubActive(null)
    setActive(focusFirst ? step(menus[i].entries, null, 1) : null)
  }
  const openSub = (j: number, focusFirst: boolean): void => {
    const e = open === null ? undefined : menus[open].entries[j]
    if (!e || e.kind !== 'sub' || e.disabled) return
    setActive(j)
    setSubOpen(j)
    setSubActive(focusFirst ? step(e.entries, null, 1) : null)
  }

  // Alt+<letter> opens a menu from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const i = menus.findIndex((m) => m.key === e.key.toLowerCase())
      if (i < 0) return
      e.preventDefault()
      openMenu(i, true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // while a menu is open it owns the keyboard, wherever the focus is (a mouse-opened menu leaves it in place)
  useEffect(() => {
    if (open === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && menus.some((m) => m.key === e.key.toLowerCase())) return // Alt+letter switches menus
      onMenuKey(e)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // a click anywhere else, or the window losing focus, closes it
  useEffect(() => {
    if (open === null) return
    const onDown = (e: PointerEvent): void => {
      if (!barRef.current?.contains(e.target as Node)) close()
    }
    const onBlur = (): void => close()
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('blur', onBlur)
    }
  })

  useEffect(() => {
    if (open === null) return
    if (subOpen !== null && subActive !== null) subRefs.current[subActive]?.focus()
    else if (active !== null) itemRefs.current[active]?.focus()
  }, [open, active, subOpen, subActive])

  const run = (e: Entry): void => {
    if (e.kind !== 'item' || e.disabled) return
    close()
    // after the menu is gone and the focus is back where it was (Cut / Copy / Paste act on it)
    setTimeout(e.run, 0)
  }

  const onMenuKey = (ev: KeyboardEvent): void => {
    if (open === null) return
    const entries = menus[open].entries
    const k = ev.key
    const subEntry = subOpen !== null ? entries[subOpen] : undefined
    const inSub = subEntry?.kind === 'sub' && subActive !== null
    if (k === 'Escape') {
      if (subOpen !== null) {
        setSubOpen(null)
        setSubActive(null)
      } else close(true)
    } else if (inSub && subEntry?.kind === 'sub') {
      if (k === 'ArrowDown') setSubActive(step(subEntry.entries, subActive, 1))
      else if (k === 'ArrowUp') setSubActive(step(subEntry.entries, subActive, -1))
      else if (k === 'ArrowLeft') {
        setSubOpen(null)
        setSubActive(null)
      } else if (k === 'ArrowRight') openMenu((open + 1) % menus.length, true)
      else if ((k === 'Enter' || k === ' ') && subActive !== null) run(subEntry.entries[subActive])
      else if (k === 'Tab') close()
      else return
    } else {
      const cur = active !== null ? entries[active] : undefined
      if (k === 'ArrowDown') {
        setSubOpen(null)
        setActive(step(entries, active, 1))
      } else if (k === 'ArrowUp') {
        setSubOpen(null)
        setActive(step(entries, active, -1))
      } else if (k === 'Home') setActive(step(entries, null, 1))
      else if (k === 'End') setActive(step(entries, null, -1))
      else if (k === 'ArrowRight') {
        if (cur?.kind === 'sub' && !cur.disabled && active !== null) openSub(active, true)
        else openMenu((open + 1) % menus.length, true)
      } else if (k === 'ArrowLeft') openMenu((open - 1 + menus.length) % menus.length, true)
      else if (k === 'Enter' || k === ' ') {
        if (cur?.kind === 'sub' && active !== null) openSub(active, true)
        else if (cur) run(cur)
      } else if (k === 'Tab') close()
      else return
    }
    ev.preventDefault()
    ev.stopPropagation()
  }

  return (
    <div className="menubar" role="menubar" aria-label="Main menu" ref={barRef}>
      {menus.map((m, i) => (
        <div key={m.id} className="mb-menu">
          <button
            type="button"
            ref={(el) => void (topRefs.current[i] = el)}
            className={`mb-top${open === i ? ' open' : ''}`}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === i}
            aria-keyshortcuts={`Alt+${m.key.toUpperCase()}`}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.preventDefault() // keep the focus where it is (a text field Cut / Copy / Paste should act on)
              if (open === i) close()
              else openMenu(i, false)
            }}
            onPointerEnter={() => open !== null && open !== i && openMenu(i, false)}
            onKeyDown={(e) => {
              if (open === null && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault()
                e.stopPropagation()
                openMenu(i, true)
              }
            }}
          >
            {m.label}
          </button>
          {open === i && (
            <div className="mb-pop" role="menu" aria-label={m.label}>
              {m.entries.map((e, j) => {
                if (e.kind === 'sep') return <div key={j} className="mb-sep" role="separator" />
                if (e.kind === 'head') return <div key={j} className="mb-head" role="presentation">{e.label}</div>
                return (
                  <div key={j} className="mb-row">
                    <Row
                      e={e}
                      active={active === j}
                      subOpen={subOpen === j}
                      refFn={(el) => void (itemRefs.current[j] = el)}
                      onEnter={() => {
                        if (e.kind === 'sub') {
                          if (!e.disabled) openSub(j, false)
                          else {
                            setActive(null)
                            setSubOpen(null)
                          }
                        } else {
                          setActive(e.disabled ? null : j)
                          setSubOpen(null)
                          setSubActive(null)
                        }
                      }}
                      onClick={() => (e.kind === 'sub' ? openSub(j, true) : run(e))}
                    />
                    {e.kind === 'sub' && subOpen === j && (
                      <div className="mb-pop mb-subpop" role="menu" aria-label={e.label}>
                        {e.entries.map((s, x) => {
                          if (s.kind === 'sep') return <div key={x} className="mb-sep" role="separator" />
                          if (s.kind === 'head') return <div key={x} className="mb-head" role="presentation">{s.label}</div>
                          if (s.kind === 'sub') return null // one level deep is all Viku needs
                          return (
                            <Row
                              key={x}
                              e={s}
                              active={subActive === x}
                              refFn={(el) => void (subRefs.current[x] = el)}
                              onEnter={() => setSubActive(s.disabled ? null : x)}
                              onClick={() => run(s)}
                            />
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
