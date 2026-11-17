// Types mirroring the engine contract in ARCHITECTURE.md. All times are seconds.

export type Lang = 'or' | 'hi' | 'en'
export type LangOpt = Lang | 'auto'

export interface OfflineReady {
  asr: boolean
  denoise: boolean
  embed: boolean
  bible: boolean
  library: boolean
}

export interface Health {
  ok: boolean
  version: string
  gpu: boolean | string
  offline_ready: OfflineReady
  /** engine data folder (%APPDATA%\Viku unless VIKU_DATA) */
  data_dir?: string
  /** extra readiness details: asr_indic, asr_whisper_en, denoise_engine, library_images, music_tracks, fonts, sfx … */
  details?: Record<string, unknown>
}

export interface ExportPreset {
  id: string
  name: string
  width: number
  height: number
  fps: number
  max_seconds?: number
}

export interface Settings {
  data_dir: string
  projects_dir: string
  library_dir: string
  music_dir: string
  exports_dir: string
  church_name: string
  credit_line: string
  default_language: LangOpt
  export_presets: ExportPreset[]
}

export interface TranscriptLine {
  start: number
  end: number
  text: string
  lang: Lang
  conf: number
}

export type Seg = [number, number]

export interface Crop {
  t0: number
  t1: number
  /** crop centre, 0..1 of source width */
  cx: number
  /** crop width, 0..1 of source width (9:16 of a 16:9 frame ≈ 0.316) */
  cw: number
  /** static punch-in, 1.0 or 1.12 for alternating jump-cut segments */
  z: number
}

export interface CaptionFlag {
  start: number
  end: number
  reason: string
  suggest?: string
}

export interface Caption {
  t0: number
  t1: number
  text: string
  flags: CaptionFlag[]
}

export interface Verse {
  t0: number
  t1: number
  text: string
  ref: string
  /** card top in 1080×1920 px */
  top_y: number
}

/** A cutaway the engine could not fill from the library: what to generate (AI Studio prompt etc.). */
export interface CutawayNeed {
  prompt: string
  slug: string
  scene?: string
  text?: string
  tags?: string[]
  grade?: string
}

export interface Cutaway {
  t0: number
  t1: number
  /** '' = no image yet */
  img: string
  z0: number
  z1: number
  pan: [number, number]
  /** engine extras: library id and why it was picked (tag list, or {match, z, concept, desc} / {nearest}) */
  lib_id?: string | null
  why?: string[] | { desc?: string; nearest?: string; match?: number; [k: string]: unknown }
  /** set while the cutaway waits for a generated image */
  need?: CutawayNeed
  need_done?: CutawayNeed
}

export interface Music {
  path: string
  gain_db: number
  start: number
  /** UI extras (optional; engine may ignore) */
  duck_db?: number
}

export interface Sfx {
  name: string
  t: number
  gain_db: number
}

export interface ReelStyle {
  caption_font: string
  caption_size: number
  title_style: string
  voice_gain_db?: number
}

export interface Thumbnail {
  style: string
  /** null = engine default (a third of the way in, ≥ 4.5 s) */
  pose_t: number | null
  title: string
  sub: string
  verse: string
}

export type ReelStatus = 'draft' | 'built' | 'rendered'

export interface Reel {
  id: string
  title: string
  sub: string
  language: Lang
  segments: Seg[]
  crops: Crop[]
  captions: Caption[]
  verses: Verse[]
  cutaways: Cutaway[]
  music: Music | null
  sfx: Sfx[]
  style: ReelStyle
  thumbnail: Thumbnail
  status: ReelStatus
  exports: ExportItem[]
}

export interface ExportItem {
  path: string
  thumbnail?: string
}

export interface ProxyRange {
  path: string
  start: number
  end: number
}

export interface Project {
  id: string
  name: string
  video_path: string
  duration: number
  fps: number
  language: LangOpt
  proxy: string
  /** source second at which `proxy` starts (engine proxies analysed ranges only) */
  proxy_offset: number
  proxies: ProxyRange[]
  width: number
  height: number
  wav16: string
  shots: number[]
  pauses: Seg[]
  transcript: TranscriptLine[]
  reels: Reel[]
}

export interface ProjectSummary {
  id: string
  name: string
  video_path: string
  duration: number
  language: LangOpt
  reel_count: number
  analyzed: boolean
  thumb?: string
  updated?: string
}

export interface Candidate {
  id: string
  score: number
  title: string
  segments: Seg[]
  reasons: string[]
  language: Lang
}

export type JobState = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface JobEvent {
  job: string
  kind: string
  progress: number
  message: string
  state: JobState
  result?: unknown
}

export interface JobRef {
  job: string
  kind: string
}

export interface Waveform {
  /** normalised 0..1 peak per pixel column */
  peaks: number[]
  start: number
  end: number
}

export interface CaptionFix {
  text: string
  flags: CaptionFlag[]
}

export type FeedbackKind = 'keep' | 'reject' | 'caption_edit'

export interface Feedback {
  reel_id: string
  kind: FeedbackKind
  before?: unknown
  after?: unknown
}

export interface BibleVerse {
  ref: string
  text: string
  lang: Lang
}

export interface LibraryImage {
  id?: string
  path: string
  name: string
  tags: string[]
  width?: number
  height?: number
}

export interface MusicTrack {
  path: string
  name: string
  duration: number
  mood?: string
  bpm?: number
  source?: 'library' | 'heygen'
}

export interface SfxItem {
  name: string
  path: string
  duration: number
  kind: string
}

export interface AuthStatus {
  gemini_web: boolean
  heygen: boolean
  ebible: 'downloaded' | 'missing'
}

export interface HeygenDeviceCode {
  code: string
  url: string
}

export interface AutomateRequest {
  video_path: string
  language: LangOpt
  count: number
  max_seconds: number
  illustrations: 'library' | 'gemini' | 'none'
  music: 'library' | 'heygen' | 'none'
  thumbnails: boolean
}

export interface AutomateResultReel {
  project_id: string
  reel_id: string
  title: string
  duration: number
  score?: number
  output?: string
  thumbnail?: string
}
