import { create } from 'zustand'
import { api } from '@/api'
import type { Cutaway, LibraryImage } from '@/api/types'

/** "01-pristine-earth.png" → "pristine earth" */
export function readableName(s: string): string {
  const stem = (s.split(/[\\/]/).pop() ?? s).replace(/\.[a-z0-9]{2,4}$/i, '')
  return stem
    .replace(/^\d+[-_ .]*/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const HASHY = /^[0-9a-f]{10,}$/i

interface LibIndex {
  byPath: Record<string, LibraryImage>
  byId: Record<string, LibraryImage>
  loaded: boolean
  loading: boolean
  load: (force?: boolean) => Promise<void>
}

/** Path / id → library item, so timeline clips can show "fallen angel" instead of "90c75617c2f168d0.png". */
export const useLibraryIndex = create<LibIndex>((set, get) => ({
  byPath: {},
  byId: {},
  loaded: false,
  loading: false,
  load: async (force) => {
    if (get().loading || (get().loaded && !force)) return
    set({ loading: true })
    try {
      const items = await api().librarySearch('', 5000)
      const byPath: Record<string, LibraryImage> = {}
      const byId: Record<string, LibraryImage> = {}
      for (const it of items) {
        byPath[it.path.toLowerCase()] = it
        if (it.id) byId[it.id] = it
      }
      set({ byPath, byId, loaded: true })
    } catch {
      set({ loaded: true })
    } finally {
      set({ loading: false })
    }
  }
}))

export function isEmptyCutaway(c: Cutaway): boolean {
  return !c.img
}

/** Short readable name for a cutaway clip. */
export function cutawayName(c: Cutaway, idx?: LibIndex): string {
  if (!c.img) {
    const slug = c.need ? readableName(c.need.slug) : ''
    if (slug && slug !== 'scene') return slug
    if (c.need?.tags?.length) return c.need.tags.slice(0, 2).join(' ')
    return ''
  }
  const ix = idx ?? useLibraryIndex.getState()
  const lib = (c.lib_id ? ix.byId[c.lib_id] : undefined) ?? ix.byPath[c.img.toLowerCase()]
  if (lib) {
    const n = readableName(lib.name)
    if (n && !HASHY.test(n)) return n
  }
  const why = c.why
  if (Array.isArray(why) && why.length) return why.slice(0, 2).join(' ')
  if (why && !Array.isArray(why) && typeof why.desc === 'string' && why.desc) return why.desc
  const n = readableName(c.img)
  return n && !HASHY.test(n.replace(/\s/g, '')) ? n : 'illustration'
}

/** The prompt to send to AI Studio for an empty cutaway (the engine's planned prompt when there is one). */
export function cutawayPrompt(c: Cutaway, captionText: string): string {
  if (c.need?.prompt) return c.need.prompt
  const scene = captionText.trim() || 'a quiet hopeful scene that fits a sermon moment'
  return `VERTICAL 9:16 portrait. Warm cinematic illustration, no text, no logos: ${scene}`
}
