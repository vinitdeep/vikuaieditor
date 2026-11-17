import type {
  AuthStatus,
  AutomateRequest,
  BibleVerse,
  Candidate,
  CaptionFix,
  Cutaway,
  Feedback,
  Health,
  JobEvent,
  JobRef,
  Lang,
  LangOpt,
  LibraryImage,
  LicenceItem,
  ModelInstallRequest,
  ModelItem,
  MusicTrack,
  MusicMood,
  MusicGenerateRequest,
  StarterInfo,
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
  /** attach a captured image to cutaway i (engine copies it into the library); null = adapter cannot, set it locally */
  attachCutawayImage(reelId: string, index: number, path: string): Promise<Cutaway | null>
  render(reelId: string, preset?: string): Promise<JobRef>
  thumbnail(reelId: string): Promise<JobRef>
  automate(body: AutomateRequest): Promise<JobRef>
  /** build (+ render) the clip the editor picked after automate({pick}) — result has the automate shape */
  automateBuild(projectId: string, c: Candidate): Promise<JobRef>
  cancelJob(jobId: string): Promise<boolean>
  /** poll one job (fallback when SSE is quiet); null when unknown */
  jobStatus(jobId: string): Promise<JobEvent | null>

  captionsFix(text: string, lang: Lang): Promise<CaptionFix>
  feedback(f: Feedback): Promise<void>
  learn(): Promise<JobRef>

  bibleSearch(q: string, lang: Lang): Promise<BibleVerse[]>
  bibleVerse(ref: string, lang: Lang): Promise<BibleVerse | null>
  bibleDownload(): Promise<JobRef>

  librarySearch(q: string, limit?: number): Promise<LibraryImage[]>
  libraryImport(paths: string[], tags: string[]): Promise<JobRef | null>
  listMusic(): Promise<MusicTrack[]>
  heygenMusic(intent: string): Promise<JobRef>
  /** offline music generator: moods (GET /music/moods) */
  musicMoods(): Promise<MusicMood[]>
  /** job → result {name, path, preview, mood, seed} */
  generateMusic(req: MusicGenerateRequest): Promise<JobRef>
  /** move a generated preview into the music library */
  keepMusic(path: string): Promise<MusicTrack>
  deleteMusic(name: string): Promise<void>
  /** bundled starter content status (GET /starter) */
  starter(): Promise<StarterInfo>
  /** import the bundled starter illustrations (POST /library/import {seed: true}) */
  importStarter(): Promise<JobRef | null>
  listSfx(): Promise<SfxItem[]>

  /** tools + models (GET /models) */
  listModels(): Promise<ModelItem[]>
  /** job: download / copy + verify (byte progress in the job result) */
  installModels(body: ModelInstallRequest): Promise<JobRef>
  removeModels(ids: string[]): Promise<void>
  /** third-party licences of everything the engine ships or downloads (GET /licences) */
  licences(): Promise<LicenceItem[]>

  authStatus(): Promise<AuthStatus>
  heygenLogin(): Promise<JobRef>

  /** URL the <video>/<img>/<audio> element can load (engine /media?path= with Range). */
  mediaUrl(path: string): string
  /** small cached JPEG of a local image (viku-thumb:// in Electron), for grids and timelines */
  thumbUrl(path: string, width?: number): string
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
