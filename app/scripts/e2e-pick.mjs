/* global window, document -- page.evaluate callbacks run in the renderer */
// End-to-end: Automate with 1 reel -> "Find 5 clips" -> 5 cards (title + length) -> preview one -> make one.
// Runs the dev build (out/) against an engine that already answers on VIKU_PORT (default 8765), on the user's data.
// Usage: npm run build && VIKU_PORT=8799 node scripts/e2e-pick.mjs [--video <path>] [--from 32:00 --to 36:00] [--len 60]
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
const arg = (k, d) => {
  const i = process.argv.indexOf(k)
  return i > 0 ? process.argv[i + 1] : d
}
const PORT = Number(process.env.VIKU_PORT) || 8765
const VIDEO = arg('--video', 'C:\\Users\\vinit\\Downloads\\Sunday Services _ TAPP Church _🌟JOURNEY OF FAITH — ବିଶ୍ୱାସର ଯାତ୍ରା.mp4')
const FROM = arg('--from', '32:00')
const TO = arg('--to', '36:00')
const LEN = Number(arg('--len', '60'))
const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const h = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json())
log('engine', h.version, 'on', PORT, 'data', h.data_dir)

const app = await electron.launch({
  executablePath: require('electron'),
  args: [root],
  // own Electron profile: a Viku window that is already open holds the single-instance lock on the normal one
  env: { ...process.env, VIKU_PORT: String(PORT), VIKU_USER_DATA: mkdtempSync(join(tmpdir(), 'viku-e2e-pick-')), VIKU_QUERY: 'debug=1&adapter=live&no-onboarding=1' },
  timeout: 60000
})
const page = await app.firstWindow()
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') {
    errors.push(m.text())
    log('console error:', m.text().slice(0, 300))
  }
})
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.unmaximize()
  w.setBounds({ x: 10, y: 10, width: 1680, height: 1000 })
})
await page.waitForSelector('.topbar', { timeout: 90000 })
await page.evaluate(() => document.fonts.ready)
const shot = async (name) => {
  await sleep(500)
  await page.screenshot({ path: join(shots, `pick-${name}.png`) })
  log('screenshot', `pick-${name}.png`)
}
const st = (fn, a) => page.evaluate(fn, a)
const waitJob = async (label, kindRe, timeoutMs, after = 0) => {
  const end = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    const j = await st(
      ([p, t]) => {
        const s = window.__viku.useJobs.getState()
        const id = s.order.find((i) => new RegExp(p).test(s.jobs[i].kind) && s.jobs[i].startedAt >= t)
        return id ? s.jobs[id] : null
      },
      [kindRe, after]
    )
    if (j) {
      const line = `${j.state} ${(j.progress * 100).toFixed(0)}% ${j.message}`
      if (line !== last) log(label, line)
      last = line
      if (j.state === 'done') return j
      if (j.state === 'error' || j.state === 'cancelled') throw new Error(`${label} failed: ${j.message}`)
    }
    if (Date.now() > end) throw new Error(`${label} timed out`)
    await sleep(2000)
  }
}

let failed = null
try {
  await st(() => window.__viku.useApp.getState().set({ mode: 'automate' }))
  await page.waitForSelector('.automate', { timeout: 10000 })
  await st(([v, len]) => window.__viku.useAuto.getState().setForm({ video_path: v, language: 'auto', count: 1, max_seconds: len }), [VIDEO, LEN])
  await page.fill('input[aria-label="Sermon part from"]', FROM)
  await page.fill('input[aria-label="Sermon part to"]', TO)
  await sleep(500)
  const btn = await page.textContent('.run-btn')
  log('run button:', btn)
  if (!/Find 5 clips/.test(btn ?? '')) throw new Error(`single-reel run button should offer the clip picker, got "${btn}"`)
  await shot('01-setup-single')
  const started = Date.now() - 5000
  await page.click('.run-btn')
  const j = await waitJob('find clips', '^automate$', 20 * 60_000, started)
  if (j.result?.stage !== 'pick') throw new Error(`expected a pick result, got ${JSON.stringify(j.result).slice(0, 200)}`)
  await page.waitForSelector('.ccard.pick', { timeout: 30000 })
  await sleep(1500)
  const cards = await page.$$eval('.ccard.pick', (els) =>
    els.map((e) => ({
      title: e.querySelector('.ccard-title')?.textContent,
      len: e.querySelector('.pick-dur')?.textContent,
      meta: e.querySelector('.pick-len .muted')?.textContent,
      short: Boolean(e.querySelector('.pick-short'))
    }))
  )
  log('clip cards:', JSON.stringify(cards, null, 1))
  if (cards.length !== 5) throw new Error(`expected 5 clip cards, got ${cards.length}`)
  const stages = await page.$$eval('.pstage', (els) => els.map((e) => `${e.className} | ${e.querySelector('.stage-detail')?.textContent}`))
  log('stages:', JSON.stringify(stages, null, 1))
  await page.$eval('.picks', (el) => el.scrollIntoView({ block: 'start' }))
  await shot('02-five-clips')

  // preview clip 1: the proxy plays its jump-cut segments
  await page.click('.ccard.pick >> nth=0 >> button[aria-label="Preview this clip"]')
  await sleep(4000)
  const pv = await page.$eval('.pick-video', (v) => ({ t: v.currentTime, paused: v.paused, err: v.error?.code ?? null, src: v.currentSrc.slice(0, 80) })).catch((e) => ({ missing: String(e) }))
  log('preview:', JSON.stringify(pv))
  await shot('03-preview')
  await page.click('.ccard.pick >> nth=0 >> button[aria-label="Stop preview"]').catch(() => undefined)

  // make clip 2
  const pickT = Date.now() - 2000
  await page.click('.ccard.pick >> nth=1 >> button:has-text("Make this reel")')
  await sleep(2500)
  await shot('04-making')
  const b = await waitJob('make reel', '^automate_build$', 20 * 60_000, pickT)
  log('build result:', JSON.stringify(b.result).slice(0, 500))
  await page.waitForSelector('.rcard', { timeout: 60000 })
  await sleep(3000)
  await shot('05-reel-ready')
  const made = await page.$$eval('.rcard', (els) => els.map((e) => `${e.querySelector('.rcard-title')?.textContent} · ${e.querySelector('.rcard-meta')?.textContent}`))
  log('reel cards:', JSON.stringify(made))
  const madeBtn = await page.$$eval('.ccard.pick', (els) => els.map((e) => e.querySelector('footer button:last-child')?.textContent))
  log('pick buttons after:', JSON.stringify(madeBtn))
  await page.$eval('.picks', (el) => el.scrollIntoView({ block: 'start' }))
  await shot('06-picks-after')
} catch (e) {
  failed = e
  log('FAILED:', e instanceof Error ? e.stack : String(e))
  await page.screenshot({ path: join(shots, 'pick-zz-failure.png') }).catch(() => undefined)
}
log('console errors:', errors.length)
await app.close()
process.exit(failed ? 1 : 0)
