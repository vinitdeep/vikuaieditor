import type { VikuApi } from './client'
import { HttpApi } from './http'
import { MockApi } from './mock'

export type { VikuApi } from './client'

let current: VikuApi | null = null

/** Pick the adapter: prefs.adapter (auto|mock|live), overridable with ?adapter= for screenshots/tests. */
export async function initApi(): Promise<VikuApi> {
  const prefs = window.viku ? await window.viku.prefs.get() : null
  const base = (prefs?.engineUrl ?? 'http://127.0.0.1:8765').replace(/\/$/, '')
  const override = new URLSearchParams(location.search).get('adapter')
  const mode = override === 'mock' || override === 'live' ? override : (prefs?.adapter ?? 'auto')
  if (mode === 'mock') current = new MockApi()
  else if (mode === 'live') current = new HttpApi(base)
  else {
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
