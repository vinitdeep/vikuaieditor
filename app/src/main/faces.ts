import { nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { Face, FacesState } from '../shared/ipc'

/**
 * Faces for "Same face": reference photos the church saves once (a pastor, a recurring character). When one is chosen,
 * every AI Studio prompt is sent with that photo attached and asks Gemini to keep the same person, so the face stays the
 * same from picture to picture. Stored in <userData>/faces: one JPEG per face (long side at most 1024 px, enough for
 * Gemini and small enough to hand to the browser extension) and faces.json with the names and the chosen one.
 */
const MAX_SIDE = 1024

/** Added to a prompt sent with a face photo (Gemini's image model keeps a character from a reference image). */
export const FACE_ASK =
  'Use the person in the attached photo as the main person in this picture: keep exactly the same face, age, skin tone and hair, so they are clearly the same person. Give them a new pose and expression that fit this scene; their clothes may change to fit it. Do not copy the background of the photo.'

export function withFace(prompt: string): string {
  if (prompt.includes(FACE_ASK)) return prompt
  const ask = 'Create one picture (an image, not words).'
  return prompt.startsWith(ask) ? `${ask} ${FACE_ASK}${prompt.slice(ask.length)}` : `${FACE_ASK} ${prompt}`
}

export class FaceStore {
  private state: FacesState = { faces: [], selected: '' }

  constructor(
    private dir: () => string,
    private onChange: (s: FacesState) => void
  ) {}

  private index(): string {
    return join(this.dir(), 'faces.json')
  }

  load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.index(), 'utf8')) as FacesState
      const faces = (raw.faces ?? []).filter((f) => f && f.id && f.file && existsSync(f.file))
      this.state = { faces, selected: faces.some((f) => f.id === raw.selected) ? raw.selected : '' }
    } catch {
      this.state = { faces: [], selected: '' }
    }
  }

  private save(): FacesState {
    mkdirSync(this.dir(), { recursive: true })
    writeFileSync(this.index(), JSON.stringify(this.state, null, 2))
    this.onChange(this.state)
    return this.state
  }

  list(): FacesState {
    return this.state
  }

  get(id: string | undefined): Face | undefined {
    return id ? this.state.faces.find((f) => f.id === id && existsSync(f.file)) : undefined
  }

  /** Copy photos in as faces (resized to MAX_SIDE, JPEG). The first one added becomes the chosen face. */
  add(paths: string[], name?: string): FacesState {
    mkdirSync(this.dir(), { recursive: true })
    let first = ''
    for (const p of paths) {
      const id = randomUUID().slice(0, 8)
      const out = join(this.dir(), `face-${id}.jpg`)
      let img = nativeImage.createFromPath(p)
      if (img.isEmpty()) {
        // a format nativeImage cannot read (e.g. some WebP files): keep the original bytes when Gemini can use them
        if (!/\.(png|jpe?g|webp)$/i.test(p)) throw new Error(`${basename(p)} is not a picture Viku can read`)
        const copy = join(this.dir(), `face-${id}${extname(p).toLowerCase()}`)
        writeFileSync(copy, readFileSync(p))
        this.state.faces.push({ id, name: name || faceName(p, this.state.faces.length), file: copy, addedAt: Date.now() })
        first ||= id
        continue
      }
      const { width, height } = img.getSize()
      if (Math.max(width, height) > MAX_SIDE) img = width >= height ? img.resize({ width: MAX_SIDE, quality: 'best' }) : img.resize({ height: MAX_SIDE, quality: 'best' })
      writeFileSync(out, img.toJPEG(92))
      this.state.faces.push({ id, name: name || faceName(p, this.state.faces.length), file: out, addedAt: Date.now() })
      first ||= id
    }
    if (first) this.state.selected = first
    return this.save()
  }

  remove(id: string): FacesState {
    const f = this.state.faces.find((x) => x.id === id)
    if (f) rmSync(f.file, { force: true })
    this.state.faces = this.state.faces.filter((x) => x.id !== id)
    if (this.state.selected === id) this.state.selected = ''
    return this.save()
  }

  select(id: string): FacesState {
    this.state.selected = this.state.faces.some((f) => f.id === id) ? id : ''
    return this.save()
  }

  rename(id: string, name: string): FacesState {
    const f = this.state.faces.find((x) => x.id === id)
    if (f && name.trim()) f.name = name.trim().slice(0, 40)
    return this.save()
  }

  /** The face photo as the browser extension attaches it in AI Studio. */
  ref(id: string | undefined): { name: string; mime: string; b64: string } | null {
    const f = this.get(id)
    if (!f) return null
    const ext = extname(f.file).toLowerCase()
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    return { name: `face-${safe(f.name)}${ext}`, mime, b64: readFileSync(f.file).toString('base64') }
  }
}

function faceName(p: string, n: number): string {
  const stem = basename(p, extname(p))
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // camera names ("IMG 2041", "Screenshot 2026...") say nothing: number the face instead
  if (!stem || /^(img|dsc|pxl|screenshot|whatsapp|photo|image)\b/i.test(stem) || /^[\d\s]+$/.test(stem)) return `Face ${n + 1}`
  return stem.slice(0, 40)
}

function safe(s: string): string {
  return s.replace(/[^\w-]+/g, '-').slice(0, 30) || 'face'
}
