// Drives the built app with Playwright (Electron) and saves screenshots of every main screen.
// Usage: npm run build && node scripts/screenshots.mjs [--live]
//   default: mock adapter (realistic Odia/Hindi data), engine not started
//   --live : real engine on 127.0.0.1:8765 (must already be running)
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const live = process.argv.includes('--live')
const outDir = join(root, 'screenshots')
mkdirSync(outDir, { recursive: true })
const profile = join(tmpdir(), `viku-shots-${Date.now()}`)

const app = await electron.launch({
  executablePath: require('electron'),
  args: [root],
  env: {
    ...process.env,
    VIKU_QUERY: `adapter=${live ? 'live' : 'mock'}&debug=1`,
    VIKU_NO_ENGINE: '1',
    VIKU_USER_DATA: profile
  }
})

const page = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.unmaximize()
  w.setBounds({ x: 20, y: 20, width: 1600, height: 960 })
})
await page.waitForSelector('.topbar', { timeout: 30000 })
await page.evaluate(() => document.fonts.ready)
const wait = (ms) => page.waitForTimeout(ms)
await wait(1200)

const prefix = live ? 'live-' : ''
const shot = async (name) => {
  await wait(450)
  await page.screenshot({ path: join(outDir, `${prefix}${name}.png`) })
  console.log('saved', `${prefix}${name}.png`)
}
const st = (fn, arg) => page.evaluate(fn, arg)

// 0. First-run onboarding (fresh profile => shown once)
if (await page.$('.ob')) {
  await shot('00a-onboarding-welcome')
  await page.click('.ob-next')
  await wait(400)
  await shot('00b-onboarding-folder')
  await page.click('.ob-next')
  await wait(500)
  await shot('00c-onboarding-models')
  await page.click('.ob-next')
  await wait(400)
  await shot('00d-onboarding-signins')
  await page.click('.ob-next')
  await wait(400)
  await shot('00e-onboarding-church')
  await page.click('.ob-next')
  await wait(400)
  await shot('00f-onboarding-done')
  await page.click('.ob-choice:not(.primary)')
  await wait(500)
}

// pick the reel that shows the most overlays
await st(() => {
  const v = window.__viku
  const p = v.useEditor.getState().project
  const reel = p?.reels.find((r) => r.cutaways.length && r.verses.length) ?? p?.reels.find((r) => r.cutaways.length) ?? p?.reels[0]
  if (reel) v.useEditor.getState().openReel(reel.id)
  v.useApp.getState().set({ mode: 'manual', browserTab: 'transcript' })
})
await wait(800)

// 1. Manual editor: playhead on a cutaway with a verse card, caption inspector on a flagged caption
await st(() => {
  const v = window.__viku
  const r = v.currentReel()
  if (!r) return
  const verse = r.verses[0]
  const cut = r.cutaways[0]
  const t = verse ? verse.t0 + 1.4 : cut ? cut.t0 + 1.2 : 2
  v.usePlayback.setState({ t, viewer: 'reel', playing: false })
  const flagged = r.captions.findIndex((c) => c.flags.length)
  v.useEditor.getState().select({ kind: 'caption', index: flagged >= 0 ? flagged : 0 })
})
// drag-select a few transcript lines
const lines = await page.$$('.tline')
if (lines.length > 12) {
  const a = await lines[8].boundingBox()
  const b = await lines[10].boundingBox()
  if (a && b) {
    await page.mouse.move(a.x + 120, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(a.x + 140, a.y + a.height / 2 + 12, { steps: 4 })
    await page.mouse.move(b.x + 160, b.y + b.height / 2, { steps: 6 })
    await page.mouse.up()
  }
}
await shot('01-manual-editor')

// 2. Title hook at the start, safe zones, Suggestions, clip inspector
await st(() => {
  const v = window.__viku
  v.usePlayback.setState({ t: 1.6, safeZone: true })
  v.useApp.getState().set({ browserTab: 'suggestions' })
  v.useEditor.getState().select({ kind: 'segment', index: 1 })
})
await shot('02-title-safezones-suggestions')

// 3. Source viewer with the fixed crop box
await st(() => {
  const v = window.__viku
  const r = v.currentReel()
  v.usePlayback.setState({ safeZone: false, viewer: 'source', srcT: r ? r.segments[0][0] + 2 : 10 })
  v.useEditor.getState().select({ kind: 'segment', index: 0 })
})
await shot('03-source-crop')

// 4. Library + cutaway inspector
await st(() => {
  const v = window.__viku
  const r = v.currentReel()
  v.usePlayback.setState({ viewer: 'reel', t: r?.cutaways[1] ? r.cutaways[1].t0 + 2 : 5 })
  v.useApp.getState().set({ browserTab: 'library', libraryTab: 'illustrations' })
  v.useEditor.getState().select({ kind: 'cutaway', index: r?.cutaways[1] ? 1 : 0 })
})
await page.waitForSelector('.icell img:not(.img-loading), .icell .thumb-ph', { timeout: 15000 }).catch(() => undefined)
await wait(600)
await shot('04-library-cutaway')

// 4b. An empty cutaway waiting for a generated image
const hasNeed = await st(() => {
  const v = window.__viku
  const r = v.currentReel()
  const i = r ? r.cutaways.findIndex((c) => !c.img) : -1
  if (i < 0) return false
  v.usePlayback.setState({ viewer: 'reel', t: r.cutaways[i].t0 + 1.5 })
  v.useEditor.getState().select({ kind: 'cutaway', index: i })
  return true
})
if (hasNeed) await shot('04b-cutaway-needs-image')

// 5. Bible + verse inspector, music library
await st(() => {
  const v = window.__viku
  const r = v.currentReel()
  v.useApp.getState().set({ browserTab: 'bible' })
  if (r?.verses.length) {
    v.usePlayback.setState({ t: r.verses[0].t0 + 2 })
    v.useEditor.getState().select({ kind: 'verse', index: 0 })
  }
})
await shot('05-bible-verse')

await st(() => {
  const v = window.__viku
  v.useApp.getState().set({ browserTab: 'library', libraryTab: 'music' })
  v.useEditor.getState().select({ kind: 'music' })
})
await shot('06-music-audio')

// 7. Thumbnail inspector + activity drawer with a running render
await st(async () => {
  const v = window.__viku
  v.useApp.getState().set({ browserTab: 'media', inspectorTab: 'thumbnail', activityOpen: true })
  const r = v.currentReel()
  if (r && v.api().kind === 'mock') {
    const ref = await v.api().render(r.id)
    v.useJobs.getState().track(ref, `Render · ${r.title}`)
    const ref2 = await v.api().suggest(v.useEditor.getState().project.id)
    v.useJobs.getState().track(ref2, 'Find clips (Viku Brain)')
  }
})
await wait(1600)
await shot('07-thumbnail-activity')

// 8. Export dialog
await st(() => window.__viku.useApp.getState().set({ activityOpen: false, exportOpen: true }))
await shot('08-export-dialog')

// 8b. Keyboard shortcuts sheet (opened with "?")
await st(() => window.__viku.useApp.getState().set({ exportOpen: false }))
await wait(200)
await page.keyboard.press('Shift+Slash')
await wait(300)
await shot('17-shortcuts')
await page.keyboard.press('Escape')
await wait(200)

// 8c. Engine-down banner (pretend the user wants live data and the engine is stopped)
await st(() => {
  const v = window.__viku
  v.useApp.getState().set({ adapterPref: 'auto', engine: { state: 'stopped', url: 'http://127.0.0.1:8765', spawned: false, message: 'Engine not running', log: [] } })
})
await shot('18-engine-banner')
await st(async () => {
  const v = window.__viku
  v.useApp.getState().set({ adapterPref: v.api().kind === 'live' ? 'live' : 'mock', engine: await window.viku.engine.status() })
})

// 9. Settings (engine & models)
await st(() => window.__viku.useApp.getState().set({ settingsOpen: true }))
await wait(300)
await page.click('.settings-tabs button:nth-child(4)')
await shot('09-settings-engine')
await page.click('.settings-tabs button:nth-child(1)')
await shot('10-settings-general')
await st(() => window.__viku.useApp.getState().set({ settingsOpen: false }))

// 11. Automate wizard -> progress -> results (mock only runs the pipeline)
await st(() => window.__viku.useApp.getState().set({ mode: 'automate' }))
await wait(400)
const recent = await page.$('.recent-chip')
if (recent) await recent.click()
await shot('11-automate-setup')
if (!live) {
  await page.click('.run-btn')
  await wait(5200)
  await shot('12-automate-progress')
  await page.waitForSelector('.rcard', { timeout: 60000 })
  await wait(1600)
  await shot('13-automate-results')
  // inline preview of the first reel
  await page.hover('.rcard:first-child .rcard-media')
  await wait(300)
  await shot('13b-automate-results-hover')
} else {
  // live: show the gallery with the project's real reels and their rendered exports
  await st(async () => {
    const v = window.__viku
    const p = v.useEditor.getState().project
    if (!p) return
    const results = p.reels.map((r) => ({
      project_id: p.id,
      reel_id: r.id,
      title: r.title,
      duration: r.duration ?? 0,
      score: r.score,
      output: r.exports?.[r.exports.length - 1]?.path,
      thumbnail: r.exports?.[r.exports.length - 1]?.thumbnail
    }))
    const reels = Object.fromEntries(p.reels.map((r) => [r.id, r]))
    v.useAuto.getState().set({ results, reels, projects: { [p.id]: p } })
  })
  await wait(2500)
  await shot('13-automate-results')
}

// 14. Sign-in window
await st(() => window.__viku.useApp.getState().set({ mode: 'manual' }))
const [signin] = await Promise.all([app.waitForEvent('window', { timeout: 20000 }), page.evaluate(() => window.viku.signin.open('heygen'))])
await signin.waitForSelector('.si-app', { timeout: 20000 })
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => x.getTitle().includes('Sign in'))
  w?.setBounds({ x: 60, y: 60, width: 1320, height: 860 })
})
await signin.evaluate(() => document.fonts.ready)
await signin.waitForTimeout(800)
await signin.screenshot({ path: join(outDir, `${prefix}14-signin-heygen.png`) })
console.log('saved 14-signin-heygen.png')
await signin.click('.si-card:nth-child(3)')
await signin.waitForTimeout(500)
await signin.screenshot({ path: join(outDir, `${prefix}15-signin-ebible.png`) })
console.log('saved 15-signin-ebible.png')
await page.evaluate(() => window.viku.signin.queue([
  { prompt: 'Vertical 9:16 warm painterly illustration, no text: empty tomb at sunrise, stone rolled away, soft gold light', name: 'r-satan-defeated-cut01' },
  { prompt: 'Vertical 9:16 warm painterly illustration, no text: a lone man walking a road at dusk, a gentle light beside him', name: 'r-not-alone-cut02' }
]))
await signin.click('.si-card:nth-child(1)')
await signin.waitForTimeout(6000)
// the AI Studio page lives in a separate WebContentsView: composite it via the window capture
const png = await app.evaluate(async ({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows().find((x) => x.getTitle().includes('Sign in'))
  if (!w) return null
  const views = w.contentView.children
  const base = await w.webContents.capturePage()
  const parts = [{ img: base.toPNG().toString('base64'), x: 0, y: 0 }]
  for (const v of views) {
    if (!('webContents' in v) || v.webContents === w.webContents) continue
    const b = v.getBounds()
    const img = await v.webContents.capturePage()
    parts.push({ img: img.toPNG().toString('base64'), x: b.x, y: b.y, w: b.width, h: b.height })
  }
  return parts
})
if (png) {
  // stitch in the renderer: draw base, then the view at its bounds
  const dataUrl = await signin.evaluate(async (parts) => {
    const load = (b64) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + b64 })
    const base = await load(parts[0].img)
    const c = document.createElement('canvas')
    const dpr = base.width / window.innerWidth
    c.width = base.width
    c.height = base.height
    const ctx = c.getContext('2d')
    ctx.drawImage(base, 0, 0)
    for (const p of parts.slice(1)) {
      const im = await load(p.img)
      ctx.drawImage(im, p.x * dpr, p.y * dpr, p.w * dpr, p.h * dpr)
    }
    return c.toDataURL('image/png')
  }, png)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(outDir, `${prefix}16-signin-aistudio.png`), Buffer.from(dataUrl.split(',')[1], 'base64'))
  console.log('saved 16-signin-aistudio.png')
}

await app.close()
try {
  rmSync(profile, { recursive: true, force: true })
} catch {
  /* ignore */
}
