/* global window -- page.evaluate callbacks run in the renderer */
// Automate's two tabs on the mock adapter (no engine needed): "Find 5 clips" sends pick=5 and shows the clip cards;
// "Make reels" with 1 reel sends no pick and makes the reel straight away.
// Usage: npm run build && node scripts/e2e-auto-tabs.mjs
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shots = join(root, 'screenshots')
mkdirSync(shots, { recursive: true })
const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const app = await electron.launch({
  executablePath: require('electron'),
  args: [root],
  env: { ...process.env, VIKU_USER_DATA: mkdtempSync(join(tmpdir(), 'viku-e2e-tabs-')), VIKU_QUERY: 'debug=1&adapter=mock&no-onboarding=1' },
  timeout: 60000
})
const page = await app.firstWindow()
const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.unmaximize()
  w.setBounds({ x: 10, y: 10, width: 1680, height: 1000 })
})
await page.waitForSelector('.topbar', { timeout: 90000 })
const st = (fn, a) => page.evaluate(fn, a)
const shot = async (name) => {
  await sleep(500)
  await page.screenshot({ path: join(shots, `tabs-${name}.png`) })
  log('screenshot', `tabs-${name}.png`)
}
const waitDone = async (kind) => {
  for (let i = 0; i < 120; i++) {
    const j = await st((k) => {
      const s = window.__viku.useJobs.getState()
      const id = s.order.find((x) => s.jobs[x].kind === k)
      return id ? s.jobs[id].state : null
    }, kind)
    if (j === 'done') return
    if (j === 'error' || j === 'cancelled') throw new Error(`${kind} ${j}`)
    await sleep(500)
  }
  throw new Error(`${kind} timed out`)
}

let failed = null
try {
  await st(() => window.__viku.useApp.getState().set({ mode: 'automate' }))
  await page.waitForSelector('.auto-tabs', { timeout: 10000 })
  // record what the app sends to the engine
  await st(() => {
    const a = window.__viku.api()
    const orig = a.automate.bind(a)
    window.__sent = []
    a.automate = (body) => {
      window.__sent.push(JSON.parse(JSON.stringify(body)))
      return orig(body)
    }
  })
  await st(() => window.__viku.useAuto.getState().setForm({ video_path: 'D:\\Sermons\\Before the Foundation.mp4', count: 3 }))

  const tabs = await page.$$eval('.auto-tab', (els) => els.map((e) => `${e.getAttribute('aria-selected')} ${e.querySelector('b')?.textContent}`))
  log('tabs:', JSON.stringify(tabs))
  if (tabs.length !== 2 || !tabs[0].startsWith('true Find 5 clips')) throw new Error('expected 2 tabs with "Find 5 clips" selected')
  if (await page.$('[aria-label="Fewer reels"]')) throw new Error('"How many" should be hidden on the Find clips tab')
  let btn = await page.textContent('.run-btn')
  if (!/Find 5 clips/.test(btn)) throw new Error(`run button on tab 1: ${btn}`)
  await shot('01-find-clips')

  await page.click('.run-btn')
  await waitDone('automate')
  await page.waitForSelector('.ccard.pick', { timeout: 15000 })
  const cards = await page.$$eval('.ccard.pick', (els) => els.length)
  const sent1 = await st(() => window.__sent.at(-1))
  log('tab 1 sent:', JSON.stringify({ pick: sent1.pick, count: sent1.count }), 'cards:', cards)
  if (sent1.pick !== 5 || cards < 1) throw new Error('Find clips should send pick=5 and show clip cards')

  // tab 2: make 1 reel straight away
  await page.$eval('.auto-tabs', (el) => el.scrollIntoView({ block: 'start' }))
  await page.click('.auto-tab:nth-child(2)')
  await page.waitForSelector('[aria-label="Fewer reels"]', { timeout: 5000 })
  for (let i = 0; i < 5; i++) await page.click('[aria-label="Fewer reels"]')
  btn = await page.textContent('.run-btn')
  const tab2 = await page.textContent('.auto-tab.on b')
  log('tab 2:', tab2, '| button:', btn)
  if (btn.trim() !== 'Make 1 reel' || tab2 !== 'Make 1 reel') throw new Error(`expected "Make 1 reel", got tab "${tab2}" button "${btn}"`)
  await shot('02-make-1-reel')
  await st(() => window.__viku.useJobs.getState().clearFinished?.())
  await page.click('.run-btn')
  await sleep(500)
  await waitDone('automate')
  const sent2 = await st(() => window.__sent.at(-1))
  const after = await st(() => {
    const a = window.__viku.useAuto.getState()
    return { phase: a.phase, picks: a.picks?.items.length ?? 0, results: a.results.length }
  })
  log('tab 2 sent:', JSON.stringify({ pick: sent2.pick ?? null, count: sent2.count }), 'state:', JSON.stringify(after))
  if (sent2.pick || sent2.count !== 1) throw new Error('Make reels must send count 1 and no pick')
  if (after.phase !== 'run' || after.results !== 1) throw new Error('Make 1 reel should make one reel straight away')
  await sleep(1000)
  await shot('03-made-1-reel')
} catch (e) {
  failed = e
  log('FAILED:', e instanceof Error ? e.stack : String(e))
  await page.screenshot({ path: join(shots, 'tabs-zz-failure.png') }).catch(() => undefined)
}
log('console errors:', errors.length, errors.slice(0, 3))
await app.close()
process.exit(failed ? 1 : 0)
