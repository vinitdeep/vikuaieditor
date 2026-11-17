import type { VikuApi } from './client'
import { HttpApi } from './http'
import { MockApi } from './mock'

export type { VikuApi } from './client'

// Kept on globalThis, not in module scope: a dev hot reload re-runs this module (any edit under api/ does), and a
// module-level `let` would come back null while the app stays booted -> "API not initialised" on the next call.
const slot = globalThis as typeof globalThis & { __vikuApi?: VikuApi | null }
let current: VikuApi | null = slot.__vikuApi ?? null
const keep = (a: VikuApi): VikuApi => {
  current = a
  slot.__vikuApi = a
  return a
}

/** Pick the adapter: prefs.adapter (auto|mock|live), overridable with ?adapter= for screenshots/tests. */
/** In auto mode, give an engine that Electron is still starting a chance before falling back to mock data. */
async function waitForEngine(onWait?: (msg: string) => void): Promise<void> {
  const bridge = window.viku
  if (!bridge) return
  const s = await bridge.engine.status()
  if (s.state !== 'checking' && s.state !== 'starting' && s.state !== 'setup') return
  onWait?.(s.state === 'starting' ? 'Starting the engine…' : 'Looking for the engine…')
  await new Promise<void>((done) => {
    // first-launch setup (bootstrap) can take minutes: the timer only runs outside it
    let timer = s.state === 'setup' ? null : setTimeout(finish, 45000)
    const off = bridge.engine.onStatus((n) => {
      if (n.state === 'setup') {
        if (timer) clearTimeout(timer)
        timer = null
      } else if (!timer && (n.state === 'starting' || n.state === 'checking')) timer = setTimeout(finish, 90000)
      if (n.state === 'starting') onWait?.('Starting the engine…')
      if (n.state === 'running' || n.state === 'error' || n.state === 'stopped') finish()
    })
    function finish(): void {
      if (timer) clearTimeout(timer)
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
  if (mode === 'mock') return keep(new MockApi())
  if (mode === 'live') return keep(new HttpApi(base))
  await waitForEngine(onWait)
  const live = new HttpApi(base)
  const ok = await Promise.race([
    live.health().then(
      () => true,
      () => false
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), 1800))
  ])
  return keep(ok ? live : new MockApi())
}

export function api(): VikuApi {
  const a = current ?? slot.__vikuApi
  if (!a) throw new Error('API not initialised')
  return a
}
