import { BrowserWindow, WebContentsView, clipboard, session, shell, type Session, type WebContents } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { imageInfo } from './imageSize'
import {
  IPC,
  type CaptureEvent,
  type CaptureVia,
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

/**
 * Sign-in window + Google AI Studio capture.
 * The user signs in to Google themselves inside the view: we never fill credentials or store passwords.
 *
 * Capture is layout-independent:
 *  1. session 'will-download' -> every downloaded image is saved into the pending folder, then filed.
 *  2. CDP Network fallback   -> any image response >= 1024 px (googleusercontent / inline base64 in RPC JSON).
 * Captures are matched to the prompt queue in order and named after the planned name.
 */
export class SignInManager {
  private win: BrowserWindow | null = null
  private view: WebContentsView | null = null
  private viewBounds: Rect | null = null
  private items: PromptItem[] = []
  private seen = new Set<string>()
  private sessionReady = false
  private pendingRequests = new Map<string, { url: string; mime: string }>()

  constructor(
    private capturesDir: () => string,
    private loadPage: (win: BrowserWindow, page: 'signin') => void,
    private broadcast: Broadcast,
    private preload: string,
    private icon?: string
  ) {}

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
    if (!bounds) {
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
      signedIn
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

  /** Dedupe, match to the oldest waiting prompt, write under its planned name. */
  private file(buf: Buffer, ext: string, via: CaptureVia, width: number, height: number): string | null {
    const hash = createHash('sha1').update(buf).digest('hex')
    if (this.seen.has(hash)) return null
    this.seen.add(hash)
    const target = this.items.find((i) => i.status === 'sent') ?? this.items.find((i) => i.status === 'queued')
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
    const ev: CaptureEvent = { promptId: target?.id, file: path, via, width, height }
    this.broadcast(IPC.signinCaptureEvt, ev)
    this.toast({ kind: 'success', text: `Captured ${basename(path)} (${width}×${height}, ${via})` })
    return path
  }

  // ---------- prompt queue ----------

  queue(add: { prompt: string; name: string; folder?: string }[]): PromptItem[] {
    for (const a of add) {
      this.items.push({ id: randomUUID(), prompt: a.prompt, name: a.name, folder: a.folder, status: 'queued' })
    }
    this.emitQueue()
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
    const wc = this.view?.webContents
    const typed = wc ? await this.typePrompt(wc, item.prompt) : false
    if (typed) {
      item.status = 'sent'
      this.emitQueue()
      return { ok: true, method: 'typed', item }
    }
    clipboard.writeText(item.prompt)
    item.status = 'sent'
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

  private emitQueue(): void {
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
