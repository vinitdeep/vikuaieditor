// Types + channel names shared by the Electron main process, the preload bridge and the renderer.

export type AdapterMode = 'auto' | 'mock' | 'live'

export interface Prefs {
  /** auto = live when the engine answers /health, otherwise mock */
  adapter: AdapterMode
  engineUrl: string
  engineCommand: string
  engineCwd: string
  autoStartEngine: boolean
  /** where AI Studio captures land before they are filed into a reel folder */
  capturesDir: string
  /** first-run onboarding finished (re-openable from Settings → General) */
  onboarded: boolean
  /**
   * bundled = the installed app runs the engine it ships (resources/engine, environment in <install>/engine-env,
   * created by bootstrap.ps1 on first launch); custom = engineCommand in engineCwd (development / own setup)
   */
  engineSource: 'bundled' | 'custom'
  /** optional base URL of a models mirror, sent with every POST /models/install as mirror_url */
  modelsMirror: string
  /**
   * browser = AI Studio runs in the user's own browser (Google allows sign-in there); Viku copies each prompt and
   * files the images the user downloads into downloadsDir. embedded = AI Studio inside Viku (Google may refuse sign-in).
   */
  geminiMode: GeminiMode
  /** folder the browser saves downloads to (watched in browser mode) */
  downloadsDir: string
}

export type GeminiMode = 'browser' | 'embedded'

export type EngineState = 'checking' | 'setup' | 'starting' | 'running' | 'stopped' | 'error'

/** First-launch engine setup (bootstrap.ps1 PROGRESS lines) */
export interface SetupStatus {
  pct: number
  message: string
  /** set when bootstrap ended with ERROR */
  error?: string
  done?: boolean
  log: string[]
}

export interface EngineStatus {
  state: EngineState
  url: string
  /** true when this app spawned the engine process (and will kill it on quit) */
  spawned: boolean
  /** the packaged app runs its own bundled engine */
  bundled: boolean
  message?: string
  log: string[]
  setup?: SetupStatus
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface EngineRequest {
  method: HttpMethod
  path: string
  body?: unknown
  timeoutMs?: number
}

export interface EngineResponse {
  ok: boolean
  status: number
  data: unknown
  error?: string
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type PromptStatus = 'queued' | 'sent' | 'captured' | 'failed'

/** What a queued AI Studio prompt is for (persisted with the queue so a capture still lands after a restart). */
export interface GenMeta {
  reelId: string
  /** cutaway index when queued (indices can shift; t0 is the stable key) */
  index: number
  /** cutaway start, reel seconds */
  t0: number
  slug?: string
  /** set once the capture was attached to the cutaway */
  attached?: boolean
}

export interface PromptItem {
  id: string
  prompt: string
  /** planned file name without extension, e.g. "reel3-cut02-empty-tomb" */
  name: string
  /** destination folder (reel folder); defaults to the captures folder */
  folder?: string
  status: PromptStatus
  file?: string
  via?: CaptureVia
  error?: string
  meta?: GenMeta
  /** ms since epoch */
  queuedAt?: number
  /** ms since epoch, when the prompt was typed / copied */
  sentAt?: number
}

export type CaptureVia = 'download' | 'network' | 'browser'

export interface CaptureEvent {
  promptId?: string
  meta?: GenMeta
  file: string
  via: CaptureVia
  width: number
  height: number
}

export interface ToastMsg {
  kind: 'info' | 'success' | 'warn' | 'error'
  text: string
}

export interface SendResult {
  ok: boolean
  /** 'typed' = inserted + Ctrl+Enter sent; 'clipboard' = copied, user pastes */
  method: 'typed' | 'clipboard' | 'none'
  item?: PromptItem
}

export interface GeminiViewState {
  open: boolean
  url: string
  loading: boolean
  title: string
  /** a Google session cookie exists in the persist:gemini partition */
  signedIn: boolean
  mode: GeminiMode
  /** downloads folder watched in browser mode */
  watchDir: string
  /** the downloads watcher is running */
  watching: boolean
}

export type SignInCard = 'gemini' | 'heygen' | 'ebible'

export interface FileFilter {
  name: string
  extensions: string[]
}

export type Unsubscribe = () => void

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  packaged: boolean
  /** Electron userData (= %APPDATA%\Viku unless VIKU_DATA / VIKU_USER_DATA) */
  userData: string
  /** bundled engine environment (<install>/engine-env), when packaged */
  engineEnv?: string
  /** bundled uv version line (resources/uv/VERSION.txt) */
  uv?: string
  /** licence texts shipped with the app shell: [{name, licence, text}] */
  shellLicences: { name: string; licence: string; url?: string; text?: string }[]
}

/** API exposed on window.viku by the preload script (both windows). */
export interface VikuBridge {
  platform: string
  versions: { app: string; electron: string; chrome: string }
  app: {
    info(): Promise<AppInfo>
  }
  prefs: {
    get(): Promise<Prefs>
    set(patch: Partial<Prefs>): Promise<Prefs>
  }
  engine: {
    status(): Promise<EngineStatus>
    restart(): Promise<EngineStatus>
    /** spawn the engine now, even when auto-start is off */
    start(): Promise<EngineStatus>
    /** run the bundled engine setup (bootstrap.ps1) again, then start the engine */
    setupRetry(): Promise<EngineStatus>
    request(req: EngineRequest): Promise<EngineResponse>
    onStatus(cb: (s: EngineStatus) => void): Unsubscribe
    /** raw SSE payloads from GET /events (already JSON-parsed) */
    onEvent(cb: (data: unknown) => void): Unsubscribe
  }
  dialog: {
    openFile(opts: { title?: string; filters?: FileFilter[]; multi?: boolean }): Promise<string[]>
    openFolder(title?: string): Promise<string | null>
  }
  shell: {
    reveal(path: string): Promise<void>
    openExternal(url: string): Promise<void>
  }
  signin: {
    open(card?: SignInCard): Promise<void>
    setGeminiBounds(bounds: Rect | null): Promise<void>
    geminiNav(action: 'back' | 'forward' | 'reload' | 'home'): Promise<void>
    geminiState(): Promise<GeminiViewState>
    queue(items: { prompt: string; name: string; folder?: string; meta?: GenMeta }[]): Promise<PromptItem[]>
    /** mark a captured prompt as attached to its cutaway (persisted) */
    markAttached(id: string): Promise<PromptItem[]>
    list(): Promise<PromptItem[]>
    sendNext(): Promise<SendResult>
    remove(id: string): Promise<PromptItem[]>
    clearDone(): Promise<PromptItem[]>
    onQueue(cb: (items: PromptItem[]) => void): Unsubscribe
    onCapture(cb: (ev: CaptureEvent) => void): Unsubscribe
    onToast(cb: (t: ToastMsg) => void): Unsubscribe
    onGeminiState(cb: (s: GeminiViewState) => void): Unsubscribe
    onFocusCard(cb: (card: SignInCard) => void): Unsubscribe
    setMode(mode: GeminiMode): Promise<GeminiViewState>
    /** open AI Studio in the user's default browser */
    openBrowser(): Promise<void>
  }
}

export const IPC = {
  appInfo: 'app:info',
  engineSetupRetry: 'engine:setup-retry',
  signinMarkAttached: 'signin:mark-attached',
  prefsGet: 'prefs:get',
  prefsSet: 'prefs:set',
  engineStatus: 'engine:status',
  engineRestart: 'engine:restart',
  engineStart: 'engine:start',
  engineRequest: 'engine:request',
  engineStatusEvt: 'engine:status-evt',
  engineEvent: 'engine:event',
  openFile: 'dialog:open-file',
  openFolder: 'dialog:open-folder',
  reveal: 'shell:reveal',
  openExternal: 'shell:open-external',
  signinOpen: 'signin:open',
  signinBounds: 'signin:bounds',
  signinNav: 'signin:nav',
  signinState: 'signin:state',
  signinQueue: 'signin:queue',
  signinList: 'signin:list',
  signinSendNext: 'signin:send-next',
  signinRemove: 'signin:remove',
  signinClearDone: 'signin:clear-done',
  signinQueueEvt: 'signin:queue-evt',
  signinCaptureEvt: 'signin:capture-evt',
  signinToastEvt: 'signin:toast-evt',
  signinStateEvt: 'signin:state-evt',
  signinFocusCardEvt: 'signin:focus-card-evt',
  signinMode: 'signin:mode',
  signinOpenBrowser: 'signin:open-browser'
} as const
