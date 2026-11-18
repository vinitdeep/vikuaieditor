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
  return imagePrompt(captionText.trim() || 'a quiet hopeful moment that fits a sermon')
}

const ASK = 'Create one picture (an image, not words).'
const LOOK = 'VERTICAL 9:16 portrait. Photorealistic cinematic still, India, warm hopeful light, shallow depth of field, soft film grain, no text, no letters.'
const PEOPLE =
  'The people are Indian Christians with clean, plain, unmarked foreheads and simple everyday clothes; the setting is a home, village, field or simple church, never a temple or shrine.'

/**
 * What is sent to AI Studio for a cutaway. Gemini's image model answers a bare idea ("our tongue is not in our
 * control") with an essay, or with "No image generated" when only images are allowed — so a short line someone types
 * becomes the SCENE of a full picture prompt in Viku's look, and a full prompt (Viku's own plan, or one written with
 * "9:16 / vertical") only gets the request for a picture in front.
 */
export function imagePrompt(text: string): string {
  const t = text.trim()
  if (/9:16|vertical/i.test(t)) return t.startsWith(ASK) ? t : `${ASK} ${t}`
  return `${ASK} ${LOOK} ${PEOPLE} SCENE: one clear moment a viewer can see that shows this sermon line - "${t}". Show it with real people in a real place (faces, gestures, light), not as words or symbols.`
}

/** Put a library / file image on an existing cutaway (keeps its timing and motion). */
export function setCutawayImage(c: Cutaway, path: string, lib?: Pick<LibraryImage, 'id' | 'name'>): void {
  c.img = path
  if (lib?.id) c.lib_id = lib.id
  else delete c.lib_id
  // the editor chose this picture: drop the planner's match details
  c.why = lib?.name ? { desc: readableName(lib.name), pick: 'editor' } : { pick: 'editor' }
  if (c.need) {
    c.need_done = c.need
    delete c.need
  }
}

/** index of the cutaway under reel time t (or -1) */
export function cutawayAt(cutaways: Cutaway[], t: number): number {
  return cutaways.findIndex((c) => t >= c.t0 - 1e-3 && t < c.t1)
}
