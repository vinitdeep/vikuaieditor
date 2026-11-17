// Defensive decoders: everything that comes over the wire is `unknown` until it passes through here.
import type {
  AuthStatus,
  BibleVerse,
  Candidate,
  Caption,
  CaptionFix,
  CaptionFlag,
  Crop,
  Cutaway,
  CutawayNeed,
  ExportItem,
  ExportPreset,
  Health,
  JobEvent,
  JobRef,
  JobState,
  Lang,
  LangOpt,
  LibraryImage,
  LicenceItem,
  ModelItem,
  Music,
  MusicTrack,
  MusicMood,
  StarterInfo,
  Project,
  ProjectSummary,
  ProxyRange,
  Reel,
  Seg,
  Settings,
  Sfx,
  SfxItem,
  TranscriptLine,
  Verse,
  Waveform
} from './types'

type Rec = Record<string, unknown>

export const isRec = (x: unknown): x is Rec => typeof x === 'object' && x !== null && !Array.isArray(x)
const rec = (x: unknown): Rec => (isRec(x) ? x : {})
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
export const num = (x: unknown, d = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : d)
export const str = (x: unknown, d = ''): string => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : d)
const bool = (x: unknown, d = false): boolean => (typeof x === 'boolean' ? x : d)

export const lang = (x: unknown, d: Lang = 'en'): Lang => (x === 'or' || x === 'hi' || x === 'en' ? x : d)
export const langOpt = (x: unknown, d: LangOpt = 'auto'): LangOpt => (x === 'auto' ? 'auto' : lang(x, d === 'auto' ? 'en' : d))

const seg = (x: unknown): Seg | null => {
  const a = arr(x)
  if (a.length < 2) return null
  return [num(a[0]), num(a[1])]
}
const segs = (x: unknown): Seg[] => arr(x).map(seg).filter((s): s is Seg => s !== null)

export function health(x: unknown): Health {
  const r = rec(x)
  const o = rec(r.offline_ready)
  return {
    ok: bool(r.ok, true),
    version: str(r.version, '?'),
    gpu: typeof r.gpu === 'string' ? r.gpu : bool(r.gpu),
    offline_ready: { asr: bool(o.asr), denoise: bool(o.denoise), embed: bool(o.embed), bible: bool(o.bible), library: bool(o.library) },
    data_dir: typeof r.data_dir === 'string' ? r.data_dir : undefined,
    details: isRec(r.details) ? r.details : undefined
  }
}

const PRESET_NAMES: Record<string, string> = { reel: 'Reels 1080×1920', reels: 'Reels 1080×1920', shorts: 'Shorts 1080×1920', youtube: 'YouTube 16:9' }

export function preset(x: unknown, i: number, id?: string): ExportPreset {
  const r = rec(x)
  const pid = str(r.id, id ?? `preset-${i}`)
  return {
    ...r,
    id: pid,
    name: str(r.name, PRESET_NAMES[pid] ?? `${pid} ${num(r.width, 1080)}×${num(r.height, 1920)}`),
    width: num(r.width, 1080),
    height: num(r.height, 1920),
    fps: num(r.fps, 30),
    max_seconds: r.max_seconds === undefined ? undefined : num(r.max_seconds)
  }
}

/** Engine keeps presets as a {id: {...}} map; the UI edits a list. Folders may sit under `paths`. */
export function settings(x: unknown): Settings {
  const r = rec(x)
  const paths = rec(r.paths)
  const presets = Array.isArray(r.export_presets)
    ? r.export_presets.map((p, i) => preset(p, i))
    : Object.entries(rec(r.export_presets)).map(([id, p], i) => preset(p, i, id))
  return {
    data_dir: str(r.data_dir ?? paths.data_dir),
    projects_dir: str(r.projects_dir ?? paths.projects_dir),
    library_dir: str(r.library_dir ?? paths.library_dir),
    music_dir: str(r.music_dir ?? paths.music_dir),
    exports_dir: str(r.exports_dir ?? paths.exports_dir),
    church_name: str(r.church_name),
    credit_line: str(r.credit_line),
    default_language: langOpt(r.default_language),
    export_presets: presets
  }
}

/** Patch in the engine's own shape (presets as a map, only folders the user filled in). */
export function settingsPatch(s: Settings): Record<string, unknown> {
  const out: Record<string, unknown> = {
    church_name: s.church_name,
    credit_line: s.credit_line,
    default_language: s.default_language,
    export_presets: Object.fromEntries(
      s.export_presets.map((p) => {
        const { id, ...rest } = p
        return [id, rest]
      })
    )
  }
  for (const k of ['projects_dir', 'exports_dir', 'library_dir', 'music_dir', 'data_dir'] as const) if (s[k]) out[k] = s[k]
  return out
}

export function transcriptLine(x: unknown): TranscriptLine {
  const r = rec(x)
  return { ...r, start: num(r.start), end: num(r.end), text: str(r.text), lang: lang(r.lang), conf: num(r.conf, 1) }
}

const flag = (x: unknown): CaptionFlag => {
  const r = rec(x)
  return { ...r, start: num(r.start), end: num(r.end), reason: str(r.reason), suggest: r.suggest === undefined || r.suggest === null ? undefined : str(r.suggest) }
}

const crop = (x: unknown): Crop => {
  const r = rec(x)
  return { ...r, t0: num(r.t0), t1: num(r.t1), cx: num(r.cx, 0.5), cw: num(r.cw, 0.316), z: num(r.z, 1) }
}
const caption = (x: unknown): Caption => {
  const r = rec(x)
  return { ...r, t0: num(r.t0), t1: num(r.t1), text: str(r.text), flags: arr(r.flags).map(flag) }
}
const verse = (x: unknown): Verse => {
  const r = rec(x)
  return { ...r, t0: num(r.t0), t1: num(r.t1), text: str(r.text), ref: str(r.ref), top_y: num(r.top_y, 360) }
}
export const cutawayOf = (x: unknown): Cutaway => cutaway(x)
const cutaway = (x: unknown): Cutaway => {
  const r = rec(x)
  const pan = arr(r.pan)
  const out: Cutaway = { ...r, t0: num(r.t0), t1: num(r.t1), img: str(r.img), z0: num(r.z0, 1), z1: num(r.z1, 1.08), pan: [num(pan[0]), num(pan[1])] }
  if (isRec(r.need)) out.need = need(r.need)
  return out
}
const need = (r: Rec): CutawayNeed => ({
  ...r,
  prompt: str(r.prompt),
  slug: str(r.slug, 'cutaway'),
  scene: r.scene === undefined ? undefined : str(r.scene),
  text: r.text === undefined ? undefined : str(r.text),
  tags: arr(r.tags).map((t) => str(t)),
  grade: r.grade === undefined ? undefined : str(r.grade)
})
const music = (x: unknown): Music | null => {
  if (!isRec(x) || !str(x.path)) return null
  return { ...x, path: str(x.path), gain_db: num(x.gain_db, -19), start: num(x.start), duck_db: x.duck_db === undefined ? undefined : num(x.duck_db) }
}
const sfx = (x: unknown): Sfx => {
  const r = rec(x)
  return { ...r, name: str(r.name), t: num(r.t), gain_db: num(r.gain_db, -6) }
}

const exportItem = (x: unknown): ExportItem => {
  if (typeof x === 'string') return { path: x }
  const r = rec(x)
  return { ...r, path: str(r.path ?? r.output), thumbnail: r.thumbnail === undefined || r.thumbnail === null ? undefined : str(r.thumbnail) }
}

const proxyRange = (x: unknown): ProxyRange => {
  const r = rec(x)
  return { path: str(r.path), start: num(r.start), end: num(r.end) }
}

export function reel(x: unknown): Reel {
  const r = rec(x)
  const style = rec(r.style)
  const th = rec(r.thumbnail)
  const status = r.status === 'built' || r.status === 'rendered' ? r.status : 'draft'
  return {
    ...r,
    id: str(r.id),
    title: str(r.title),
    sub: str(r.sub),
    language: lang(r.language),
    segments: segs(r.segments),
    crops: arr(r.crops).map(crop),
    captions: arr(r.captions).map(caption),
    verses: arr(r.verses).map(verse),
    cutaways: arr(r.cutaways).map(cutaway),
    music: music(r.music),
    sfx: arr(r.sfx).map(sfx),
    style: {
      ...style,
      caption_font: str(style.caption_font, r.language === 'or' ? 'Noto Sans Oriya' : r.language === 'hi' ? 'Noto Sans Devanagari' : 'Noto Sans'),
      caption_size: num(style.caption_size, 64),
      title_style: str(style.title_style, 'gold-bar'),
      voice_gain_db: style.voice_gain_db === undefined ? undefined : num(style.voice_gain_db)
    },
    thumbnail: {
      ...th,
      style: str(th.style, 'frame'),
      pose_t: th.pose_t === null || th.pose_t === undefined ? null : num(th.pose_t),
      title: str(th.title, str(r.title)),
      sub: str(th.sub, str(r.sub)),
      verse: str(th.verse)
    },
    status,
    exports: arr(r.exports).map(exportItem)
  }
}

export function project(x: unknown): Project {
  const r = rec(x)
  return {
    ...r,
    id: str(r.id),
    name: str(r.name, 'Untitled sermon'),
    video_path: str(r.video_path),
    duration: num(r.duration),
    fps: num(r.fps, 30),
    language: langOpt(r.language),
    proxy: str(r.proxy),
    proxy_offset: num(r.proxy_offset),
    proxies: arr(r.proxies).map(proxyRange).filter((p) => p.path),
    width: num(r.width, 1920),
    height: num(r.height, 1080),
    wav16: str(r.wav16),
    shots: arr(r.shots).map((s) => num(s)),
    pauses: segs(r.pauses),
    transcript: arr(r.transcript).map(transcriptLine),
    reels: arr(r.reels).map(reel)
  }
}

export function projectSummary(x: unknown): ProjectSummary {
  const r = rec(x)
  const reels = arr(r.reels)
  return {
    id: str(r.id),
    name: str(r.name, 'Untitled sermon'),
    video_path: str(r.video_path),
    duration: num(r.duration),
    language: langOpt(r.language),
    reel_count: r.reel_count !== undefined ? num(r.reel_count) : typeof r.reels === 'number' ? r.reels : reels.length,
    analyzed: Array.isArray(r.analyzed) ? r.analyzed.length > 0 : r.analyzed !== undefined ? bool(r.analyzed) : arr(r.transcript).length > 0 || Boolean(str(r.proxy)),
    thumb: r.thumb === undefined ? undefined : str(r.thumb),
    updated: r.updated === undefined ? undefined : str(r.updated)
  }
}

export function candidate(x: unknown, i: number): Candidate {
  const r = rec(x)
  return {
    id: str(r.id, `cand-${i}`),
    score: num(r.score),
    title: str(r.title),
    segments: segs(r.segments),
    reasons: arr(r.reasons).map((s) => str(s)),
    language: lang(r.language),
    duration: r.duration === undefined ? undefined : num(r.duration),
    window: Array.isArray(r.window) && r.window.length === 2 ? [num(r.window[0]), num(r.window[1])] : undefined,
    target_seconds: r.target_seconds === undefined ? undefined : num(r.target_seconds),
    short_of_target: r.short_of_target === undefined ? undefined : bool(r.short_of_target)
  }
}

export function candidates(x: unknown): Candidate[] {
  const list = Array.isArray(x) ? x : arr(rec(x).candidates)
  return list.map(candidate)
}

export function jobRef(x: unknown, kind: string): JobRef {
  const r = rec(x)
  const id = str(r.job ?? r.job_id ?? r.id)
  if (!id) throw new Error(`Engine did not return a job id for ${kind}`)
  return { job: id, kind: str(r.kind, kind) }
}

const jobStates: JobState[] = ['queued', 'running', 'done', 'error', 'cancelled']
export function jobEvent(x: unknown): JobEvent | null {
  const r = rec(x)
  const job = str(r.job ?? r.id)
  if (!job) return null
  const s = jobStates.find((v) => v === r.state) ?? 'running'
  const message = s === 'error' && r.error ? str(r.error) : str(r.message)
  const ev: JobEvent = { job, kind: str(r.kind, 'job'), progress: Math.max(0, Math.min(1, num(r.progress))), message, state: message === 'cancelled' && s === 'error' ? 'cancelled' : s, result: r.result }
  if (r.error) ev.error = str(r.error)
  const code = errorCode(r)
  if (code) ev.code = code
  return ev
}

const ERROR_CODES = ['hf_auth_required', 'network', 'checksum'] as const

/** A failure's code: an explicit field, a "code: message" prefix, or recognised wording of older engines. */
export function errorCode(r: Record<string, unknown>): string | undefined {
  const res = rec(r.result)
  const explicit = r.code ?? r.error_code ?? res.code ?? res.error_code ?? rec(r.detail).code
  if (typeof explicit === 'string' && explicit) return explicit
  const text = str(r.error ?? r.message ?? r.detail)
  const m = text.match(/^\[?([a-z_]+)\]?[:\s]/)
  if (m && (ERROR_CODES as readonly string[]).includes(m[1])) return m[1]
  if (/needs sign-in|HTTP 40[13]|gated|hf_token|token/i.test(text) && /hugging ?face|huggingface\.co|gated/i.test(text)) return 'hf_auth_required'
  if (/checksum|sha-?256 mismatch|corrupt/i.test(text)) return 'checksum'
  if (/download failed|internet|timed? ?out|connection|getaddrinfo|unreachable|URLError/i.test(text)) return 'network'
  return undefined
}

export function modelItem(x: unknown): ModelItem {
  const r = rec(x)
  const gated = Boolean(r.gated)
  const installed = Boolean(r.installed)
  return {
    ...r,
    id: str(r.id),
    name: str(r.name, str(r.id)),
    purpose: str(r.purpose),
    size_mb: num(r.size_mb),
    licence: str(r.licence ?? r.license),
    licence_url: str(r.licence_url ?? r.license_url),
    required: Boolean(r.required),
    installed,
    source: r.source === null || r.source === undefined ? null : str(r.source),
    path: str(r.path),
    gated,
    partial_mb: num(r.partial_mb),
    needs_token: r.needs_token === undefined ? false : Boolean(r.needs_token) && !installed,
    accept_url: r.accept_url ? str(r.accept_url) : undefined
  }
}

export function modelList(x: unknown): ModelItem[] {
  const list = Array.isArray(x) ? x : arr(rec(x).items ?? rec(x).models)
  return list.map(modelItem).filter((m) => m.id)
}

export function licenceList(x: unknown): LicenceItem[] {
  const r = rec(x)
  const list: unknown[] = Array.isArray(x) ? x : arr(r.components ?? r.items ?? r.licences ?? r.licenses)
  // also accept {group: [...]} maps (e.g. {"python": [...], "models": [...]})
  const flat: { item: unknown; kind?: string }[] = list.length
    ? list.map((item) => ({ item }))
    : Object.entries(r).flatMap(([k, v]) => (Array.isArray(v) ? v.map((item) => ({ item, kind: k })) : []))
  return flat
    .map(({ item, kind }) => {
      const o = rec(item)
      const name = str(o.name ?? o.package ?? o.id)
      return {
        name,
        licence: str(o.licence ?? o.license ?? o.spdx, 'unknown'),
        url: o.url ?? o.licence_url ?? o.license_url ?? o.homepage ? str(o.url ?? o.licence_url ?? o.license_url ?? o.homepage) : undefined,
        version: o.version ? str(o.version) : undefined,
        kind: o.kind ?? o.type ?? kind ? str(o.kind ?? o.type ?? kind) : undefined,
        text: o.text || o.notice ? str(o.text ?? o.notice) : undefined
      }
    })
    .filter((l) => l.name)
}

export function waveform(x: unknown, start: number, end: number): Waveform {
  const peaksRaw = Array.isArray(x) ? x : arr(rec(x).peaks)
  const peaks = peaksRaw.map((p) => (Array.isArray(p) ? Math.max(Math.abs(num(p[0])), Math.abs(num(p[1]))) : Math.abs(num(p))))
  const max = peaks.reduce((m, p) => Math.max(m, p), 0)
  const scale = max <= 1 ? 1 : max <= 128 ? 128 : max
  return { peaks: peaks.map((p) => Math.min(1, p / scale)), start, end }
}

export function captionFix(x: unknown, text: string): CaptionFix {
  const r = rec(x)
  return { text: str(r.text, text), flags: arr(r.flags).map(flag) }
}

export function bibleVerse(x: unknown, l: Lang): BibleVerse {
  const r = rec(x)
  return { ref: str(r.ref_native ?? r.ref), text: str(r.text), lang: lang(r.lang, l) }
}

export function bibleList(x: unknown, l: Lang): BibleVerse[] {
  const list = Array.isArray(x) ? x : arr(rec(x).results ?? rec(x).verses)
  return list.map((v) => bibleVerse(v, l))
}

export function libraryImages(x: unknown): LibraryImage[] {
  const list = Array.isArray(x) ? x : arr(rec(x).results ?? rec(x).items)
  return list.map((v) => {
    const r = rec(v)
    const path = str(r.path)
    return {
      id: r.id === undefined || r.id === null ? undefined : str(r.id),
      path,
      name: str(r.name ?? r.title, path.split(/[\\/]/).pop() ?? path),
      tags: arr(r.tags).map((t) => str(t)),
      width: r.width === undefined ? undefined : num(r.width),
      height: r.height === undefined ? undefined : num(r.height)
    }
  })
}

export function musicList(x: unknown): MusicTrack[] {
  const list = Array.isArray(x) ? x : arr(rec(x).tracks ?? rec(x).items)
  return list.map((v) => {
    const r = rec(v)
    const path = str(r.path)
    return {
      path,
      name: str(r.name, path.split(/[\\/]/).pop() ?? path),
      duration: num(r.duration),
      mood: r.mood !== undefined ? str(r.mood) : arr(r.tags).length ? str(arr(r.tags)[0]) : undefined,
      bpm: r.bpm === undefined ? undefined : num(r.bpm),
      source: r.source === 'heygen' ? 'heygen' : r.source === 'viku' ? 'viku' : 'library',
      seed: r.seed === undefined || r.seed === null ? undefined : num(r.seed)
    }
  })
}

export function musicMoods(x: unknown): MusicMood[] {
  return arr(x)
    .map((v) => {
      const r = rec(v)
      return { id: str(r.id), label: str(r.label, str(r.id)), desc: str(r.desc) }
    })
    .filter((m) => m.id)
}

export function starterInfo(x: unknown): StarterInfo {
  const r = rec(x)
  const il = rec(r.illustrations)
  const mu = rec(r.music)
  return {
    illustrations: {
      available: Boolean(il.available),
      count: num(il.count),
      imported: num(il.imported),
      size_mb: il.size_mb === undefined ? undefined : num(il.size_mb),
      licence: il.licence ? str(il.licence) : undefined,
      path: il.path ? str(il.path) : undefined
    },
    music: { generated: num(mu.generated), tracks: num(mu.tracks), defaults_job: mu.defaults_job ? str(mu.defaults_job) : null }
  }
}

export function sfxList(x: unknown): SfxItem[] {
  const list = Array.isArray(x) ? x : arr(rec(x).items)
  return list.map((v) => {
    const r = rec(v)
    const path = str(r.path)
    return { name: str(r.name, path.split(/[\\/]/).pop() ?? path), path, duration: num(r.duration, 1), kind: str(r.kind, 'sfx') }
  })
}

export function authStatus(x: unknown): AuthStatus {
  const r = rec(x)
  return { gemini_web: bool(r.gemini_web), heygen: bool(r.heygen), ebible: r.ebible === 'downloaded' ? 'downloaded' : 'missing' }
}
