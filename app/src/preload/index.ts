import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type VikuBridge, type Unsubscribe } from '../shared/ipc'

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const bridge: VikuBridge = {
  platform: process.platform,
  versions: {
    app: process.env.npm_package_version ?? '0.1.0',
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? ''
  },
  prefs: {
    get: () => ipcRenderer.invoke(IPC.prefsGet),
    set: (patch) => ipcRenderer.invoke(IPC.prefsSet, patch)
  },
  engine: {
    status: () => ipcRenderer.invoke(IPC.engineStatus),
    restart: () => ipcRenderer.invoke(IPC.engineRestart),
    start: () => ipcRenderer.invoke(IPC.engineStart),
    request: (req) => ipcRenderer.invoke(IPC.engineRequest, req),
    onStatus: (cb) => on(IPC.engineStatusEvt, cb),
    onEvent: (cb) => on(IPC.engineEvent, cb)
  },
  dialog: {
    openFile: (opts) => ipcRenderer.invoke(IPC.openFile, opts),
    openFolder: (title) => ipcRenderer.invoke(IPC.openFolder, title)
  },
  shell: {
    reveal: (path) => ipcRenderer.invoke(IPC.reveal, path),
    openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url)
  },
  signin: {
    open: (card) => ipcRenderer.invoke(IPC.signinOpen, card),
    setGeminiBounds: (bounds) => ipcRenderer.invoke(IPC.signinBounds, bounds),
    geminiNav: (action) => ipcRenderer.invoke(IPC.signinNav, action),
    geminiState: () => ipcRenderer.invoke(IPC.signinState),
    queue: (items) => ipcRenderer.invoke(IPC.signinQueue, items),
    list: () => ipcRenderer.invoke(IPC.signinList),
    sendNext: () => ipcRenderer.invoke(IPC.signinSendNext),
    remove: (id) => ipcRenderer.invoke(IPC.signinRemove, id),
    clearDone: () => ipcRenderer.invoke(IPC.signinClearDone),
    onQueue: (cb) => on(IPC.signinQueueEvt, cb),
    onCapture: (cb) => on(IPC.signinCaptureEvt, cb),
    onToast: (cb) => on(IPC.signinToastEvt, cb),
    onGeminiState: (cb) => on(IPC.signinStateEvt, cb),
    onFocusCard: (cb) => on(IPC.signinFocusCardEvt, cb)
  }
}

contextBridge.exposeInMainWorld('viku', bridge)
