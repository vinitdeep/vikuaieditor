/* global window -- page.evaluate callbacks run in the renderer */
// End-to-end: auto framing in Manual mode on an existing reel -> switch to "Follow speaker" -> Track speaker ->
// the preview pans with the speaker -> nudge -> render. Also screenshots the Automate option.
// Runs the dev build (out/) against an engine that already answers on VIKU_PORT, on the user's data.
// Usage: npm run build && VIKU_PORT=8799 node scripts/e2e-framing.mjs --reel <project id>~<n> [--no-render]
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
const REEL = arg('--reel', '')
const RENDER = !process.argv.includes('--no-render')
if (!REEL.includes('~')) throw new Error('--reel <project id>~<n> is required')
const PID = REEL.split('~')[0]
const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const h = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json())
log('engine', h.version, 'on', PORT)

const app = await electron.launch({
  executablePath: require('electron'),
  args: [root],
  env: { ...process.env, VIKU_PORT: String(PORT), VIKU_USER_DATA: mkdtempSync(join(tmpdir(), 'viku-e2e-framing-')), VIKU_QUERY: 'debug=1&adapter=live&no-onboarding=1' },
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
const shot = async (name) => {
  await sleep(600)
  await page.screenshot({ path: join(shots, `framing-${name}.png`) })
  log('screenshot', `framing-${name}.png`)
}
const st = (fn, a) => page.evaluate(fn, a)
const reelState = () =>
  st(() => {
    const r = window.__viku.currentReel()
    return r ? { framing: r.framing, tracks: r.follow.length, crops: r.crops.map((c) => [+c.cx.toFixed(3), +c.cw.toFixed(3), c.ax === undefined ? null : +c.ax.toFixed(3)]) } : null
  })
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
    await sleep(1500)
  }
}
// left edge of the reel preview video at reel second t (moves when the crop pans)
const previewLeft = async (t) => {
  await st((tt) => window.__viku.usePlayback.setState({ t: tt, skim: null, playing: false, viewer: 'reel' }), t)
  await sleep(250)
  return page.$eval('.stage-video', (v) => parseFloat(v.style.left))
}

let failed = null
try {
  // Automate option
  await st(() => window.__viku.useApp.getState().set({ mode: 'automate' }))
  await page.waitForSelector('.automate', { timeout: 10000 })
  const opt = await page.$$eval('.auto-row', (els) => els.map((e) => e.textContent).filter((s) => /Auto framing/.test(s)))
  log('automate option:', JSON.stringify(opt))
  if (!opt.length) throw new Error('Automate has no Auto framing option')
  const formFraming = await st(() => window.__viku.useAuto.getState().form.framing)
  if (formFraming !== 'follow') throw new Error(`Automate framing should default to follow, got ${formFraming}`)
  await page.$eval('.auto-row:has-text("Auto framing")', (el) => el.scrollIntoView({ block: 'center' }))
  await shot('01-automate-option')

  // Manual: the reel
  await st(([p, r]) => window.__viku.useEditor.getState().openProject(p, r), [PID, REEL])
  await st(() => window.__viku.useApp.getState().set({ mode: 'manual', inspectorTab: 'reel' }))
  await page.waitForSelector('.stage-video', { timeout: 30000 })
  await sleep(1500)
  log('before:', JSON.stringify(await reelState()))
  await shot('02-manual-before')

  await page.click('button:has-text("Follow speaker")')
  await sleep(500)
  let s = await reelState()
  log('switched:', JSON.stringify(s))
  if (s.framing !== 'follow') throw new Error('switch did not set follow')
  if (!s.tracks) {
    const at = Date.now() - 2000
    await page.click('button:has-text("Track speaker")')
    await waitJob('track speaker', '^framing$', 10 * 60_000, at)
    for (let i = 0; i < 20 && !(await reelState()).tracks; i++) await sleep(500)
  }
  s = await reelState()
  log('tracked:', JSON.stringify(s))
  if (!s.tracks) throw new Error('no follow tracks after tracking')

  const dur = await st(() => window.__viku.currentReel().segments.reduce((a, [x, y]) => a + y - x, 0))
  const lefts = []
  for (let k = 0; k < 8; k++) lefts.push(Math.round(await previewLeft(0.5 + (k * (dur - 1)) / 7)))
  log('preview left edge over the reel:', JSON.stringify(lefts))
  if (new Set(lefts).size < 3) throw new Error('preview does not pan with the speaker')
  await previewLeft(dur * 0.4)
  await shot('03-manual-follow')

  // segment inspector: nudge
  await st(() => window.__viku.useEditor.getState().select({ kind: 'segment', index: 0 }))
  await st(() => window.__viku.useApp.getState().set({ inspectorTab: 'clip' }))
  await sleep(500)
  const nudgeShown = await page.$('[aria-label="Framing nudge"]')
  if (!nudgeShown) throw new Error('no Nudge control in the segment inspector')
  const l0 = await previewLeft(dur * 0.4)
  await st(() =>
    window.__viku.useEditor.getState().edit('Nudge framing', (r) => {
      const c = r.crops[0]
      if (c.ax === undefined) c.ax = c.cx
      c.cx = c.ax + 0.03
    })
  )
  const l1 = await previewLeft(dur * 0.4)
  log('nudge +0.03 moved the preview by', l1 - l0, 'px')
  if (!(l1 < l0)) throw new Error('nudge right should move the picture left')
  await st(() =>
    window.__viku.useEditor.getState().edit('Nudge framing', (r) => {
      const c = r.crops[0]
      c.cx = c.ax
    })
  )
  await shot('04-segment-nudge')

  if (RENDER) {
    await st(() => window.__viku.useApp.getState().set({ inspectorTab: 'reel' }))
    const at = Date.now() - 2000
    await page.click('.btn-col button:has-text("Render")')
    const j = await waitJob('render', '^render$', 30 * 60_000, at)
    log('render result:', JSON.stringify(j.result).slice(0, 300))
    await sleep(2000)
    await shot('05-rendered')
  }
} catch (e) {
  failed = e
  log('FAILED:', e instanceof Error ? e.stack : String(e))
  await page.screenshot({ path: join(shots, 'framing-zz-failure.png') }).catch(() => undefined)
}
log('console errors:', errors.length)
await app.close()
process.exit(failed ? 1 : 0)
