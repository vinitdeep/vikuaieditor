// End-to-end run of the BUILT app against the real engine and the user's normal data (%APPDATA%\Viku).
//   Manual: open the project, edit a caption, swap a cutaway image from the library, move a jump-cut segment,
//           render the reel, play the rendered MP4 in the viewer.
//   Automate: the real sermon, sermon part 7850-8000 s, 1 reel -> a finished reel card.
// Usage: npm run dist:dir && node scripts/e2e-live.mjs [--reel <id>] [--skip-manual] [--skip-automate]
// The engine must already answer on 127.0.0.1:8765 (the app connects to it; it does not own it).
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shots = join(root, 'screenshots')
mkdirSync(shots, { recursive: true })
const arg = (k, d) => {
  const i = process.argv.indexOf(k)
  return i > 0 ? process.argv[i + 1] : d
}
const PROJECT = '20261117-045435-6d0d'
const REEL = arg('--reel', `${PROJECT}~4`)
const SERMON = 'C:\\Users\\vinit\\Downloads\\ମୂଳଦୁଆ ପୂର୍ବରୁ _ Before the Foundation ✝️ _ Pastor Jacob Deep _ TAPP Church Hirakud.mp4'
const exe = join(root, 'release', 'win-unpacked', 'Viku.exe')
const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const h = await fetch('http://127.0.0.1:8765/health').then((r) => r.json())
log('engine', h.version, 'data', h.data_dir)
if (!existsSync(exe)) throw new Error(`build first: ${exe}`)

const app = await electron.launch({ executablePath: exe, args: [], env: { ...process.env, VIKU_QUERY: 'debug=1&adapter=live&no-onboarding=1' }, timeout: 60000 })
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
  await page.screenshot({ path: join(shots, `e2e-${name}.png`) })
  log('screenshot', `e2e-${name}.png`)
}
const st = (fn, a) => page.evaluate(fn, a)
const waitJob = async (label, pred, timeoutMs) => {
  const end = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    const j = await st((p) => {
      const s = window.__viku.useJobs.getState()
      const id = s.order.find((i) => new RegExp(p).test(s.jobs[i].kind + ' ' + s.jobs[i].label))
      return id ? s.jobs[id] : null
    }, pred)
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
  if (!process.argv.includes('--skip-manual')) {
    // ---------------------------------------------------------------- Manual
    await st(
      async ([pid, rid]) => {
        const v = window.__viku
        v.useApp.getState().set({ mode: 'manual', browserTab: 'transcript' })
        await v.useEditor.getState().openProject(pid, rid)
      },
      [PROJECT, REEL]
    )
    await page.waitForSelector('.lane-video .clip-video', { timeout: 60000 })
    await sleep(2500)
    const before = await st(() => window.__viku.currentReel())
    log('reel', before.id, JSON.stringify(before.title), 'segments', before.segments.length, 'cutaways', before.cutaways.length, 'captions', before.captions.length)
    await shot('01-manual-open')

    // 1. caption edit through the Caption inspector (end the line with a sentence mark)
    const capIdx = Math.max(0, before.captions.findIndex((c) => !/[।.!?|]$/.test(c.text.trim())))
    await st((i) => {
      const v = window.__viku
      v.useEditor.getState().select({ kind: 'caption', index: i })
      v.useApp.getState().set({ inspectorTab: 'caption' })
      v.usePlayback.getState().seek(v.currentReel().captions[i].t0 + 0.05)
    }, capIdx)
    const ta = page.locator('textarea[aria-label="Caption text"]')
    await ta.waitFor({ timeout: 10000 })
    const oldText = await ta.inputValue()
    const mark = before.language === 'en' ? '.' : '।'
    await ta.click()
    await page.keyboard.press('End')
    await page.keyboard.type(mark)
    await ta.blur()
    await sleep(600)
    const capNow = await st((i) => window.__viku.currentReel().captions[i].text, capIdx)
    log('caption', capIdx, JSON.stringify(oldText), '->', JSON.stringify(capNow))
    if (capNow !== oldText + mark) throw new Error('caption edit did not reach the reel')
    await shot('02-caption-edited')

    // 2. swap cutaway 1's picture from the Library (double-click a cell while the cutaway is selected)
    const cutIdx = Math.max(0, before.cutaways.findIndex((c) => c.img))
    const oldImg = before.cutaways[cutIdx]?.img
    await st((i) => {
      const v = window.__viku
      v.useEditor.getState().select({ kind: 'cutaway', index: i })
      v.useApp.getState().set({ inspectorTab: 'cutaway' })
      v.usePlayback.getState().seek(v.currentReel().cutaways[i].t0 + 1)
    }, cutIdx)
    await page.click('button:has-text("Swap from Library")')
    await page.waitForSelector('.icell', { timeout: 30000 })
    await page.fill('input[aria-label="Search illustrations"]', 'light')
    await sleep(1500)
    const cells = page.locator('.icell')
    let picked = null
    for (let k = 0; k < (await cells.count()) && !picked; k++) {
      const title = (await cells.nth(k).getAttribute('title')) ?? ''
      const path = await cells.nth(k).evaluate((el) => el.querySelector('img')?.getAttribute('src') ?? '')
      if (!decodeURIComponent(path).toLowerCase().includes((oldImg ?? '').toLowerCase().split(/[\\/]/).pop())) {
        await cells.nth(k).dblclick()
        picked = title.split('\n')[0]
      }
    }
    await sleep(800)
    const newImg = await st((i) => window.__viku.currentReel().cutaways[i].img, cutIdx)
    log('cutaway', cutIdx, oldImg?.split(/[\\/]/).pop(), '->', newImg?.split(/[\\/]/).pop(), `(${picked})`)
    if (!newImg || newImg === oldImg) throw new Error('cutaway image was not swapped')
    await shot('03-cutaway-swapped')

    // 3. move a jump-cut segment: blade the first segment (a jump cut) when the reel has one, then drag the last segment before the first
    let segs = await st(() => window.__viku.currentReel().segments.length)
    if (segs < 2) {
      await st(() => {
        const v = window.__viku
        const r = v.currentReel()
        const [s, e] = r.segments[0]
        v.usePlayback.getState().seek((e - s) * 0.62)
        v.useEditor.getState().select(null)
      })
      await page.locator('.timeline').click({ position: { x: 5, y: 5 } }).catch(() => undefined)
      await page.keyboard.press('Control+b')
      await sleep(600)
      segs = await st(() => window.__viku.currentReel().segments.length)
      log('bladed into', segs, 'segments')
    }
    const segBefore = await st(() => JSON.stringify(window.__viku.currentReel().segments))
    const clips = page.locator('.lane-video .clip-video')
    const last = clips.nth((await clips.count()) - 1)
    const first = clips.nth(0)
    const lb = await last.boundingBox()
    const fb = await first.boundingBox()
    await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2)
    await page.mouse.down()
    for (let s = 1; s <= 12; s++) await page.mouse.move(lb.x + lb.width / 2 - ((lb.x - fb.x + 20) * s) / 12, lb.y + lb.height / 2)
    await sleep(200)
    await shot('04a-segment-dragging')
    await page.mouse.up()
    await sleep(800)
    const segAfter = await st(() => JSON.stringify(window.__viku.currentReel().segments))
    log('segments', segBefore, '->', segAfter)
    if (segAfter === segBefore) throw new Error('segment did not move')
    await shot('04-segment-moved')

    // save (Ctrl+S) then render from the Reel inspector
    await page.keyboard.press('Control+s')
    await sleep(1500)
    const saved = await fetch(`http://127.0.0.1:8765/projects/${PROJECT}`).then((r) => r.json())
    const sr = saved.reels.find((r) => r.id === REEL)
    log('saved on engine: caption =', JSON.stringify(sr.captions[capIdx]?.text), '| cutaway img =', sr.cutaways[cutIdx]?.img?.split(/[\\/]/).pop(), '| segments =', JSON.stringify(sr.segments))
    await st(() => window.__viku.useApp.getState().set({ inspectorTab: 'reel' }))
    await page.click('.inspector button:has-text("Render")')
    await sleep(1500)
    await shot('05-rendering')
    await waitJob('render', '^render ', 20 * 60_000)
    await sleep(2500)
    await shot('06-rendered')

    // play the rendered MP4 in the viewer
    await page.click('.export-row button:has-text("Play")')
    await page.waitForSelector('video.rendered-video', { timeout: 15000 })
    await page.waitForFunction(() => {
      const v = document.querySelector('video.rendered-video')
      return v && v.readyState >= 2 && v.currentTime > 1.5
    }, null, { timeout: 30000 })
    const vinfo = await page.$eval('video.rendered-video', (v) => ({ w: v.videoWidth, h: v.videoHeight, d: v.duration, t: v.currentTime, paused: v.paused }))
    log('rendered video in viewer:', JSON.stringify(vinfo))
    await page.$eval('video.rendered-video', (v) => {
      v.currentTime = Math.min(v.duration - 1, 8)
    })
    await sleep(1200)
    await shot('07-rendered-playing')
    await page.$eval('video.rendered-video', (v) => v.pause())
  }

  if (!process.argv.includes('--skip-automate')) {
    // ---------------------------------------------------------------- Automate
    await st(() => window.__viku.useApp.getState().set({ mode: 'automate' }))
    await page.waitForSelector('.automate', { timeout: 10000 })
    await st((p) => window.__viku.useAuto.getState().setForm({ video_path: p, language: 'auto', count: 1 }), SERMON)
    // language: the wizard's Auto (mixed Odia / Hindi sermon); count 1 via the stepper state; part via the inputs
    await page.fill('input[aria-label="Sermon part from"]', '2:10:50')
    await page.fill('input[aria-label="Sermon part to"]', '2:13:20')
    await sleep(500)
    await shot('08-automate-setup')
    await page.click('.run-btn')
    await sleep(3000)
    await shot('09-automate-running')
    const j = await waitJob('automate', '^automate ', 40 * 60_000)
    log('automate result:', JSON.stringify(j.result).slice(0, 400))
    await page.waitForSelector('.rcard', { timeout: 60000 })
    await sleep(3000)
    await shot('10-automate-result')
    const cards = await page.$$eval('.rcard', (els) => els.map((e) => e.querySelector('.rcard-title')?.textContent))
    log('result cards:', JSON.stringify(cards))
    // hover play on the card = inline preview of the rendered MP4
    await page.click('.rcard-play').catch(() => undefined)
    await sleep(3500)
    await shot('11-automate-card-playing')
  }
} catch (e) {
  failed = e
  log('FAILED:', e instanceof Error ? e.stack : String(e))
  await page.screenshot({ path: join(shots, 'e2e-zz-failure.png') }).catch(() => undefined)
}
log('console errors:', errors.length)
await app.close()
process.exit(failed ? 1 : 0)
