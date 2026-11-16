import type { VikuBridge } from '../shared/ipc'

declare global {
  interface Window {
    /** Present inside Electron; undefined when the renderer is opened in a plain browser. */
    viku?: VikuBridge
  }
}

export {}
