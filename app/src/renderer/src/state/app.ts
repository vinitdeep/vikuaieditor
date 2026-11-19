import { create } from 'zustand'
import type { EngineStatus, GeminiViewState } from '@shared/ipc'
import type { AuthStatus, Health, Settings } from '@/api/types'

export type Mode = 'automate' | 'manual'
export type BrowserTab = 'media' | 'transcript' | 'suggestions' | 'library' | 'bible'
export type LibraryTab = 'illustrations' | 'music' | 'sfx'
export type InspectorTab = 'reel' | 'clip' | 'caption' | 'verse' | 'cutaway' | 'audio' | 'thumbnail'
export type Tool = 'select' | 'blade' | 'trim'
export type SettingsTab = 'general' | 'pictures' | 'folders' | 'export' | 'models' | 'engine'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'warn' | 'error'
  text: string
  action?: { label: string; run: () => void }
}

interface Layout {
  left: number
  right: number
  bottom: number
}

const LAYOUT_KEY = 'viku.layout.v1'
export const DEFAULT_LAYOUT: Layout = { left: 340, right: 330, bottom: 330 }

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<Layout>
      return { left: p.left ?? DEFAULT_LAYOUT.left, right: p.right ?? DEFAULT_LAYOUT.right, bottom: p.bottom ?? DEFAULT_LAYOUT.bottom }
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_LAYOUT }
}

interface AppState {
  mode: Mode
  apiKind: 'live' | 'mock'
  /** the data source the user asked for (prefs.adapter, or ?adapter= in tests) */
  adapterPref: 'auto' | 'live' | 'mock'
  engine: EngineStatus | null
  health: Health | null
  auth: AuthStatus | null
  gemini: GeminiViewState | null
  settings: Settings | null
  browserTab: BrowserTab
  libraryTab: LibraryTab
  inspectorTab: InspectorTab
  activityOpen: boolean
  /** the AI pictures drawer (AI Studio queue + extension status) */
  aiOpen: boolean
  settingsOpen: boolean
  /** the tab Settings opens on (the menu bar's Preferences items set it) */
  settingsTab: SettingsTab
  exportOpen: boolean
  shortcutsOpen: boolean
  onboardingOpen: boolean
  aboutOpen: boolean
  tool: Tool
  snapping: boolean
  skimming: boolean
  /** timeline zoom, px per second */
  zoom: number
  layout: Layout
  toasts: Toast[]

  set: (patch: Partial<AppState>) => void
  setLayout: (patch: Partial<Layout>) => void
  toast: (kind: Toast['kind'], text: string, action?: Toast['action']) => void
  dismiss: (id: number) => void
}

let toastSeq = 1

export const useApp = create<AppState>((set, get) => ({
  mode: 'manual',
  apiKind: 'mock',
  adapterPref: 'auto',
  engine: null,
  health: null,
  auth: null,
  gemini: null,
  settings: null,
  browserTab: 'transcript',
  libraryTab: 'illustrations',
  inspectorTab: 'reel',
  activityOpen: false,
  aiOpen: false,
  settingsOpen: false,
  settingsTab: 'general',
  exportOpen: false,
  shortcutsOpen: false,
  onboardingOpen: false,
  aboutOpen: false,
  tool: 'select',
  snapping: true,
  skimming: false,
  zoom: 22,
  layout: loadLayout(),
  toasts: [],

  set: (patch) => set(patch),
  setLayout: (patch) => {
    const layout = { ...get().layout, ...patch }
    set({ layout })
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
    } catch {
      /* ignore */
    }
  },
  toast: (kind, text, action) => {
    const id = toastSeq++
    set({ toasts: [...get().toasts.slice(-3), { id, kind, text, action }] })
    setTimeout(() => get().dismiss(id), kind === 'error' ? 8000 : action ? 9000 : 4200)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) })
}))

export const toast = (kind: Toast['kind'], text: string, action?: Toast['action']): void => useApp.getState().toast(kind, text, action)
