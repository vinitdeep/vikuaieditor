/* global window, document */
// Screenshots of the AI pictures drawer (main window) in its states, on the mock adapter with an isolated profile:
//   1. extension not set up (setup guide)   2. connected + working (done / making / waiting / failed rows)
// The extension is played by this script through the real bridge (POST with an extension Origin), so no browser
// is needed. Also checks that queuing pictures opens the DRAWER and never a second window.
// Usage: npm run build && node scripts/shots-ai-drawer.mjs
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shots = join(root, 'screenshots')
mkdirSync(shots, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[ai-drawer]', ...a)
const PORT = 47951
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

const work = mkdtempSync(join(tmpdir(), 'viku-ai-drawer-'))
const pic = join(work, 'pic.png')
execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'gradients=s=768x1376:c0=0x2b4d7a:c1=0xf0b450:d=1', '-frames:v', '1', pic])
const ext = async (path, body = {}) =>
  (await fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()

const app = await electron.launch({
  executablePath: require('electron'),
  args: [root],
  env: { ...process.env, VIKU_USER_DATA: join(work, 'profile'), VIKU_QUERY: 'debug=1&adapter=mock&no-onboarding=1', VIKU_NO_ENGINE: '1', VIKU_EXT_PORT: String(PORT) },
  timeout: 60000
})
let failed = null
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined)
  await page.waitForSelector('.topbar', { timeout: 90000 })
  await page.evaluate(() => window.viku.signin.setMode('browser'))

  // 1. not set up: queue two pictures the way the editor does -> the drawer opens, no second window
  await page.evaluate(async () => {
    const items = await window.viku.signin.queue([
      { prompt: 'VERTICAL 9:16 portrait... SCENE: a fisherman at sunrise', name: 'reel3-04-fisherman-sunrise', meta: { reelId: 'p1~3', index: 3, t0: 41.2, slug: '04-fisherman-sunrise' } },
      { prompt: 'VERTICAL 9:16 portrait... SCENE: mother praying', name: 'reel3-05-mother-prayer', meta: { reelId: 'p1~3', index: 4, t0: 52.8, slug: '05-mother-prayer' } }
    ])
    window.__viku?.openAiPanel?.()
    return items.length
  })
  await page.click('.schip >> text=AI pictures')
  await sleep(800)
  const windows1 = app.windows().length
  await page.screenshot({ path: join(shots, 'ai-drawer-setup.png') })
  log('setup state shot; windows open:', windows1)
  if (windows1 !== 1) throw new Error('a second window opened')
  if (!(await page.locator('.drawer.aip.open .ext-setup').count())) throw new Error('setup guide not shown')

  // 2. the "extension" connects and works through the queue
  await ext('/viku/hello', { version: '0.1.0', enabled: true, page: 'aistudio', state: 'idle' })
  await page.evaluate(async () => {
    await window.viku.signin.queue([
      { prompt: 'VERTICAL 9:16 portrait... SCENE: family walking to church', name: 'reel3-06-family-church', meta: { reelId: 'p1~3', index: 5, t0: 63.1, slug: '06-family-church' } },
      { prompt: 'VERTICAL 9:16 portrait... SCENE: farmer in rice field', name: 'reel3-07-farmer-field', meta: { reelId: 'p1~3', index: 6, t0: 70.4, slug: '07-farmer-field' } }
    ])
  })
  const a = await ext('/viku/next')
  await ext('/viku/result', { id: a.item.id, b64: readFileSync(pic).toString('base64') })
  const b = await ext('/viku/next')
  await ext('/viku/fail', { id: b.item.id, error: 'AI Studio: this picture was blocked by its safety filter', kind: 'content' })
  await ext('/viku/next') // now "Making…"
  await ext('/viku/hello', { version: '0.1.0', enabled: true, page: 'aistudio', state: 'working' })
  await sleep(1200)
  await page.screenshot({ path: join(shots, 'ai-drawer-working.png') })
  const head = await page.locator('.aip-headline').innerText()
  const rows = await page.locator('.aip-item').count()
  const thumbs = await page.locator('button.aip-thumb').count() // the finished picture (mock adapter shows a placeholder image)
  log('working state:', JSON.stringify({ head, rows, thumbs, windows: app.windows().length }))
  if (!/Making picture 2 of 3/.test(head) || rows !== 4 || thumbs !== 1 || app.windows().length !== 1) throw new Error('working state wrong')
  await page.locator('.aip-status').screenshot({ path: join(shots, 'ai-drawer-status.png') })

  // Escape closes the drawer
  await page.keyboard.press('Escape')
  await sleep(400)
  if (await page.locator('.drawer.aip.open').count()) throw new Error('Escape did not close the drawer')
  log('PASS')
} catch (e) {
  failed = e
} finally {
  await app.close().catch(() => undefined)
}
if (failed) {
  console.error('FAIL:', failed.message)
  process.exit(1)
}
