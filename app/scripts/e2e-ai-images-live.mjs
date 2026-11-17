/* global window -- page.evaluate callbacks run in the renderer */
// LIVE end to end for AI pictures on a real sermon: Automate "Make 1 reel" with Illustrations = Gemini ->
// every cutaway queued in the real Sign-in queue -> Send next -> a picture "downloaded" into the watched folder for
// each -> filed onto its cutaway by the engine -> the reel re-renders by itself -> the pictures are in the MP4.
// Only AI Studio itself is replaced (each "download" is a solid-colour 1080x1920 picture, so the frames can be
// checked). Run against an engine with its own VIKU_DATA (the picture library gets the test pictures).
// Usage: npm run build && VIKU_PORT=8799 node scripts/e2e-ai-images-live.mjs [--video <path>] [--from 32:00 --to 36:00]
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
const COLOURS = ['d02020', '20b040', '2050e0', 'e0c020', 'c020c0', '20c0c0', 'f07010', '8040f0', '60a020', 'f04090', '30a0f0', 'a06030']
const rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))

const h = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json())
log('engine', h.version, 'on', PORT, 'data', h.data_dir)
if (/Roaming\\Viku$/i.test(h.data_dir)) throw new Error('refusing to run on the real Viku data folder: start the engine with VIKU_DATA')

const work = mkdtempSync(join(tmpdir(), 'viku-e2e-ai-live-'))
const downloads = join(work, 'Downloads')
mkdirSync(downloads)
const pics = COLOURS.map((c) => {
  const f = join(work, `pic-${c}.png`)
  execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${c}:s=1080x1920`, '-frames:v', '1', f])
  return f
})

const app = await electron.launch({
  executablePath: require('electron'),
  args: [root],
  env: { ...process.env, VIKU_PORT: String(PORT), VIKU_USER_DATA: join(work, 'profile'), VIKU_QUERY: 'debug=1&adapter=live&no-onboarding=1' },
  timeout: 60000
})
await app.evaluate(({ shell, clipboard }) => {
  shell.openExternal = async () => undefined // never open the real browser
  clipboard.writeText = () => undefined // never touch the user's clipboard
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
const waitJob = async (label, test, timeoutMs) => {
  const end = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    const j = await st((src) => {
      const s = window.__viku.useJobs.getState()
      const f = new Function('j', `return ${src}`)
      const id = s.order.find((i) => f(s.jobs[i]))
      return id ? s.jobs[id] : null
    }, test)
    if (j) {
      const line = `${j.state} ${(j.progress * 100).toFixed(0)}% ${j.message}`
      if (line !== last) log(label, line)
      last = line
      if (j.state === 'done') return j
      if (j.state === 'error' || j.state === 'cancelled') throw new Error(`${label} failed: ${j.message}`)
    }
    if (Date.now() > end) throw new Error(`${label} timed out`)
    await sleep(3000)
  }
}
const reelOf = (rid) =>
  st(async (id) => {
    const p = await window.__viku.api().getProject(id.split('~')[0])
    const r = p.reels.find((x) => x.id === id)
    return r && { status: r.status, cutaways: r.cutaways.map((c) => ({ t0: c.t0, t1: c.t1, img: c.img, need: Boolean(c.need) })), exports: r.exports }
  }, rid)
// mean colour of the middle of the frame at second t (the cutaway picture fills it; captions sit lower)
const colourAt = (video, t) => {
  const buf = execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', video, '-frames:v', '1', '-vf', 'crop=540:500:270:500,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  return [buf[0], buf[1], buf[2]]
}
const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 90

let failed = null
try {
  await st((dir) => window.viku.prefs.set({ geminiMode: 'browser', downloadsDir: dir }), downloads)
  await st(() => window.viku.signin.setMode('browser'))

  // 1. Automate: Make 1 reel, Illustrations = Gemini
  await st(() => window.__viku.useApp.getState().set({ mode: 'automate' }))
  await page.waitForSelector('.auto-tabs', { timeout: 10000 })
  await page.click('.auto-tab:nth-child(2)')
  await st((v) => window.__viku.useAuto.getState().setForm({ video_path: v, language: 'auto', count: 1, max_seconds: 60, illustrations: 'ai', framing: 'follow' }), VIDEO)
  await page.fill('input[aria-label="Sermon part from"]', FROM)
  await page.fill('input[aria-label="Sermon part to"]', TO)
  await sleep(500)
  log('run button:', await page.textContent('.run-btn'))
  await page.click('.run-btn')
  const auto = await waitJob('automate', "j.kind === 'automate'", 30 * 60_000)
  const made = auto.result?.reels?.[0]
  log('made:', JSON.stringify({ reel: made?.reel, path: made?.path, duration: made?.duration }))
  if (!made?.reel || !made?.path) throw new Error('Automate did not make a rendered reel')
  const rid = made.reel
  const firstVideo = made.path
  let r = await reelOf(rid)
  log('cutaways after build:', JSON.stringify(r.cutaways.map((c) => [c.t0, c.img ? 'IMG' : c.need ? 'NEED' : '-'])))
  if (!r.cutaways.length || r.cutaways.some((c) => c.img)) throw new Error('Gemini: every cutaway should be a request for a new picture')

  // 2. every empty cutaway is queued in AI Studio
  let q = []
  for (let i = 0; i < 20; i++) {
    q = (await st(() => window.viku.signin.list())).filter((x) => x.meta?.reelId === rid)
    if (q.length) break
    await sleep(500)
  }
  log('queued prompts:', q.length, '| e.g.', JSON.stringify(q[0]?.prompt?.slice(0, 120)))
  if (q.length !== r.cutaways.length) throw new Error(`expected ${r.cutaways.length} queued prompts, got ${q.length}`)
  // the first render has the speaker where the pictures will go
  const before = r.cutaways.map((c) => colourAt(firstVideo, (c.t0 + c.t1) / 2))
  await page.screenshot({ path: join(shots, 'ai-live-01-queued.png') })

  // 3. Send next + "download" a picture, one prompt at a time
  const colourOf = {}
  for (let k = 0; k < q.length; k++) {
    const sent = await st(() => window.viku.signin.sendNext())
    const item = sent.item
    await sleep(400)
    const c = COLOURS[k % COLOURS.length]
    writeFileSync(join(downloads, `Gemini_Generated_Image_${k}.png`), readFileSync(pics[k % pics.length]))
    let got = null
    for (let i = 0; i < 60 && !got; i++) {
      got = (await st(() => window.viku.signin.list())).find((x) => x.id === item.id && x.status === 'captured' && x.meta?.attached)
      if (!got) await sleep(500)
    }
    if (!got) throw new Error(`picture ${k + 1} was not filed onto its cutaway`)
    colourOf[item.meta.t0.toFixed(2)] = rgb(c)
    log(`picture ${k + 1}/${q.length} filed onto cutaway at ${item.meta.t0}s`)
  }

  // 4. the reel re-renders by itself
  const re = await waitJob('re-render', "/new pictures/.test(j.label || '')", 30 * 60_000)
  const finalVideo = re.result?.path
  r = await reelOf(rid)
  log('cutaways after pictures:', JSON.stringify(r.cutaways.map((c) => [c.t0, c.img ? c.img.split(/[\\/]/).pop() : null])))
  if (r.cutaways.some((c) => !c.img)) throw new Error('a cutaway is still empty')

  // 5. the pictures are in the MP4
  let ok = 0
  r.cutaways.forEach((c, i) => {
    const want = colourOf[c.t0.toFixed(2)]
    const got = colourAt(finalVideo, (c.t0 + c.t1) / 2)
    const hit = want && near(got, want)
    if (hit) ok++
    log(`cutaway ${i + 1} @${((c.t0 + c.t1) / 2).toFixed(1)}s  before ${JSON.stringify(before[i])}  after ${JSON.stringify(got)}  picture ${JSON.stringify(want)}  ${hit ? 'IN VIDEO' : 'MISSING'}`)
  })
  log(`pictures visible in the final video: ${ok}/${r.cutaways.length}`, finalVideo)
  if (ok !== r.cutaways.length) throw new Error('not every new picture is in the video')
  await sleep(1000)
  await page.screenshot({ path: join(shots, 'ai-live-02-done.png') })
} catch (e) {
  failed = e
  log('FAILED:', e instanceof Error ? e.stack : String(e))
  await page.screenshot({ path: join(shots, 'ai-live-zz-failure.png') }).catch(() => undefined)
}
log('console errors:', errors.length)
await app.close()
process.exit(failed ? 1 : 0)
