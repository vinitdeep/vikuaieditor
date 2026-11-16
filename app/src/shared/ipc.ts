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
}

export type EngineState = 'checking' | 'starting' | 'running' | 'stopped' | 'error'

export interface EngineStatus {
  state: EngineState
  url: string
  /** true when this app spawned the engine process (and will kill it on quit) */
  spawned: boolean
  message?: string
  log: string[]
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
}

export type CaptureVia = 'download' | 'network'

export interface CaptureEvent {
  promptId?: string
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
}

export type SignInCard = 'gemini' | 'heygen' | 'ebible'

export interface FileFilter {
  name: string
  extensions: string[]
}

export type Unsubscribe = () => void

/** API exposed on window.viku by the preload script (both windows). */
export interface VikuBridge {
  platform: string
  versions: { app: string; electron: string; chrome: string }
  prefs: {
    get(): Promise<Prefs>
    set(patch: Partial<Prefs>): Promise<Prefs>
  }
  engine: {
    status(): Promise<EngineStatus>
    restart(): Promise<EngineStatus>
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
    queue(items: { prompt: string; name: string; folder?: string }[]): Promise<PromptItem[]>
    list(): Promise<PromptItem[]>
    sendNext(): Promise<SendResult>
    remove(id: string): Promise<PromptItem[]>
    clearDone(): Promise<PromptItem[]>
    onQueue(cb: (items: PromptItem[]) => void): Unsubscribe
    onCapture(cb: (ev: CaptureEvent) => void): Unsubscribe
    onToast(cb: (t: ToastMsg) => void): Unsubscribe
    onGeminiState(cb: (s: GeminiViewState) => void): Unsubscribe
    onFocusCard(cb: (card: SignInCard) => void): Unsubscribe
  }
}

export const IPC = {
  prefsGet: 'prefs:get',
  prefsSet: 'prefs:set',
  engineStatus: 'engine:status',
  engineRestart: 'engine:restart',
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
  signinFocusCardEvt: 'signin:focus-card-evt'
} as const
