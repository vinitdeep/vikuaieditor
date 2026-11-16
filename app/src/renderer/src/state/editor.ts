import { create } from 'zustand'
import { produce, type Draft } from 'immer'
import { api } from '@/api'
import type { Candidate, Project, ProjectSummary, Reel, Seg } from '@/api/types'
import { toast, useApp } from './app'
import { usePlayback } from './playback'

export type Selection =
  | { kind: 'segment'; index: number }
  | { kind: 'caption'; index: number }
  | { kind: 'verse'; index: number }
  | { kind: 'cutaway'; index: number }
  | { kind: 'sfx'; index: number }
  | { kind: 'music' }
  | { kind: 'voice' }

interface HistoryEntry {
  reelId: string
  reel: Reel
  label: string
}

interface EditorState {
  projects: ProjectSummary[]
  projectsLoading: boolean
  project: Project | null
  reelId: string | null
  selection: Selection | null
  candidates: Candidate[]
  rejected: string[]
  kept: string[]
  past: HistoryEntry[]
  future: HistoryEntry[]
  lastLabel: string
  dirty: boolean
  savedAt: number | null

  loadProjects: () => Promise<void>
  openProject: (id: string, reelId?: string | null) => Promise<void>
  openReel: (id: string | null) => void
  select: (s: Selection | null) => void
  /** apply an undoable change to the current reel; `coalesce` merges rapid edits (slider drags) */
  edit: (label: string, fn: (r: Draft<Reel>) => void, coalesce?: string) => void
  undo: () => void
  redo: () => void
  createReel: (segments: Seg[], title: string, sub: string) => Promise<Reel | null>
  replaceReel: (r: Reel) => void
  refresh: () => Promise<void>
  setCandidates: (c: Candidate[]) => void
  markCandidate: (id: string, kind: 'keep' | 'reject') => void
}

let lastCoalesce: { key: string; at: number } | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const p = useEditor.getState().project
    if (!p) return
    api()
      .saveProject(p)
      .then(() => useEditor.setState({ dirty: false, savedAt: Date.now() }))
      .catch((e: unknown) => toast('error', `Could not save project: ${e instanceof Error ? e.message : String(e)}`))
  }, 900)
}

export const useEditor = create<EditorState>((set, get) => ({
  projects: [],
  projectsLoading: false,
  project: null,
  reelId: null,
  selection: null,
  candidates: [],
  rejected: [],
  kept: [],
  past: [],
  future: [],
  lastLabel: '',
  dirty: false,
  savedAt: null,

  loadProjects: async () => {
    set({ projectsLoading: true })
    try {
      set({ projects: await api().listProjects() })
    } catch (e) {
      toast('error', `Could not list projects: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      set({ projectsLoading: false })
    }
  },

  openProject: async (id, reelId) => {
    try {
      const project = await api().getProject(id)
      const candidates = await api().candidates(id)
      const first = reelId === undefined ? (project.reels[0]?.id ?? null) : reelId
      set({ project, reelId: first, selection: null, past: [], future: [], candidates, rejected: [], kept: [] })
      usePlayback.setState({ t: 0, srcT: project.transcript[0]?.start ?? 0, playing: false, preview: null })
    } catch (e) {
      toast('error', `Could not open project: ${e instanceof Error ? e.message : String(e)}`)
    }
  },

  openReel: (id) => {
    set({ reelId: id, selection: null })
    usePlayback.setState({ t: 0, playing: false, viewer: 'reel' })
    useApp.getState().set({ inspectorTab: 'reel' })
  },

  select: (s) => {
    set({ selection: s })
    if (!s) return
    const tab = s.kind === 'segment' ? 'clip' : s.kind === 'sfx' || s.kind === 'music' || s.kind === 'voice' ? 'audio' : s.kind
    useApp.getState().set({ inspectorTab: tab })
  },

  edit: (label, fn, coalesce) => {
    const { project, reelId } = get()
    if (!project || !reelId) return
    const idx = project.reels.findIndex((r) => r.id === reelId)
    if (idx < 0) return
    const before = project.reels[idx]
    const after = produce(before, fn)
    if (after === before) return
    const now = Date.now()
    const merge = coalesce !== undefined && lastCoalesce?.key === coalesce && (coalesce.startsWith('drag:') || now - lastCoalesce.at < 800)
    lastCoalesce = coalesce !== undefined ? { key: coalesce, at: now } : null
    const reels = project.reels.slice()
    reels[idx] = after
    set({
      project: { ...project, reels },
      past: merge ? get().past : [...get().past.slice(-199), { reelId, reel: before, label }],
      future: [],
      lastLabel: label,
      dirty: true
    })
    scheduleSave()
  },

  undo: () => {
    const { past, project } = get()
    const entry = past[past.length - 1]
    if (!entry || !project) return
    const idx = project.reels.findIndex((r) => r.id === entry.reelId)
    if (idx < 0) return
    const reels = project.reels.slice()
    const current = reels[idx]
    reels[idx] = entry.reel
    lastCoalesce = null
    set({
      project: { ...project, reels },
      reelId: entry.reelId,
      past: past.slice(0, -1),
      future: [...get().future, { reelId: entry.reelId, reel: current, label: entry.label }],
      dirty: true
    })
    toast('info', `Undo ${entry.label}`)
    scheduleSave()
  },

  redo: () => {
    const { future, project } = get()
    const entry = future[future.length - 1]
    if (!entry || !project) return
    const idx = project.reels.findIndex((r) => r.id === entry.reelId)
    if (idx < 0) return
    const reels = project.reels.slice()
    const current = reels[idx]
    reels[idx] = entry.reel
    lastCoalesce = null
    set({
      project: { ...project, reels },
      reelId: entry.reelId,
      future: future.slice(0, -1),
      past: [...get().past, { reelId: entry.reelId, reel: current, label: entry.label }],
      dirty: true
    })
    toast('info', `Redo ${entry.label}`)
    scheduleSave()
  },

  createReel: async (segments, title, sub) => {
    const { project } = get()
    if (!project) return null
    try {
      const reel = await api().createReel(project.id, { segments, title, sub })
      const p = get().project
      if (p && p.id === project.id) set({ project: { ...p, reels: [...p.reels.filter((r) => r.id !== reel.id), reel] } })
      get().openReel(reel.id)
      return reel
    } catch (e) {
      toast('error', `Could not create reel: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  },

  replaceReel: (r) => {
    const p = get().project
    if (!p) return
    const reels = p.reels.some((x) => x.id === r.id) ? p.reels.map((x) => (x.id === r.id ? r : x)) : [...p.reels, r]
    set({ project: { ...p, reels } })
  },

  refresh: async () => {
    const p = get().project
    if (!p) return
    try {
      const fresh = await api().getProject(p.id)
      set({ project: fresh })
    } catch {
      /* keep local */
    }
  },

  setCandidates: (c) => set({ candidates: c }),
  markCandidate: (id, kind) => {
    const { rejected, kept } = get()
    if (kind === 'reject') set({ rejected: rejected.includes(id) ? rejected : [...rejected, id] })
    else set({ kept: kept.includes(id) ? kept : [...kept, id] })
  }
}))

export function useReel(): Reel | null {
  return useEditor((s) => s.project?.reels.find((r) => r.id === s.reelId) ?? null)
}

export function currentReel(): Reel | null {
  const s = useEditor.getState()
  return s.project?.reels.find((r) => r.id === s.reelId) ?? null
}
