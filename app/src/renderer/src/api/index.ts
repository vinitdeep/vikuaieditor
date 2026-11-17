import type { VikuApi } from './client'
import { HttpApi } from './http'
import { MockApi } from './mock'

export type { VikuApi } from './client'

let current: VikuApi | null = null

/** Pick the adapter: prefs.adapter (auto|mock|live), overridable with ?adapter= for screenshots/tests. */
/** In auto mode, give an engine that Electron is still starting a chance before falling back to mock data. */
async function waitForEngine(onWait?: (msg: string) => void): Promise<void> {
  const bridge = window.viku
  if (!bridge) return
  const s = await bridge.engine.status()
  if (s.state !== 'checking' && s.state !== 'starting') return
  onWait?.(s.state === 'starting' ? 'Starting the engine…' : 'Looking for the engine…')
  await new Promise<void>((done) => {
    const timer = setTimeout(finish, 45000)
    const off = bridge.engine.onStatus((n) => {
      if (n.state === 'starting') onWait?.('Starting the engine…')
      if (n.state === 'running' || n.state === 'error' || n.state === 'stopped') finish()
    })
    function finish(): void {
      clearTimeout(timer)
      off()
      done()
    }
  })
}

export async function initApi(onWait?: (msg: string) => void): Promise<VikuApi> {
  const prefs = window.viku ? await window.viku.prefs.get() : null
  const base = (prefs?.engineUrl ?? 'http://127.0.0.1:8765').replace(/\/$/, '')
  const override = new URLSearchParams(location.search).get('adapter')
  const mode = override === 'mock' || override === 'live' ? override : (prefs?.adapter ?? 'auto')
  if (mode === 'mock') current = new MockApi()
  else if (mode === 'live') current = new HttpApi(base)
  else {
    await waitForEngine(onWait)
    const live = new HttpApi(base)
    const ok = await Promise.race([
      live.health().then(
        () => true,
        () => false
      ),
      new Promise<boolean>((r) => setTimeout(() => r(false), 1800))
    ])
    current = ok ? live : new MockApi()
  }
  return current
}

export function api(): VikuApi {
  if (!current) throw new Error('API not initialised')
  return current
}
