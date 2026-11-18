/* global window -- page callbacks run in the renderer */
// LIVE check of the Viku browser extension with the REAL Google AI Studio, in the user's own signed-in Chrome / Edge
// (the extension must be loaded there: chrome://extensions -> Developer mode -> Load unpacked -> <repo>/extension).
// Starts Viku from this checkout with its own profile (the installed Viku is untouched), queues the given prompts
// and waits until the extension has made each one. No Google credential is used by this script.
// Usage: npm run build && node scripts/e2e-extension-live.mjs ["prompt" ...]
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const prompts = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'Warm painted illustration, vertical 9:16 portrait: an Indian fisherman pulling a net at sunrise on a calm river, hopeful mood, no text, no letters',
      'Warm painted illustration, vertical 9:16 portrait: a mother and child praying together by an oil lamp in a village home, peaceful, no text, no letters'
    ]

const work = mkdtempSync(join(tmpdir(), 'viku-ext-live-'))
const app = await electron.launch({
  executablePath: require('electron'),
  args: [root],
  env: { ...process.env, VIKU_USER_DATA: join(work, 'profile'), VIKU_QUERY: 'adapter=mock&no-onboarding=1', VIKU_NO_ENGINE: '1' },
  timeout: 60000
})
const page = await app.firstWindow()
await page.waitForSelector('.topbar', { timeout: 90000 })
const st = (fn, a) => page.evaluate(fn, a)
let code = 1
try {
  await st(() => window.viku.signin.setMode('browser'))
  let s = await st(() => window.viku.signin.geminiState())
  log('bridge port', s.extension.port, '- waiting for the extension in your browser (up to 2 min)...')
  for (let i = 0; i < 120 && !s.extension.connected; i++) {
    await sleep(1000)
    s = await st(() => window.viku.signin.geminiState())
  }
  if (!s.extension.connected) throw new Error('the extension did not connect - is it loaded in Chrome / Edge, and that browser open?')
  log('extension connected, v' + s.extension.version)
  await st((ps) => window.viku.signin.queue(ps.map((p, i) => ({ prompt: p, name: `live-${String(i + 1).padStart(2, '0')}` }))), prompts)
  let q = []
  let last = ''
  const until = Date.now() + 6 * 60000
  while (Date.now() < until) {
    await sleep(2000)
    q = await st(() => window.viku.signin.list())
    s = await st(() => window.viku.signin.geminiState())
    const line = JSON.stringify(q.map((i) => [i.name, i.status, i.error ?? ''])) + ` ext:${s.extension.state}${s.extension.note ? ' ' + s.extension.note : ''}`
    if (line !== last) log(line)
    last = line
    if (q.every((i) => i.status === 'captured' || i.status === 'failed') || s.extension.pausedUntil) break
  }
  for (const i of q.filter((x) => x.file)) {
    const b = readFileSync(i.file)
    log('  saved', i.file, (b.length / 1024).toFixed(0) + ' KB')
  }
  code = q.every((i) => i.status === 'captured') ? 0 : 1
  log(code ? 'NOT all pictures made' : `PASS - ${q.length} pictures made in AI Studio by the extension`)
  log('pictures folder:', dirname(q[0]?.file ?? join(work, 'profile')), basename(work))
} catch (e) {
  console.error('FAIL:', e.message)
} finally {
  await app.close().catch(() => undefined)
}
process.exit(code)
