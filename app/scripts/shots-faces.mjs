/* global window -- page callbacks run in the renderer */
// Screenshots of "Same face": the face picker in the Cutaway inspector and in the AI pictures drawer, plus a queued
// picture carrying its face (mock adapter, isolated profile, no browser needed).
// Usage: npm run build && node scripts/shots-faces.mjs <face1.jpg> [face2.jpg]
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
const faces = process.argv.slice(2)
if (!faces.length) throw new Error('give one or two face photos')
const work = mkdtempSync(join(tmpdir(), 'viku-faces-'))
const app = await electron.launch({
  executablePath: require('electron'),
  args: [root],
  env: { ...process.env, VIKU_USER_DATA: join(work, 'profile'), VIKU_QUERY: 'debug=1&adapter=mock&no-onboarding=1', VIKU_NO_ENGINE: '1', VIKU_EXT_PORT: '47961' },
  timeout: 60000
})
let failed = null
try {
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.unmaximize()
    w.setBounds({ x: 20, y: 20, width: 1600, height: 960 })
  })
  await page.waitForSelector('.topbar', { timeout: 90000 })
  const st = (fn, a) => page.evaluate(fn, a)
  await st(() => window.viku.signin.setMode('browser'))

  // inspector: an empty cutaway, no face yet
  await st(() => {
    const v = window.__viku
    const p = v.useEditor.getState().project
    const reel = p?.reels.find((r) => r.cutaways.some((c) => !c.img)) ?? p?.reels.find((r) => r.cutaways.length)
    v.useEditor.getState().openReel(reel.id)
    v.useApp.getState().set({ mode: 'manual', browserTab: 'library', libraryTab: 'illustrations' })
  })
  await page.waitForTimeout(800)
  await st(() => {
    const v = window.__viku
    const r = v.currentReel()
    const i = Math.max(0, r.cutaways.findIndex((c) => !c.img))
    v.usePlayback.setState({ viewer: 'reel', t: r.cutaways[i].t0 + 1.5 })
    v.useEditor.getState().select({ kind: 'cutaway', index: i })
  })
  await page.waitForSelector('.faces', { timeout: 15000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(shots, 'faces-empty.png') })

  // add the faces (the first added is chosen), then choose the first again
  const s = await st((f) => window.viku.faces.add(f.slice().reverse()), faces)
  const pastor = s.faces[s.faces.length - 1]
  await st((id) => window.viku.faces.rename(id, 'Pastor Jacob'), pastor.id)
  await st((id) => window.viku.faces.select(id), pastor.id)
  await page.waitForTimeout(900)
  const radios = await page.locator('.inspector .faces [role=radio], .faces [role=radio]').first().locator('xpath=..').locator('[role=radio]').count()
  const checked = await page.locator('.faces [role=radio][aria-checked=true]').first().getAttribute('data-face')
  console.log('inspector: radios', radios, 'checked', checked === pastor.id)
  if (radios !== faces.length + 1 || checked !== pastor.id) throw new Error('face picker state wrong')
  await page.locator('.faces').first().scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(shots, 'faces-inspector.png') })

  // generate from the inspector: the queued picture carries the face, and the drawer shows it
  await page.click('.btn:has-text("Generate in AI Studio")')
  await page.waitForSelector('.drawer.aip.open', { timeout: 10000 })
  await page.waitForTimeout(900)
  const q = await st(() => window.viku.signin.list())
  console.log('queued:', JSON.stringify(q.map((i) => ({ name: i.name, face: i.faceName, asks: /same person/.test(i.prompt) }))))
  if (!q.length || q[0].faceName !== 'Pastor Jacob' || !/same person/.test(q[0].prompt)) throw new Error('queued picture has no face')
  if (!(await page.locator('.drawer.aip .aip-face').count())) throw new Error('drawer does not show the face')
  await page.screenshot({ path: join(shots, 'faces-drawer.png') })
  console.log('PASS')
} catch (e) {
  failed = e
} finally {
  await app.close().catch(() => undefined)
}
if (failed) {
  console.error('FAIL:', failed.message)
  process.exit(1)
}
