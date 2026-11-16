import { create } from 'zustand'

export type ViewerMode = 'reel' | 'source'

interface PlaybackState {
  /** reel time (s) */
  t: number
  /** source viewer time (s) */
  srcT: number
  /** skim position in reel time, when skimming */
  skim: number | null
  playing: boolean
  /** J/K/L shuttle rate: negative = reverse */
  rate: number
  viewer: ViewerMode
  safeZone: boolean
  showOverlays: boolean
  /** source-viewer preview of a range list (suggestion preview) */
  preview: [number, number][] | null
  set: (p: Partial<PlaybackState>) => void
  seek: (t: number) => void
  seekSource: (t: number) => void
  toggle: () => void
}

export const usePlayback = create<PlaybackState>((set, get) => ({
  t: 0,
  srcT: 0,
  skim: null,
  playing: false,
  rate: 1,
  viewer: 'reel',
  safeZone: false,
  showOverlays: true,
  preview: null,
  set: (p) => set(p),
  seek: (t) => set({ t: Math.max(0, t) }),
  seekSource: (t) => set({ srcT: Math.max(0, t) }),
  toggle: () => {
    const { playing } = get()
    set({ playing: !playing, rate: 1 })
  }
}))
