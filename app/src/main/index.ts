import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell, screen } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { EngineManager } from './engine'
import { loadPrefs, publicPrefs, savePrefs } from './prefs'
import { SignInManager } from './signin'
import { IPC, type EngineRequest, type FileFilter, type Prefs, type Rect, type SignInCard } from '../shared/ipc'

const isDev = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL)
const PRELOAD = join(__dirname, '../preload/index.js')
const ICON = join(__dirname, '../../resources/icon.png')

app.setName('Viku')
// isolated profile for tests / screenshots
if (process.env.VIKU_USER_DATA) app.setPath('userData', process.env.VIKU_USER_DATA)
if (process.platform === 'win32') app.setAppUserModelId('org.viku.sermonreelstudio')

const engine = new EngineManager(publicPrefs)
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

const signin = new SignInManager(() => publicPrefs().capturesDir, loadPage, broadcast, PRELOAD, existsSync(ICON) ? ICON : undefined)

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
  ipcMain.handle(IPC.prefsGet, () => publicPrefs())
  ipcMain.handle(IPC.prefsSet, (_e, patch: Partial<Prefs>) => {
    const before = publicPrefs()
    savePrefs(patch)
    const after = publicPrefs()
    if (before.engineUrl !== after.engineUrl) void engine.restart()
    return after
  })
  ipcMain.handle(IPC.engineStatus, () => engine.status)
  ipcMain.handle(IPC.engineRestart, () => engine.restart())
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
  ipcMain.handle(IPC.signinQueue, (_e, items: { prompt: string; name: string; folder?: string }[]) => signin.queue(items))
  ipcMain.handle(IPC.signinList, () => signin.list())
  ipcMain.handle(IPC.signinSendNext, () => signin.sendNext())
  ipcMain.handle(IPC.signinRemove, (_e, id: string) => signin.remove(id))
  ipcMain.handle(IPC.signinClearDone, () => signin.clearDone())
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
    registerIpc()
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
