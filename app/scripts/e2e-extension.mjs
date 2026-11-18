/* global window, document, getComputedStyle -- page callbacks run in the browser */
// Viku browser extension end to end: the REAL extension (../extension, loaded unpacked into Playwright's Chromium)
// talks to the REAL Viku app (Sign-in queue + extension bridge on 127.0.0.1). AI Studio itself is replaced by a
// stand-in page served for https://aistudio.google.com/* (prompt box + Run button that paints a 1080x1920 picture),
// so no Google account is used. Checks:
//  - queued prompts are taken one at a time by the Viku tab, made, and filed under their planned names
//  - an AI Studio tab the user opened themselves is never touched
//  - an AI Studio limit ("Permission denied") pauses the queue and puts the prompt back
// Usage: npm run build && node scripts/e2e-extension.mjs
import { _electron as electron, chromium } from 'playwright-core'
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function pngSize(buf) {
  if (buf.readUInt32BE(0) === 0x89504e47) return [buf.readUInt32BE(16), buf.readUInt32BE(20)]
  return null
}

const STAND_IN = `<!doctype html><html><head><title>Google AI Studio (stand-in)</title></head><body>
<header><span class="tok">1,619 tokens</span></header>
<main><div id="turns"></div>
<textarea aria-label="Enter a prompt" placeholder="Start typing a prompt to see what our models can do"></textarea>
<button class="ctrl-enter-submits ms-button-primary">Run Ctrl</button>
<div>gemini-3.1-flash-image</div>
<button role="radio" aria-checked="false" id="imgonly" onclick="this.setAttribute('aria-checked','true')">Images only</button></main>
<script>
  window.__runs = []
  const ta = document.querySelector('textarea')
  document.querySelector('button').addEventListener('click', () => {
    const prompt = ta.value
    window.__runs.push(prompt)
    ta.value = ''
    const turns = document.getElementById('turns')
    setTimeout(() => {
      if (/NOIMAGE/.test(prompt)) {
        const e = document.createElement('div'); e.textContent = 'No image generated'; turns.appendChild(e); return
      }
      if (/LIMITME/.test(prompt)) {
        const e = document.createElement('div'); e.textContent = 'Permission denied. Please check your account permissions and project settings.'; turns.appendChild(e); return
      }
      const c = document.createElement('canvas'); c.width = 1080; c.height = 1920
      const g = c.getContext('2d'); g.fillStyle = '#' + (prompt.length * 2654435761 % 0xffffff).toString(16).padStart(6, '0'); g.fillRect(0, 0, 1080, 1920)
      g.fillStyle = '#fff'; g.font = '60px sans-serif'; g.fillText(prompt.slice(0, 30), 40, 200)
      c.toBlob((b) => { const img = new Image(); img.className = 'loaded-image'; img.src = URL.createObjectURL(b); turns.appendChild(img) }, 'image/png')
    }, 1500)
  })
</script></body></html>`

const work = mkdtempSync(join(tmpdir(), 'viku-e2e-ext-'))
// a private copy of the extension on a private port, so an extension installed in the user's own browser never
// picks up this test's prompts (it scans 47917-47921)
const TEST_PORT = 47941
const extDir = join(work, 'extension')
cpSync(join(root, '..', 'extension'), extDir, { recursive: true })
const bg = join(extDir, 'background.js')
writeFileSync(bg, readFileSync(bg, 'utf8').replace(/const PORTS = \[[^\]]*\]/, `const PORTS = [${TEST_PORT}]`))
if (!readFileSync(bg, 'utf8').includes(`const PORTS = [${TEST_PORT}]`)) throw new Error('could not point the test extension at its port')
const app = await electron.launch({
  executablePath: require('electron'),
  args: [root],
  env: { ...process.env, VIKU_USER_DATA: join(work, 'profile'), VIKU_QUERY: 'debug=1&adapter=mock&no-onboarding=1', VIKU_NO_ENGINE: '1', VIKU_EXT_PORT: String(TEST_PORT) },
  timeout: 60000
})
await app.evaluate(({ shell, clipboard }) => {
  shell.openExternal = async () => undefined
  clipboard.writeText = () => undefined
})
const page = await app.firstWindow()
await page.waitForSelector('.topbar', { timeout: 90000 })
const st = (fn, a) => page.evaluate(fn, a)

let browser = null
let failed = null
try {
  await st(() => window.viku.signin.setMode('browser'))
  let s = await st(() => window.viku.signin.geminiState())
  log('bridge port:', s.extension.port, '| folder:', s.extension.folder, existsSync(s.extension.folder) ? '(exists)' : '(MISSING)')
  if (!s.extension.port) throw new Error('extension bridge did not start')
  if (s.extension.connected) throw new Error('extension reported connected before it was loaded')

  // the user's own AI Studio tab is open BEFORE anything is queued: it must never be used
  // Chromium (not branded Chrome: Chrome 137+ ignores --load-extension). Any installed Playwright Chromium will do.
  const pw = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
  const exe = existsSync(pw)
    ? readdirSync(pw)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
        .map((d) => join(pw, d, 'chrome-win64', 'chrome.exe'))
        .find((p) => existsSync(p))
    : undefined
  browser = await chromium.launchPersistentContext(join(work, 'chrome'), {
    executablePath: process.env.PW_CHROMIUM || exe,
    // new headless runs extensions too, and nothing pops up on the screen
    headless: true,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-first-run',
      // never reach the real Google, even for a navigation the route below misses
      '--host-resolver-rules=MAP *.google.com 127.0.0.1:9, MAP *.gstatic.com 127.0.0.1:9, MAP *.googleapis.com 127.0.0.1:9'
    ]
  })
  await browser.route('https://aistudio.google.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: STAND_IN }))
  // a tab the extension opens can start loading before Playwright's route is attached to it: load it again
  browser.on('page', async (p) => {
    await sleep(1500)
    const title = await p.title().catch(() => '')
    if (!/stand-in/.test(title)) await p.goto('https://aistudio.google.com/prompts/new_chat?model=gemini-3.1-flash-image').catch(() => undefined)
  })
  const userTab = await browser.newPage()
  await userTab.goto('https://aistudio.google.com/prompts/new_chat')

  // connects by itself (alarm / install tick)
  for (let i = 0; i < 60 && !s.extension.connected; i++) {
    await sleep(1000)
    s = await st(() => window.viku.signin.geminiState())
  }
  log('extension connected:', s.extension.connected, 'v' + s.extension.version, 'state', s.extension.state)
  if (!s.extension.connected) throw new Error('extension never said hello')

  const names = ['reel1-cut01-fisherman', 'reel1-cut02-mother-prayer']
  await st(
    (n) =>
      window.viku.signin.queue([
        { prompt: 'Warm painted illustration, vertical 9:16: a fisherman at sunrise, no text', name: n[0] },
        { prompt: 'Warm painted illustration, vertical 9:16: a mother and child praying by a lamp, no text', name: n[1] }
      ]),
    names
  )
  // the extension polls every 30 s (alarm) / 20 s (tab); Send next only shows a toast in this mode
  const sendRes = await st(() => window.viku.signin.sendNext())
  log('send next ->', sendRes.method)
  if (sendRes.method !== 'extension') throw new Error('Send next should defer to the extension')

  let q = []
  const until = Date.now() + 150000
  while (Date.now() < until) {
    await sleep(2000)
    q = await st(() => window.viku.signin.list())
    if (q.every((i) => i.status === 'captured')) break
  }
  log('queue:', JSON.stringify(q.map((i) => [i.name, i.status, i.via, i.file && basename(i.file)])))
  if (!q.every((i) => i.status === 'captured' && i.via === 'extension')) throw new Error('not every prompt was captured by the extension')
  for (const i of q) {
    const size = pngSize(readFileSync(i.file))
    log(' ', basename(i.file), size?.join('x'))
    if (!basename(i.file).startsWith(i.name) || !size || size[0] !== 1080 || size[1] !== 1920) throw new Error(`wrong file for ${i.name}`)
  }
  const userRuns = await userTab.evaluate(() => window.__runs.length)
  log('runs in the user’s own AI Studio tab:', userRuns)
  if (userRuns !== 0) throw new Error('the extension used the user’s own AI Studio tab')
  const workerTabs = browser.pages().filter((p) => p !== userTab && /aistudio/.test(p.url()))
  log('Viku tabs:', workerTabs.length)
  if (workerTabs.length !== 1) throw new Error('the extension should work in ONE AI Studio tab')
  // the token / cost counter is hidden in the Viku tab only
  const tokVisible = async (p) => p.evaluate(() => getComputedStyle(document.querySelector('.tok')).display !== 'none')
  const inViku = await tokVisible(workerTabs[0])
  const inUser = await tokVisible(userTab)
  log('token counter visible - Viku tab:', inViku, '| your tab:', inUser)
  if (inViku || !inUser) throw new Error('token counter should be hidden in the Viku tab only')
  const imgOnly = await workerTabs[0].evaluate(() => document.getElementById('imgonly').getAttribute('aria-checked'))
  log('Images only switched on in the Viku tab:', imgOnly)
  if (imgOnly !== 'true') throw new Error('Images only was not switched on')

  // AI Studio answers "No image generated": failed at once with a hint, not retried with the same words
  await st(() => window.viku.signin.clearDone())
  await st(() => window.viku.signin.queue([{ prompt: 'NOIMAGE our tongue is not in our control', name: 'reel1-cut09-noimage' }]))
  let ni = null
  const until1 = Date.now() + 90000
  while (Date.now() < until1) {
    await sleep(2000)
    ni = (await st(() => window.viku.signin.list())).find((i) => i.name === 'reel1-cut09-noimage')
    if (ni?.status === 'failed') break
  }
  log('no-image prompt:', JSON.stringify({ status: ni?.status, tries: ni?.tries, error: ni?.error }))
  if (ni?.status !== 'failed' || ni.tries !== 1) throw new Error('a no-image answer should fail at once')
  await st((id) => window.viku.signin.remove(id), ni.id)

  // an AI Studio limit pauses the queue and keeps the prompt
  await st(() => window.viku.signin.clearDone())
  await st(() => window.viku.signin.queue([{ prompt: 'LIMITME vertical 9:16', name: 'reel1-cut03-limit' }]))
  let item = null
  const until2 = Date.now() + 90000
  while (Date.now() < until2) {
    await sleep(2000)
    s = await st(() => window.viku.signin.geminiState())
    item = (await st(() => window.viku.signin.list()))[0]
    if (s.extension.pausedUntil) break
  }
  log('after limit:', JSON.stringify({ status: item?.status, error: item?.error, pausedMin: s.extension.pausedUntil ? Math.round((s.extension.pausedUntil - Date.now()) / 60000) : 0 }))
  if (!s.extension.pausedUntil || item?.status !== 'queued' || !/Permission denied/.test(item?.error ?? '')) throw new Error('limit did not pause the queue')
  log('PASS')
} catch (e) {
  failed = e
} finally {
  await browser?.close().catch(() => undefined)
  await app.close().catch(() => undefined)
}
if (failed) {
  console.error('FAIL:', failed.message)
  process.exit(1)
}
