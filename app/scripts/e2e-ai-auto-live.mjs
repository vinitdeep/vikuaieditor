/* global window -- page.evaluate callbacks run in the renderer */
// LIVE: every reel gets NEW AI pictures by itself. Automate "Make 1 reel" (Illustrations = New AI) on a real sermon
// against an engine whose Settings -> AI pictures is set up: each cutaway must come back with a new picture
// (`ai.scene`), none from the old library and none left for AI Studio; a frame strip of the reel is written.
// Run against an engine with its own VIKU_DATA (new pictures are added to that library).
// Usage: npm run build && VIKU_PORT=8799 node scripts/e2e-ai-auto-live.mjs [--video <path>] [--from 32:00 --to 36:00]
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
const PORT = Number(process.env.VIKU_PORT) || 8799
const VIDEO = arg('--video', 'C:\\Users\\vinit\\Downloads\\Sunday Services _ TAPP Church _🌟JOURNEY OF FAITH — ବିଶ୍ୱାସର ଯାତ୍ରା.mp4')
const FROM = arg('--from', '32:00')
const TO = arg('--to', '36:00')
const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const h = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json())
log('engine', h.version, 'on', PORT, 'data', h.data_dir)
if (/Roaming\\Viku$/i.test(h.data_dir)) throw new Error('refusing to run on the real Viku data folder: start the engine with VIKU_DATA')
const s = await fetch(`http://127.0.0.1:${PORT}/settings`).then((r) => r.json())
if (!s.ai_pictures?.url || !s.ai_pictures_key_set) throw new Error('the engine has no AI picture service set up')

const work = mkdtempSync(join(tmpdir(), 'viku-e2e-ai-auto-'))
const app = await electron.launch({
  executablePath: require('electron'),
  args: [root],
  env: { ...process.env, VIKU_PORT: String(PORT), VIKU_USER_DATA: join(work, 'profile'), VIKU_QUERY: 'debug=1&adapter=live&no-onboarding=1' },
  timeout: 60000
})
await app.evaluate(({ shell, clipboard }) => {
  shell.openExternal = async () => undefined
  clipboard.writeText = () => undefined
})
const page = await app.firstWindow()
const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') {
    errors.push(m.text())
    log('console error:', m.text().slice(0, 200))
  }
})
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.unmaximize()
  w.setBounds({ x: 10, y: 10, width: 1680, height: 1000 })
})
await page.waitForSelector('.topbar', { timeout: 90000 })
const st = (fn, a) => page.evaluate(fn, a)

let failed = null
try {
  await st(() => window.__viku.useApp.getState().set({ mode: 'automate' }))
  await page.waitForSelector('.auto-tabs', { timeout: 10000 })
  await page.click('.auto-tab:nth-child(2)')
  const ill = await st(() => window.__viku.useAuto.getState().form.illustrations)
  if (ill !== 'ai') throw new Error(`Illustrations should default to New AI, got ${ill}`)
  await st((v) => window.__viku.useAuto.getState().setForm({ video_path: v, language: 'auto', count: 1, max_seconds: 60 }), VIDEO)
  await page.fill('input[aria-label="Sermon part from"]', FROM)
  await page.fill('input[aria-label="Sermon part to"]', TO)
  await sleep(500)
  await page.click('.run-btn')
  let last = ''
  let job = null
  for (const end = Date.now() + 40 * 60_000; Date.now() < end; await sleep(3000)) {
    job = await st(() => {
      const s = window.__viku.useJobs.getState()
      const id = s.order.find((i) => s.jobs[i].kind === 'automate')
      return id ? s.jobs[id] : null
    })
    const line = job ? `${job.state} ${(job.progress * 100).toFixed(0)}% ${job.message}` : ''
    if (line && line !== last) log('automate', line)
    last = line
    if (job && ['done', 'error', 'cancelled'].includes(job.state)) break
  }
  if (job?.state !== 'done') throw new Error(`automate ${job?.state}: ${job?.message}`)
  const made = job.result?.reels?.[0]
  const rid = made.reel
  const r = await st(async (id) => {
    const p = await window.__viku.api().getProject(id.split('~')[0])
    return p.reels.find((x) => x.id === id)
  }, rid)
  const cuts = r.cutaways
  log(`reel ${rid}: ${made.duration}s, ${cuts.length} cutaways`)
  cuts.forEach((c, i) => log(`  ${i + 1} @${c.t0}s  ${c.ai ? 'NEW AI' : c.img ? 'LIBRARY?' : 'EMPTY'}  ${(c.ai?.scene ?? '').slice(0, 150)}`))
  const queued = (await st(() => window.viku.signin.list())).filter((x) => x.meta?.reelId === rid)
  log('left for AI Studio:', queued.length)
  if (!cuts.length || cuts.some((c) => !c.img || !c.ai)) throw new Error('every cutaway should have a NEW AI picture')
  if (queued.length) throw new Error('nothing should be left for AI Studio')
  const sheet = join(shots, 'ai-auto-reel-strip.jpg')
  execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', made.path, '-vf', 'fps=1/2.4,scale=144:256,tile=12x2', '-frames:v', '1', sheet])
  log('frame strip:', sheet)
  await page.screenshot({ path: join(shots, 'ai-auto-done.png') })
} catch (e) {
  failed = e
  log('FAILED:', e instanceof Error ? e.stack : String(e))
  await page.screenshot({ path: join(shots, 'ai-auto-zz-failure.png') }).catch(() => undefined)
}
log('console errors:', errors.length)
await app.close()
process.exit(failed ? 1 : 0)
