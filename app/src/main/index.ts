import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell, screen } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { bundlePaths } from './bundle'
import { EngineManager } from './engine'
import { loadPrefs, publicPrefs, savePrefs } from './prefs'
import { SignInManager } from './signin'
import { startExtBridge } from './extbridge'
import { handleThumbs, registerThumbScheme } from './thumbs'
import { IPC, type AppInfo, type EngineRequest, type FileFilter, type GenMeta, type GeminiMode, type Prefs, type Rect, type SignInCard } from '../shared/ipc'

const isDev = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL)
const PRELOAD = join(__dirname, '../preload/index.js')
const ICON = join(__dirname, '../../resources/icon.png')

app.setName('Viku')
// isolated profile for tests / screenshots; otherwise the app shares the engine's data folder (%APPDATA%\Viku, or VIKU_DATA)
if (process.env.VIKU_USER_DATA) app.setPath('userData', process.env.VIKU_USER_DATA)
else if (process.env.VIKU_DATA) app.setPath('userData', process.env.VIKU_DATA)
if (process.platform === 'win32') app.setAppUserModelId('org.viku.sermonreelstudio')
// small cached JPEGs of library images (must be registered before ready)
registerThumbScheme()

const engine = new EngineManager(publicPrefs, app.isPackaged)
let mainWin: BrowserWindow | null = null
let quitting = false

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

function loadPage(win: BrowserWindow, page: 'index' | 'signin'): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  // VIKU_QUERY (e.g. "adapter=mock&debug=1") is passed through for screenshots / tests
  const query = process.env.VIKU_QUERY ?? ''
  if (isDev && devUrl) void win.loadURL(`${devUrl}/${page}.html${query ? `?${query}` : ''}`)
  else void win.loadFile(join(__dirname, `../renderer/${page}.html`), query ? { search: query } : undefined)
}

const signin = new SignInManager(
  () => publicPrefs().capturesDir,
  loadPage,
  broadcast,
  PRELOAD,
  existsSync(ICON) ? ICON : undefined,
  () => join(app.getPath('userData'), 'gemini-queue.json'),
  {
    mode: () => publicPrefs().geminiMode,
    watchDir: () => publicPrefs().downloadsDir,
    saveMode: (geminiMode) => void savePrefs({ geminiMode }),
    // the unpacked browser extension: <resources>/extension when installed, <repo>/extension in dev
    extensionFolder: () => (app.isPackaged ? join(process.resourcesPath, 'extension') : resolve(app.getAppPath(), '..', 'extension'))
  }
)

function readText(p: string): string | undefined {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

function appInfo(): AppInfo {
  const packaged = app.isPackaged
  const b = packaged ? bundlePaths() : null
  const uvDir = packaged ? join(process.resourcesPath, 'uv') : resolve(app.getAppPath(), 'vendor', 'uv')
  const installDir = dirname(app.getPath('exe'))
  const uvVersion = readText(join(uvDir, 'VERSION.txt'))?.split(/\r?\n/)[0]?.trim()
  return {
    name: 'Viku',
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    packaged,
    userData: app.getPath('userData'),
    engineEnv: b?.env,
    uv: uvVersion ? `uv ${uvVersion}` : undefined,
    shellLicences: [
      { name: 'Electron', licence: 'MIT', url: 'https://github.com/electron/electron/blob/main/LICENSE', text: packaged ? readText(join(installDir, 'LICENSE.electron.txt')) : undefined },
      { name: 'Chromium (inside Electron)', licence: 'BSD-3-Clause and others', url: 'https://source.chromium.org/chromium/chromium/src/+/main:LICENSE' },
      { name: 'uv (bundled package manager)', licence: 'MIT OR Apache-2.0', url: 'https://github.com/astral-sh/uv', text: readText(join(uvDir, 'LICENSE-MIT')) },
      { name: 'React / React DOM', licence: 'MIT', url: 'https://github.com/facebook/react/blob/main/LICENSE' },
      { name: 'Zustand', licence: 'MIT', url: 'https://github.com/pmndrs/zustand/blob/main/LICENSE' },
      { name: 'Immer', licence: 'MIT', url: 'https://github.com/immerjs/immer/blob/main/LICENSE' },
      { name: 'Lucide icons', licence: 'ISC', url: 'https://github.com/lucide-icons/lucide/blob/main/LICENSE' },
      { name: 'Inter (UI font)', licence: 'OFL-1.1', url: 'https://github.com/rsms/inter/blob/master/LICENSE.txt' },
      { name: 'Noto Sans Oriya / Devanagari (UI fonts)', licence: 'OFL-1.1', url: 'https://github.com/notofonts/notofonts.github.io/blob/main/LICENSE' }
    ]
  }
}

function boundsOnScreen(b: Rect | undefined): Rect | undefined {
  if (!b) return undefined
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return b.x + 100 < a.x + a.width && b.y + 40 < a.y + a.height && b.x + b.width > a.x + 100 && b.y > a.y - 10
  })
  return visible ? b : undefined
}

function createMainWindow(): void {
  const stored = loadPrefs().windowBounds
  const b = boundsOnScreen(stored)
  const win = new BrowserWindow({
    width: b?.width ?? 1600,
    height: b?.height ?? 980,
    x: b?.x,
    y: b?.y,
    minWidth: 1180,
    minHeight: 720,
    title: 'Viku',
    backgroundColor: '#161719',
    icon: existsSync(ICON) ? nativeImage.createFromPath(ICON) : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1b1c1f', symbolColor: '#c9cbd1', height: 40 },
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  mainWin = win
  if (stored?.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  const remember = (): void => {
    if (win.isDestroyed()) return
    const maximized = win.isMaximized()
    const nb = maximized ? (loadPrefs().windowBounds ?? win.getBounds()) : win.getBounds()
    savePrefs({ windowBounds: { ...nb, maximized } })
  }
  win.on('resized', remember)
  win.on('moved', remember)
  win.on('maximize', remember)
  win.on('unmaximize', remember)
  win.on('closed', () => {
    mainWin = null
    // closing the editor quits the app (the sign-in window is secondary)
    if (!quitting) app.quit()
  })
  loadPage(win, 'index')
}

function registerIpc(): void {
  ipcMain.handle(IPC.appInfo, () => appInfo())
  ipcMain.handle(IPC.engineSetupRetry, () => engine.setupRetry())
  ipcMain.handle(IPC.prefsGet, () => publicPrefs())
  ipcMain.handle(IPC.prefsSet, (_e, patch: Partial<Prefs>) => {
    const before = publicPrefs()
    savePrefs(patch)
    const after = publicPrefs()
    if (before.engineUrl !== after.engineUrl || before.engineSource !== after.engineSource) void engine.restart()
    if (before.downloadsDir !== after.downloadsDir || before.geminiMode !== after.geminiMode) signin.syncWatcher()
    return after
  })
  ipcMain.handle(IPC.engineStatus, () => engine.status)
  ipcMain.handle(IPC.engineRestart, () => engine.restart())
  ipcMain.handle(IPC.engineStart, () => engine.start())
  ipcMain.handle(IPC.engineRequest, (_e, req: EngineRequest) => {
    if (!req || typeof req.path !== 'string' || !req.path.startsWith('/')) {
      return { ok: false, status: 0, data: null, error: 'bad request path' }
    }
    return engine.request(req)
  })
  ipcMain.handle(IPC.openFile, async (e, opts: { title?: string; filters?: FileFilter[]; multi?: boolean }) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const props: ('openFile' | 'multiSelections')[] = opts?.multi ? ['openFile', 'multiSelections'] : ['openFile']
    const res = win
      ? await dialog.showOpenDialog(win, { title: opts?.title, filters: opts?.filters, properties: props })
      : await dialog.showOpenDialog({ title: opts?.title, filters: opts?.filters, properties: props })
    return res.canceled ? [] : res.filePaths
  })
  ipcMain.handle(IPC.openFolder, async (e, title?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const opts = { title, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.reveal, (_e, p: string) => {
    if (typeof p === 'string' && p) shell.showItemInFolder(p)
  })
  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) await shell.openExternal(url)
  })
  ipcMain.handle(IPC.signinOpen, (_e, card?: SignInCard) => signin.open(card))
  ipcMain.handle(IPC.signinBounds, (_e, b: Rect | null) => signin.setGeminiBounds(b))
  ipcMain.handle(IPC.signinNav, (_e, a: 'back' | 'forward' | 'reload' | 'home') => signin.nav(a))
  ipcMain.handle(IPC.signinState, () => signin.state())
  ipcMain.handle(IPC.signinQueue, (_e, items: { prompt: string; name: string; folder?: string; meta?: GenMeta }[]) => signin.queue(items))
  ipcMain.handle(IPC.signinMarkAttached, (_e, id: string) => signin.markAttached(id))
  ipcMain.handle(IPC.signinList, () => signin.list())
  ipcMain.handle(IPC.signinSendNext, () => signin.sendNext())
  ipcMain.handle(IPC.signinRemove, (_e, id: string) => signin.remove(id))
  ipcMain.handle(IPC.signinClearDone, () => signin.clearDone())
  ipcMain.handle(IPC.signinMode, (_e, m: GeminiMode) => signin.setMode(m === 'embedded' ? 'embedded' : 'browser'))
  ipcMain.handle(IPC.signinOpenBrowser, () => signin.openBrowser())
  ipcMain.handle(IPC.signinRevealExtension, async () => {
    const s = await signin.state()
    if (existsSync(s.extension.folder)) await shell.openPath(s.extension.folder)
  })
}

engine.on('status', (s) => broadcast(IPC.engineStatusEvt, s))
engine.on('event', (d) => broadcast(IPC.engineEvent, d))

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore()
      mainWin.focus()
    }
  })
  void app.whenReady().then(() => {
    handleThumbs(() => join(app.getPath('userData'), 'thumbs'))
    registerIpc()
    signin.syncWatcher()
    // local bridge for the Viku browser extension (127.0.0.1 only, extension origins only)
    void startExtBridge(signin).then((port) => signin.setExtensionPort(port ?? 0))
    createMainWindow()
    if (process.env.VIKU_OPEN_SIGNIN) signin.open()
    // VIKU_NO_ENGINE=1: never spawn the engine (still connects to one that is already running)
    void engine.ensure()
  })
}

app.on('before-quit', (e) => {
  if (quitting) return
  quitting = true
  if (engine.status.spawned) {
    e.preventDefault()
    void engine.kill().finally(() => app.quit())
  }
})

app.on('window-all-closed', () => {
  app.quit()
})
