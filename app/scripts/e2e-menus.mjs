/* global window, document -- page.evaluate callbacks run in the renderer */
// End-to-end: the Premiere-style menu bar. Opens every menu (screenshot each), then clicks EVERY enabled item
// (sub-menus too) through the real UI and checks that it changed something: app / editor / playback state,
// a job, a toast, a file dialog, Explorer, a new window or full screen. Cut / Copy / Paste / Select All are
// checked on a real text field; Exit is clicked last and must close the app.
// Mock adapter, no engine. Usage: npm run build && node scripts/e2e-menus.mjs
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const app = await electron.launch({
  executablePath: require('electron'),
  args: [root],
  env: { ...process.env, VIKU_NO_ENGINE: '1', VIKU_USER_DATA: mkdtempSync(join(tmpdir(), 'viku-e2e-menus-')), VIKU_QUERY: 'adapter=mock&debug=1&no-onboarding=1' },
  timeout: 60000
})
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

await app.evaluate(({ BrowserWindow, dialog, shell }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.unmaximize()
  w.setBounds({ x: 20, y: 20, width: 1600, height: 960 })
  // OS-level side effects are recorded instead of shown
  globalThis.__menuCalls = []
  dialog.showOpenDialog = async (...a) => {
    const o = a.find((x) => x && typeof x === 'object' && 'title' in x)
    globalThis.__menuCalls.push(`dialog:${o?.title ?? ''}`)
    return { canceled: true, filePaths: [] }
  }
  shell.openPath = async (p) => {
    globalThis.__menuCalls.push(`openPath:${p}`)
    return ''
  }
  shell.showItemInFolder = (p) => void globalThis.__menuCalls.push(`reveal:${p}`)
})
await page.waitForSelector('.menubar', { timeout: 30000 })
await page.evaluate(() => document.fonts.ready)
await sleep(1500)

async function prep() {
  await page.evaluate(async () => {
    const v = window.__viku
    v.useApp.getState().set({ settingsOpen: false, exportOpen: false, shortcutsOpen: false, onboardingOpen: false, aboutOpen: false, activityOpen: false, aiOpen: false, mode: 'manual' })
    const ed = v.useEditor.getState()
    if (!ed.projects.length) await ed.loadProjects()
    if (!v.useEditor.getState().project) await v.useEditor.getState().openProject(v.useEditor.getState().projects[0].id)
    const p = v.useEditor.getState().project
    if (!v.useEditor.getState().reelId) v.useEditor.getState().openReel((p.reels.find((r) => r.captions.length && r.cutaways.length) ?? p.reels[0]).id)
    v.useEditor.getState().select({ kind: 'segment', index: 0 })
    v.useTranscriptSel.setState({ ranges: [[2, 4]], markIn: null })
    v.usePlayback.setState({ viewer: 'reel', t: 1.5, srcT: 30, playing: false, preview: null })
    v.useApp.getState().set({ browserTab: 'transcript' }) // the inspector stays on Clip (the selected segment)
  })
  await sleep(150)
}

async function fingerprint() {
  const r = await page.evaluate(() => {
    const v = window.__viku
    const a = v.useApp.getState()
    const e = v.useEditor.getState()
    const pb = v.usePlayback.getState()
    const reel = v.currentReel()
    return JSON.stringify({
      app: [a.mode, a.browserTab, a.libraryTab, a.inspectorTab, a.activityOpen, a.aiOpen, a.settingsOpen, a.settingsTab, a.exportOpen, a.shortcutsOpen, a.onboardingOpen, a.aboutOpen, a.tool, a.snapping, a.skimming, Math.round(a.zoom * 100), a.layout],
      toasts: a.toasts.map((t) => t.text),
      ed: [e.project?.id ?? null, e.reelId, e.selection, e.past.length, e.future.length, e.project?.reels.length, e.candidates.length, reel ? JSON.stringify(reel).length : 0, reel?.framing],
      pb: [pb.viewer, Math.round(pb.t * 1000), Math.round(pb.srcT * 1000), pb.playing, pb.safeZone, pb.showOverlays, JSON.stringify(pb.preview)],
      sel: JSON.stringify(v.useTranscriptSel.getState()),
      jobs: Object.keys(v.useJobs.getState().jobs).length,
      focus: document.activeElement?.className ?? ''
    })
  })
  const main = await app.evaluate(({ BrowserWindow }) => JSON.stringify({ calls: globalThis.__menuCalls.length, wins: BrowserWindow.getAllWindows().length, fs: BrowserWindow.getAllWindows()[0]?.isFullScreen() }))
  return r + main
}

/** list a menu's rows (and each sub-menu's rows) from the DOM */
async function listMenu(label) {
  await page.keyboard.press('Escape')
  await page.locator('.mb-top', { hasText: new RegExp(`^${label}$`) }).click()
  await page.waitForSelector('.mb-pop')
  const rows = await page.$$eval('.mb-pop:not(.mb-subpop) > .mb-row > .mb-item', (els) =>
    els.map((el) => ({ label: el.querySelector('.mb-label').textContent, disabled: el.classList.contains('disabled'), sub: el.getAttribute('aria-haspopup') === 'menu', checked: el.getAttribute('aria-checked'), role: el.getAttribute('role') }))
  )
  const out = []
  for (const r of rows) {
    if (!r.sub) {
      out.push({ path: [r.label], ...r })
      continue
    }
    if (r.disabled) {
      out.push({ path: [r.label], ...r })
      continue
    }
    await page.locator('.mb-pop:not(.mb-subpop) > .mb-row > .mb-item', { hasText: r.label }).first().hover()
    await page.waitForSelector('.mb-subpop')
    const subs = await page.$$eval('.mb-subpop .mb-item', (els) =>
      els.map((el) => ({ label: el.querySelector('.mb-label').textContent, disabled: el.classList.contains('disabled'), checked: el.getAttribute('aria-checked'), role: el.getAttribute('role') }))
    )
    for (const s of subs) out.push({ path: [r.label, s.label], ...s })
  }
  await page.keyboard.press('Escape')
  return out
}

async function clickPath(menu, path) {
  await page.locator('.mb-top', { hasText: new RegExp(`^${menu}$`) }).click()
  await page.waitForSelector('.mb-pop')
  const top = page.locator('.mb-pop:not(.mb-subpop) > .mb-row > .mb-item').filter({ has: page.locator('.mb-label', { hasText: new RegExp(`^${esc(path[0])}$`) }) })
  if (path.length === 1) return top.click()
  await top.hover()
  await page.waitForSelector('.mb-subpop')
  await page.locator('.mb-subpop .mb-item').filter({ has: page.locator('.mb-label', { hasText: new RegExp(`^${esc(path[1])}$`) }) }).click()
}
// a trailing count like "(2)" may have changed since the menu was listed (an earlier item made a reel)
const esc = (s) => s.replace(/ \(\d+\)$/, '\u0000').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\u0000', '(?: \\(\\d+\\))?')

const MENUS = ['File', 'Edit', 'Clip', 'Sequence', 'Markers', 'Graphics and Titles', 'View', 'Window', 'Help']
const LAST = new Set(['File>Exit', 'File>Close Project'])
const results = []
await prep()

// 1. screenshot every menu
for (const m of MENUS) {
  await page.keyboard.press('Escape')
  await page.locator('.mb-top', { hasText: new RegExp(`^${m}$`) }).click()
  await page.waitForSelector('.mb-pop')
  await sleep(200)
  await page.screenshot({ path: join(shots, `menu-${m.split(' ')[0].toLowerCase()}.png`) })
}
// one with a sub-menu open
await page.keyboard.press('Escape')
await page.locator('.mb-top', { hasText: /^File$/ }).click()
await page.locator('.mb-pop .mb-item', { hasText: 'Export' }).first().hover()
await sleep(250)
await page.screenshot({ path: join(shots, 'menu-file-export.png') })
await page.keyboard.press('Escape')

// 2. keyboard: Alt+V opens View, Right moves to Window, Alt+F jumps to File, Right on "New" opens its
//    sub-menu, Left closes it, Down + Enter runs an item, Esc closes; Esc also closes a mouse-opened menu
const openTop = () => page.$eval('.mb-top.open', (el) => el.textContent).catch(() => null)
await page.keyboard.press('Alt+v')
await sleep(150)
const k1 = await openTop()
await page.keyboard.press('ArrowRight')
await sleep(100)
const k2 = await openTop()
await page.keyboard.press('Alt+f')
await sleep(100)
const k3 = await openTop()
await page.keyboard.press('ArrowRight')
await sleep(100)
const k4 = Boolean(await page.$('.mb-subpop'))
await page.keyboard.press('ArrowLeft')
await sleep(100)
const k5 = !(await page.$('.mb-subpop')) && (await openTop()) === 'File'
await page.keyboard.press('Escape')
await sleep(100)
const k6 = !(await page.$('.mb-pop'))
await page.keyboard.press('Alt+w')
await page.keyboard.press('ArrowDown') // Workspaces -> first panel (Media)
await page.keyboard.press('Enter')
await sleep(150)
const k7 = await page.evaluate(() => window.__viku.useApp.getState().browserTab === 'media' && !document.querySelector('.mb-pop'))
await page.locator('.mb-top', { hasText: /^Help$/ }).click()
await page.keyboard.press('Escape')
await sleep(100)
const k8 = !(await page.$('.mb-pop'))
results.push({ item: 'Keyboard: Alt+V, Right, Alt+F, sub-menu Right/Left, Esc, Enter; Esc on mouse-opened', ok: k1 === 'View' && k2 === 'Window' && k3 === 'File' && k4 && k5 && k6 && k7 && k8, note: JSON.stringify([k1, k2, k3, k4, k5, k6, k7, k8]) })
await prep()

// 3. every enabled item
const all = []
for (const m of MENUS) {
  await prep()
  for (const r of await listMenu(m)) all.push({ menu: m, ...r })
}
const enabled = all.filter((r) => !r.disabled && !r.sub)
const textItems = new Set(['Cut', 'Copy', 'Paste', 'Select All'])
for (const r of enabled) {
  const key = `${r.menu}>${r.path.join('>')}`
  if (LAST.has(key) || (r.menu === 'Edit' && textItems.has(r.path[0]))) continue
  await prep()
  // give the items whose job is to restore a default something to restore
  if (key === 'Clip>Select Clip at Playhead' || key === 'Clip>Clip Properties…') await page.evaluate(() => window.__viku.useEditor.getState().select(null))
  if (key === 'Window>Workspaces>Reset Panel Sizes') await page.evaluate(() => window.__viku.useApp.getState().setLayout({ left: 420, right: 380, bottom: 260 }))
  const before = await fingerprint()
  await clickPath(r.menu, r.path)
  await sleep(700)
  const after = await fingerprint()
  const noOpRadio = r.role === 'menuitemradio' && r.checked === 'true'
  const ok = before !== after || noOpRadio
  results.push({ item: key, ok, note: noOpRadio ? 'already selected (radio)' : ok ? '' : 'NOTHING CHANGED' })
  // undo side effects that would leak into the next item
  await app.evaluate(({ BrowserWindow }) => {
    const [main, ...rest] = BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id)
    if (main?.isFullScreen()) main.setFullScreen(false)
    for (const w of rest) w.close()
  })
  await sleep(150)
}
const disabled = all.filter((r) => r.disabled).map((r) => `${r.menu}>${r.path.join('>')}`)

// 4. Cut / Copy / Paste / Select All on a real text field (the transcript search box)
await prep()
await page.evaluate(() => window.__viku.useApp.getState().set({ browserTab: 'transcript' }))
await sleep(300)
const box = page.locator('input[aria-label="Search transcript"]')
await box.fill('hello world')
await box.focus()
const editDisabledOffField = await (async () => {
  await page.locator('body').click({ position: { x: 800, y: 500 } }).catch(() => undefined)
  await page.evaluate(() => document.activeElement?.blur?.())
  await page.locator('.mb-top', { hasText: /^Edit$/ }).click()
  const d = await page.locator('.mb-pop .mb-item', { hasText: /^Copy/ }).first().getAttribute('class')
  await page.keyboard.press('Escape')
  return d.includes('disabled')
})()
await box.focus()
await clickPath('Edit', ['Select All'])
await sleep(150)
const selAll = await box.evaluate((el) => el.selectionStart === 0 && el.selectionEnd === el.value.length)
await clickPath('Edit', ['Copy'])
await sleep(150)
await clickPath('Edit', ['Cut'])
await sleep(150)
const afterCut = await box.inputValue()
await clickPath('Edit', ['Paste'])
await sleep(150)
await clickPath('Edit', ['Paste'])
await sleep(150)
const afterPaste = await box.inputValue()
results.push({ item: 'Edit>Select All (text field)', ok: selAll })
results.push({ item: 'Edit>Copy + Cut (text field)', ok: afterCut === '', note: `after cut: "${afterCut}"` })
results.push({ item: 'Edit>Paste (text field)', ok: afterPaste === 'hello worldhello world', note: `after paste x2: "${afterPaste}"` })
results.push({ item: 'Edit>Cut/Copy/Paste greyed out off a text field', ok: editDisabledOffField })
await box.fill('')

// 5. Close Project, then Exit
await prep()
await clickPath('File', ['Close Project'])
await sleep(500)
const closed = await page.evaluate(() => window.__viku.useEditor.getState().project === null)
results.push({ item: 'File>Close Project', ok: closed })
await page.screenshot({ path: join(shots, 'menu-closed-project.png') })
const exited = new Promise((res) => app.once('close', () => res(true)))
await clickPath('File', ['Exit'])
const didExit = await Promise.race([exited, sleep(8000).then(() => false)])
results.push({ item: 'File>Exit', ok: didExit })
if (!didExit) await app.close()

const bad = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.item}${r.note ? `  (${r.note})` : ''}`)
console.log(`\nGreyed out in this state (${disabled.length}): ${disabled.join(' | ')}`)
if (errors.length) console.log('\nRenderer errors:\n' + [...new Set(errors)].join('\n'))
console.log(`\n${results.length - bad.length}/${results.length} passed`)
process.exit(bad.length ? 1 : 0)
