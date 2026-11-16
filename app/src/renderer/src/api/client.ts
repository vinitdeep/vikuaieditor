import type {
  AuthStatus,
  AutomateRequest,
  BibleVerse,
  Candidate,
  CaptionFix,
  Feedback,
  Health,
  JobEvent,
  JobRef,
  Lang,
  LangOpt,
  LibraryImage,
  MusicTrack,
  Project,
  ProjectSummary,
  Reel,
  Seg,
  Settings,
  SfxItem,
  Waveform
} from './types'

/** The one surface every screen talks to. Implemented by the HTTP adapter (engine) and the mock adapter. */
export interface VikuApi {
  readonly kind: 'live' | 'mock'
  health(): Promise<Health>
  getSettings(): Promise<Settings>
  saveSettings(s: Settings): Promise<Settings>

  listProjects(): Promise<ProjectSummary[]>
  getProject(id: string): Promise<Project>
  createProject(body: { name: string; video_path: string; language: LangOpt }): Promise<Project>
  saveProject(p: Project): Promise<Project>
  analyze(projectId: string): Promise<JobRef>
  waveform(projectId: string, start: number, end: number, px: number): Promise<Waveform>

  suggest(projectId: string): Promise<JobRef>
  /** last suggestion result for a project (from the job result, cached) */
  candidates(projectId: string): Promise<Candidate[]>
  createReel(projectId: string, body: { segments: Seg[]; title: string; sub: string }): Promise<Reel>
  autobuild(reelId: string): Promise<JobRef>
  render(reelId: string, preset?: string): Promise<JobRef>
  thumbnail(reelId: string): Promise<JobRef>
  automate(body: AutomateRequest): Promise<JobRef>
  cancelJob(jobId: string): Promise<boolean>

  captionsFix(text: string, lang: Lang): Promise<CaptionFix>
  feedback(f: Feedback): Promise<void>
  learn(): Promise<JobRef>

  bibleSearch(q: string, lang: Lang): Promise<BibleVerse[]>
  bibleVerse(ref: string, lang: Lang): Promise<BibleVerse | null>
  bibleDownload(): Promise<JobRef>

  librarySearch(q: string): Promise<LibraryImage[]>
  libraryImport(paths: string[], tags: string[]): Promise<JobRef | null>
  listMusic(): Promise<MusicTrack[]>
  heygenMusic(intent: string): Promise<JobRef>
  listSfx(): Promise<SfxItem[]>

  authStatus(): Promise<AuthStatus>
  heygenLogin(): Promise<JobRef>

  /** URL the <video>/<img>/<audio> element can load (engine /media?path= with Range). */
  mediaUrl(path: string): string
  /** subscribe to job events (SSE in live mode) */
  subscribe(cb: (ev: JobEvent) => void): () => void
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}
