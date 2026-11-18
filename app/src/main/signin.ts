import { BrowserWindow, WebContentsView, clipboard, session, shell, type Session, type WebContents } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { imageInfo } from './imageSize'
import type { ExtHandler, ExtHello, ExtHelloInfo } from './extbridge'
import {
  IPC,
  type CaptureEvent,
  type CaptureVia,
  type GenMeta,
  type GeminiMode,
  type GeminiViewState,
  type PromptItem,
  type Rect,
  type SendResult,
  type SignInCard,
  type ToastMsg
} from '../shared/ipc'

const AISTUDIO = 'https://aistudio.google.com/'
const PARTITION = 'persist:gemini'
const MIN_SIDE = 1024

type Broadcast = (channel: string, payload: unknown) => void

interface ModeOptions {
  mode: () => GeminiMode
  watchDir: () => string
  saveMode: (mode: GeminiMode) => void
  /** folder holding the unpacked Viku browser extension */
  extensionFolder: () => string
}

/** AI Studio image model the extension opens (`?model=` preselects it) */
const EXT_MODEL = 'gemini-3.1-flash-image'
/** an extension prompt with no answer after this long goes back to the queue */
const EXT_STALE_MS = 4 * 60_000
const EXT_ALIVE_MS = 75_000

const IMAGE_FILE = /.(png|jpe?g|webp)$/i

/**
 * Sign-in window + Google AI Studio capture.
 * The user signs in to Google themselves: we never fill credentials or store passwords.
 *
 * Two modes:
 *  - browser (default): AI Studio runs in the user's own browser, where Google allows sign-in.
 *    With the Viku browser extension (extension/, talks to ./extbridge on 127.0.0.1) the queue runs by itself: the
 *    extension takes each queued prompt, runs it in an AI Studio tab of the user's own signed-in Chrome / Edge and
 *    posts the picture back. Google refuses AI Studio in remote-controlled (CDP) browsers, so an extension is the
 *    only automatic route that works with the user's own account.
 *    Without the extension, "Send next" copies the prompt; images the user downloads land in their Downloads folder,
 *    which is watched while a prompt is waiting.
 *  - embedded: AI Studio inside a view in this window. Google refuses sign-in in embedded browsers for many accounts
 *    ("This browser or app may not be secure"), so this is only a fallback for sessions that already work.
 *
 * Capture is layout-independent:
 *  1. session 'will-download' -> every downloaded image is saved into the pending folder, then filed.
 *  2. CDP Network fallback   -> any image response >= 1024 px (googleusercontent / inline base64 in RPC JSON).
 * Captures are matched to the prompt queue in order and named after the planned name.
 */
export class SignInManager implements ExtHandler {
  private win: BrowserWindow | null = null
  private ext: { seen: number; info: ExtHelloInfo; pausedUntil: number; port: number; wasConnected: boolean } = {
    seen: 0,
    info: {},
    pausedUntil: 0,
    port: 0,
    wasConnected: false
  }
  private view: WebContentsView | null = null
  private viewBounds: Rect | null = null
  private items: PromptItem[] = []
  private seen = new Set<string>()
  private sessionReady = false
  private pendingRequests = new Map<string, { url: string; mime: string }>()
  private watcher: FSWatcher | null = null
  private watchedDir = ''
  private settle = new Map<string, NodeJS.Timeout>()
  private browserOpened = false

  constructor(
    private capturesDir: () => string,
    private loadPage: (win: BrowserWindow, page: 'signin') => void,
    private broadcast: Broadcast,
    private preload: string,
    private icon: string | undefined,
    /** %APPDATA%\Viku\gemini-queue.json: the prompt queue survives reloads and restarts */
    private queueFile: () => string,
    private modes: ModeOptions
  ) {
    this.load()
    // the extension says hello every ~30 s: notice when it goes away
    setInterval(() => {
      if (this.extConnected() !== this.ext.wasConnected) {
        this.ext.wasConnected = this.extConnected()
        this.pushState()
      }
    }, 10_000).unref()
  }

  // ---------- persistence ----------

  private load(): void {
    try {
      const f = this.queueFile()
      if (!existsSync(f)) return
      const data = JSON.parse(readFileSync(f, 'utf8')) as { items?: PromptItem[] }
      this.items = (data.items ?? []).filter((i) => i && typeof i.id === 'string' && typeof i.prompt === 'string')
    } catch {
      /* unreadable queue: start empty */
    }
  }

  private save(): void {
    try {
      const f = this.queueFile()
      mkdirSync(dirname(f), { recursive: true })
      const tmp = `${f}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, saved: new Date().toISOString(), items: this.items }, null, 2), 'utf8')
      renameSync(tmp, f)
    } catch {
      /* non-fatal: the queue still works in memory */
    }
  }

  open(card?: SignInCard): void {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore()
      this.win.focus()
      if (card) this.win.webContents.send(IPC.signinFocusCardEvt, card)
      return
    }
    const win = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 980,
      minHeight: 620,
      title: 'Viku — Sign in',
      backgroundColor: '#161719',
      icon: this.icon,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#1b1c1f', symbolColor: '#c9cbd1', height: 40 },
      show: false,
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false }
    })
    this.win = win
    win.once('ready-to-show', () => win.show())
    win.webContents.once('did-finish-load', () => {
      if (card) win.webContents.send(IPC.signinFocusCardEvt, card)
    })
    win.on('closed', () => {
      this.win = null
      this.view = null
      this.viewBounds = null
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    this.loadPage(win, 'signin')
  }

  // ---------- AI Studio view ----------

  private ses(): Session {
    const ses = session.fromPartition(PARTITION)
    if (!this.sessionReady) {
      this.sessionReady = true
      // A plain Chrome UA: Google refuses sign-in for UAs that advertise an embedded framework.
      const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
      ses.setUserAgent(ua)
      let t: NodeJS.Timeout | null = null
      ses.cookies.on('changed', (_e, cookie) => {
        if (!/google\.com$/.test(cookie.domain ?? '')) return
        if (t) clearTimeout(t)
        t = setTimeout(() => this.pushState(), 800)
      })
      ses.on('will-download', (_e, item) => {
        const dir = this.ensureDir(this.capturesDir())
        const tmp = join(dir, `.dl-${Date.now()}-${basename(item.getFilename() || 'image')}`)
        item.setSavePath(tmp)
        item.once('done', (_ev, state) => {
          if (state !== 'completed') return
          try {
            const buf = readFileSync(tmp)
            const info = imageInfo(buf)
            if (!info) {
              // not an image: keep it in the pending folder under its own name
              const keep = this.uniquePath(dir, basename(item.getFilename() || 'download'), '')
              renameSync(tmp, keep)
              this.toast({ kind: 'info', text: `Saved ${basename(keep)} to the captures folder` })
              return
            }
            const filed = this.file(buf, info.ext, 'download', info.width, info.height)
            unlinkSync(tmp)
            if (!filed) return
          } catch (err) {
            this.toast({ kind: 'error', text: `Download capture failed: ${String(err)}` })
          }
        })
      })
    }
    return ses
  }

  // ---------- browser mode ----------

  /** Start / stop / move the Downloads watcher to match the current mode and folder. */
  syncWatcher(): void {
    const want = this.modes.mode() === 'browser' ? this.modes.watchDir() : ''
    if (want === this.watchedDir && (this.watcher || !want)) return
    this.watcher?.close()
    this.watcher = null
    this.watchedDir = ''
    if (want && existsSync(want)) {
      try {
        this.watcher = watch(want, (_ev, fname) => {
          if (fname) this.onDownloadChange(join(want, fname.toString()))
        })
        this.watcher.on('error', () => {
          this.watcher?.close()
          this.watcher = null
          this.pushState()
        })
        this.watchedDir = want
      } catch {
        /* folder not watchable: state shows watching=false */
      }
    }
    this.pushState()
  }

  private onDownloadChange(p: string): void {
    // the browser writes *.crdownload / *.part first and renames to the final name when done
    if (!IMAGE_FILE.test(p)) return
    if (!this.items.some((i) => i.status === 'sent' && i.sentBy !== 'extension')) return
    const t = this.settle.get(p)
    if (t) clearTimeout(t)
    this.settle.set(
      p,
      setTimeout(() => {
        this.settle.delete(p)
        this.ingestDownload(p)
      }, 1200)
    )
  }

  private ingestDownload(p: string): void {
    try {
      const sent = this.items.filter((i) => i.status === 'sent' && i.sentBy !== 'extension')
      if (!sent.length || !existsSync(p)) return
      // only files that appeared after the oldest waiting prompt was sent (not old downloads being touched)
      const since = Math.min(...sent.map((i) => i.sentAt ?? i.queuedAt ?? 0))
      if (statSync(p).mtimeMs < since - 5000) return
      const buf = readFileSync(p)
      const info = imageInfo(buf)
      if (!info || Math.max(info.width, info.height) < MIN_SIDE) return
      // copied, the original stays in Downloads
      this.file(buf, info.ext, 'browser', info.width, info.height)
    } catch {
      /* still being written or locked: the next change event retries */
    }
  }

  openBrowser(): void {
    this.browserOpened = true
    void shell.openExternal(AISTUDIO)
  }

  setMode(mode: GeminiMode): Promise<GeminiViewState> {
    this.modes.saveMode(mode)
    if (mode === 'browser') this.view?.setVisible(false)
    this.syncWatcher()
    return this.state()
  }

  // ---------- embedded view ----------

  private ensureView(): WebContentsView | null {
    if (!this.win) return null
    if (this.view) return this.view
    const view = new WebContentsView({
      webPreferences: { session: this.ses(), contextIsolation: true, sandbox: true, nodeIntegration: false }
    })
    this.view = view
    this.win.contentView.addChildView(view)
    const wc = view.webContents
    wc.setWindowOpenHandler(({ url }) => {
      // Google account pop-ups stay inside the view (same partition, user types their own password).
      if (/^https:\/\/(accounts|aistudio)\.google\.com\//.test(url)) {
        void wc.loadURL(url)
      } else if (/^https:\/\//.test(url)) {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })
    const push = (): void => this.pushState()
    wc.on('did-start-loading', push)
    wc.on('did-stop-loading', push)
    wc.on('page-title-updated', push)
    wc.on('did-navigate', push)
    wc.on('did-navigate-in-page', push)
    this.attachNetworkCapture(wc)
    void wc.loadURL(AISTUDIO)
    return view
  }

  setGeminiBounds(bounds: Rect | null): void {
    this.viewBounds = bounds
    if (!bounds || this.modes.mode() !== 'embedded') {
      this.view?.setVisible(false)
      return
    }
    const view = this.ensureView()
    if (!view) return
    view.setVisible(true)
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height))
    })
    this.pushState()
  }

  nav(action: 'back' | 'forward' | 'reload' | 'home'): void {
    const wc = this.view?.webContents
    if (!wc) return
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    else if (action === 'reload') wc.reload()
    else if (action === 'home') void wc.loadURL(AISTUDIO)
  }

  async state(): Promise<GeminiViewState> {
    const wc = this.view?.webContents
    let signedIn = false
    try {
      const cookies = await this.ses().cookies.get({ domain: 'google.com' })
      signedIn = cookies.some((c) => c.name === 'SID' || c.name === '__Secure-1PSID')
    } catch {
      /* ignore */
    }
    return {
      open: Boolean(this.view && this.viewBounds),
      url: wc?.getURL() ?? '',
      loading: wc?.isLoading() ?? false,
      title: wc?.getTitle() ?? '',
      signedIn,
      mode: this.modes.mode(),
      watchDir: this.modes.watchDir(),
      watching: Boolean(this.watcher),
      extension: {
        connected: this.extConnected(),
        port: this.ext.port,
        version: this.ext.info.version,
        page: this.ext.info.page,
        state: this.ext.info.state,
        note: this.ext.info.note,
        pausedUntil: this.ext.pausedUntil > Date.now() ? this.ext.pausedUntil : 0,
        folder: this.modes.extensionFolder()
      }
    }
  }

  private pushState(): void {
    void this.state().then((s) => this.broadcast(IPC.signinStateEvt, s))
  }

  // ---------- CDP fallback ----------

  private attachNetworkCapture(wc: WebContents): void {
    const dbg = wc.debugger
    try {
      dbg.attach('1.3')
    } catch {
      return // DevTools already attached: download capture still works
    }
    void dbg.sendCommand('Network.enable', { maxResourceBufferSize: 64 * 1024 * 1024, maxTotalBufferSize: 256 * 1024 * 1024 })
    dbg.on('message', (_e, method: string, params: Record<string, unknown>) => {
      if (method === 'Network.responseReceived') {
        const response = params.response as { url: string; mimeType: string } | undefined
        const requestId = params.requestId as string
        if (!response) return
        const { url, mimeType } = response
        const googleImage = mimeType.startsWith('image/') && (/googleusercontent\.com/.test(url) || /^(data|blob):/.test(url))
        // AI Studio returns generated images inline as base64 inside its RPC JSON
        const rpc = /google(apis)?\.com/.test(url) && /(json|text|protobuf)/.test(mimeType)
        if (googleImage || rpc) this.pendingRequests.set(requestId, { url, mime: mimeType })
      } else if (method === 'Network.loadingFinished') {
        const requestId = params.requestId as string
        const meta = this.pendingRequests.get(requestId)
        if (!meta) return
        this.pendingRequests.delete(requestId)
        void (async () => {
          try {
            const res = (await dbg.sendCommand('Network.getResponseBody', { requestId })) as { body: string; base64Encoded: boolean }
            if (meta.mime.startsWith('image/')) {
              const buf = Buffer.from(res.body, res.base64Encoded ? 'base64' : 'binary')
              const info = imageInfo(buf)
              if (info && Math.max(info.width, info.height) >= MIN_SIDE) this.file(buf, info.ext, 'network', info.width, info.height)
            } else {
              const text = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body
              if (text.length < 100_000) return
              const re = /(iVBORw0KGgo[A-Za-z0-9+/=]{2000,}|\/9j\/[A-Za-z0-9+/=]{2000,}|UklGR[A-Za-z0-9+/=]{2000,})/g
              for (const m of text.matchAll(re)) {
                const buf = Buffer.from(m[1], 'base64')
                const info = imageInfo(buf)
                if (info && Math.max(info.width, info.height) >= MIN_SIDE) this.file(buf, info.ext, 'network', info.width, info.height)
              }
            }
          } catch {
            /* body evicted or not available */
          }
        })()
      } else if (method === 'Network.loadingFailed') {
        this.pendingRequests.delete(params.requestId as string)
      }
    })
    wc.once('destroyed', () => {
      try {
        dbg.detach()
      } catch {
        /* already gone */
      }
    })
  }

  // ---------- filing ----------

  private ensureDir(dir: string): string {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  private uniquePath(dir: string, name: string, ext: string): string {
    const stem = ext ? name : name.replace(/\.[^.]+$/, '')
    const suffix = ext ? `.${ext}` : extname(name)
    let p = join(dir, stem + suffix)
    let n = 2
    while (existsSync(p)) p = join(dir, `${stem}-${n++}${suffix}`)
    return p
  }

  /** Dedupe, match to the given prompt (or the oldest waiting one), write under its planned name. */
  private file(buf: Buffer, ext: string, via: CaptureVia, width: number, height: number, targetId?: string): string | null {
    const hash = createHash('sha1').update(buf).digest('hex')
    if (this.seen.has(hash)) return null
    this.seen.add(hash)
    // prompts the extension is running are only ever filled by the extension's own answer
    const target = targetId
      ? this.items.find((i) => i.id === targetId && i.status !== 'captured')
      : (this.items.find((i) => i.status === 'sent' && i.sentBy !== 'extension') ?? this.items.find((i) => i.status === 'queued'))
    const dir = this.ensureDir(target?.folder ?? this.capturesDir())
    const stem = target ? safeName(target.name) : `capture-${new Date().toISOString().replace(/[:.]/g, '-')}`
    const path = this.uniquePath(dir, stem, ext)
    writeFileSync(path, buf)
    if (target) {
      target.status = 'captured'
      target.file = path
      target.via = via
      this.emitQueue()
    }
    const ev: CaptureEvent = { promptId: target?.id, meta: target?.meta, file: path, via, width, height }
    this.broadcast(IPC.signinCaptureEvt, ev)
    this.toast({ kind: 'success', text: `Captured ${basename(path)} (${width}×${height}, ${via})` })
    return path
  }

  // ---------- prompt queue ----------

  queue(add: { prompt: string; name: string; folder?: string; meta?: GenMeta }[]): PromptItem[] {
    for (const a of add) {
      this.items.push({ id: randomUUID(), prompt: a.prompt, name: a.name, folder: a.folder, meta: a.meta, status: 'queued', queuedAt: Date.now() })
    }
    this.emitQueue()
    return this.items
  }

  markAttached(id: string): PromptItem[] {
    const it = this.items.find((i) => i.id === id)
    if (it?.meta) {
      it.meta = { ...it.meta, attached: true }
      this.emitQueue()
    }
    return this.items
  }

  list(): PromptItem[] {
    return this.items
  }

  remove(id: string): PromptItem[] {
    this.items = this.items.filter((i) => i.id !== id)
    this.emitQueue()
    return this.items
  }

  clearDone(): PromptItem[] {
    this.items = this.items.filter((i) => i.status !== 'captured')
    this.emitQueue()
    return this.items
  }

  async sendNext(): Promise<SendResult> {
    const item = this.items.find((i) => i.status === 'queued')
    if (!item) return { ok: false, method: 'none' }
    if (this.modes.mode() === 'browser' && this.extConnected()) {
      // the extension takes queued prompts by itself; "Send next" just lifts a pause after an AI Studio limit
      this.ext.pausedUntil = 0
      this.pushState()
      this.toast({ kind: 'info', text: 'The Viku extension is making these in your browser, one at a time — nothing to paste.' })
      return { ok: true, method: 'extension', item }
    }
    if (this.modes.mode() === 'browser') {
      clipboard.writeText(item.prompt)
      item.status = 'sent'
      item.sentBy = 'clipboard'
      item.sentAt = Date.now()
      this.emitQueue()
      this.syncWatcher()
      if (!this.browserOpened) this.openBrowser()
      this.toast({ kind: 'info', text: 'Prompt copied — paste it in AI Studio (Ctrl+V), run it, then download the image. Viku files it automatically.' })
      return { ok: true, method: 'clipboard', item }
    }
    const wc = this.view?.webContents
    const typed = wc ? await this.typePrompt(wc, item.prompt) : false
    if (typed) {
      item.status = 'sent'
      item.sentBy = 'typed'
      item.sentAt = Date.now()
      this.emitQueue()
      return { ok: true, method: 'typed', item }
    }
    clipboard.writeText(item.prompt)
    item.status = 'sent'
    item.sentBy = 'clipboard'
    item.sentAt = Date.now()
    this.emitQueue()
    this.toast({ kind: 'warn', text: 'Prompt copied — click the AI Studio prompt box, paste (Ctrl+V) and send' })
    return { ok: true, method: 'clipboard', item }
  }

  /** Generic heuristic: largest visible textarea / contenteditable → insertText → Ctrl+Enter. */
  private async typePrompt(wc: WebContents, prompt: string): Promise<boolean> {
    const focusScript = `(() => {
      const sel = 'textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], [role="textbox"]';
      const els = Array.from(document.querySelectorAll(sel)).filter((e) => {
        const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
        return r.width > 60 && r.height > 14 && s.visibility !== 'hidden' && s.display !== 'none' && !e.disabled && !e.readOnly;
      });
      if (!els.length) return false;
      els.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return rb.width * rb.height - ra.width * ra.height; });
      const el = els[0]; el.scrollIntoView({ block: 'center' }); el.focus();
      if (typeof el.select === 'function') el.select();
      else { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      return true;
    })()`
    const readScript = `(() => { const a = document.activeElement; if (!a) return ''; return (a.value ?? a.innerText ?? '').trim(); })()`
    try {
      const found = (await wc.executeJavaScript(focusScript, true)) as boolean
      if (!found) return false
      wc.focus()
      await wc.insertText(prompt)
      await sleep(250)
      const inBox = (await wc.executeJavaScript(readScript, true)) as string
      if (!inBox.includes(prompt.slice(0, Math.min(24, prompt.length)))) return false
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['control'] })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['control'] })
      await sleep(1200)
      const after = (await wc.executeJavaScript(readScript, true)) as string
      if (after.includes(prompt.slice(0, Math.min(24, prompt.length)))) {
        this.toast({ kind: 'warn', text: 'Prompt is in the box — press Ctrl+Enter (or Run) in AI Studio to send it' })
      }
      return true
    } catch {
      return false
    }
  }

  // ---------- Viku browser extension (called by ./extbridge) ----------

  setExtensionPort(port: number): void {
    this.ext.port = port
    this.pushState()
  }

  private extConnected(): boolean {
    return Date.now() - this.ext.seen < EXT_ALIVE_MS
  }

  /** extension prompts that never came back (tab closed, browser quit) return to the queue */
  private requeueStale(): void {
    let changed = false
    for (const i of this.items) {
      if (i.status === 'sent' && i.sentBy === 'extension' && Date.now() - (i.sentAt ?? 0) > EXT_STALE_MS) {
        i.status = 'queued'
        i.sentBy = undefined
        changed = true
      }
    }
    if (changed) this.emitQueue()
  }

  extHello(info: ExtHelloInfo): ExtHello {
    const first = !this.extConnected()
    this.ext.seen = Date.now()
    this.ext.info = { version: info.version, enabled: info.enabled, page: info.page, state: info.state, note: info.note }
    this.requeueStale()
    if (first) {
      this.ext.wasConnected = true
      if (this.modes.mode() === 'browser') this.toast({ kind: 'success', text: 'Viku extension connected — AI Studio pictures are made automatically in your browser' })
    }
    this.pushState()
    const enabled = this.modes.mode() === 'browser'
    const paused = this.ext.pausedUntil > Date.now()
    return {
      app: 'viku',
      version: '1',
      enabled,
      waiting: enabled && !paused ? this.items.filter((i) => i.status === 'queued').length : 0,
      model: EXT_MODEL,
      paused
    }
  }

  extNext(): { item: { id: string; prompt: string; name: string } | null; model: string } {
    this.ext.seen = Date.now()
    if (this.modes.mode() !== 'browser' || this.ext.pausedUntil > Date.now()) return { item: null, model: EXT_MODEL }
    // one at a time: nothing new while another extension prompt is still out
    this.requeueStale()
    if (this.items.some((i) => i.status === 'sent' && i.sentBy === 'extension')) return { item: null, model: EXT_MODEL }
    const item = this.items.find((i) => i.status === 'queued')
    if (!item) return { item: null, model: EXT_MODEL }
    item.status = 'sent'
    item.sentBy = 'extension'
    item.sentAt = Date.now()
    item.tries = (item.tries ?? 0) + 1
    item.error = undefined
    this.emitQueue()
    return { item: { id: item.id, prompt: item.prompt, name: item.name }, model: EXT_MODEL }
  }

  extResult(id: string, buf: Buffer): { ok: boolean; file?: string; error?: string } {
    this.ext.seen = Date.now()
    const info = imageInfo(buf)
    if (!info) return { ok: false, error: 'not an image' }
    if (Math.max(info.width, info.height) < MIN_SIDE) {
      this.extFail(id, `picture too small (${info.width}×${info.height})`, 'error')
      return { ok: false, error: 'too small' }
    }
    const file = this.file(buf, info.ext, 'extension', info.width, info.height, id)
    return file ? { ok: true, file } : { ok: false, error: 'duplicate picture' }
  }

  extFail(id: string, error: string, kind: string): { ok: boolean; pause: boolean } {
    this.ext.seen = Date.now()
    const item = this.items.find((i) => i.id === id)
    let pause = false
    if (kind === 'limit') {
      // AI Studio's own limit for this account: wait, then carry on with the same prompt
      pause = true
      this.ext.pausedUntil = Date.now() + 10 * 60_000
      this.toast({ kind: 'warn', text: `${error} — Viku waits 10 minutes, then carries on. Press Send next to try sooner.` })
    } else if (kind === 'attention') {
      pause = true
      this.ext.pausedUntil = Date.now() + 2 * 60_000
      this.toast({ kind: 'warn', text: 'AI Studio needs you in the browser (sign in or accept its terms) — the Viku tab is now in front.' })
    }
    if (item && item.status !== 'captured') {
      if (pause || (kind !== 'content' && (item.tries ?? 0) < 2)) {
        item.status = 'queued'
        item.sentBy = undefined
        if (pause) item.tries = Math.max(0, (item.tries ?? 1) - 1)
      } else {
        item.status = 'failed'
        if (kind === 'content') this.toast({ kind: 'error', text: `AI Studio would not draw “${item.name}”: ${error}` })
      }
      item.error = error
      this.emitQueue()
    }
    this.pushState()
    return { ok: true, pause }
  }

  private emitQueue(): void {
    this.save()
    this.broadcast(IPC.signinQueueEvt, this.items)
  }

  private toast(t: ToastMsg): void {
    this.broadcast(IPC.signinToastEvt, t)
  }
}

function safeName(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').replace(/\s+/g, '-').slice(0, 80) || 'image'
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
