import { create } from 'zustand'

/** One shared preview player for music / SFX lists. */
const el = typeof Audio !== 'undefined' ? new Audio() : null

interface PreviewState {
  playing: string | null
  play: (key: string, url: string) => void
  stop: () => void
}

export const usePreview = create<PreviewState>((set, get) => ({
  playing: null,
  play: (key, url) => {
    if (!el) return
    if (get().playing === key) {
      get().stop()
      return
    }
    el.src = url
    el.currentTime = 0
    void el.play().catch(() => set({ playing: null }))
    set({ playing: key })
  },
  stop: () => {
    el?.pause()
    set({ playing: null })
  }
}))

el?.addEventListener('ended', () => usePreview.setState({ playing: null }))
el?.addEventListener('error', () => usePreview.setState({ playing: null }))
