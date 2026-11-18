// RESULT 2026-11-18: BLOCKED by Google (sign-in rejected under the debug port; with a saved login every Run =
// "Permission denied"). Kept only to re-check later; Viku uses the browser extension (extension/) instead.
// Probe: can Viku generate pictures in Google AI Studio with the CHURCH'S OWN Google login, automatically?
//
// Google refuses sign-in inside embedded Electron views, so instead Viku starts the user's REAL Chrome (or Edge) with
// its own separate profile and a local DevTools port. The user signs in to Google there once (a real browser, so
// Google allows it; Viku never sees the password). Viku then drives AI Studio over the Chrome DevTools Protocol:
// open the image model, type the prompt, run it, read the finished picture out of the page and save it.
//
//   node scripts/aistudio-browser-probe.mjs [--profile <dir>] [--out <dir>] [--browser chrome|edge] ["prompt" ...]
//
// Zero dependencies (Node 22+ global WebSocket). The profile persists, so sign-in is needed only the first time.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return def
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const profile = opt('profile', path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Viku', 'google-browser'))
const outDir = opt('out', path.join(os.tmpdir(), 'viku-aistudio-probe'))
const want = opt('browser', 'chrome')
const MODEL = opt('model', 'gemini-3.1-flash-image')
const prompts = args.length ? args : [
  'Warm painted illustration, vertical 9:16: an Indian fisherman pulling a net at sunrise on a calm river, hopeful mood, no text, no letters',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

function findBrowser() {
  const pf = process.env.PROGRAMFILES || 'C:\\Program Files'
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA || ''
  const chrome = [`${pf}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Google\\Chrome\\Application\\chrome.exe`, `${local}\\Google\\Chrome\\Application\\chrome.exe`]
  const edge = [`${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`]
  const order = want === 'edge' ? [...edge, ...chrome] : [...chrome, ...edge]
  return order.find((p) => fs.existsSync(p))
}

async function launch() {
  fs.mkdirSync(profile, { recursive: true })
  const portFile = path.join(profile, 'DevToolsActivePort')
  // Re-use a browser this profile already has open.
  if (fs.existsSync(portFile)) {
    const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0])
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`)
      log('re-using running browser on port', port)
      return port
    } catch { fs.rmSync(portFile, { force: true }) }
  }
  const exe = findBrowser()
  if (!exe) throw new Error('No Chrome or Edge found')
  log('starting', path.basename(exe), 'profile', profile)
  // No --enable-automation / --headless: those mark the browser as automated and Google blocks sign-in.
  const child = spawn(exe, [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=http://127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    `https://aistudio.google.com/prompts/new_chat?model=${MODEL}`,
  ], { detached: true, stdio: 'ignore' })
  child.unref()
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(portFile)) {
      const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0])
      if (port) return port
    }
    await sleep(200)
  }
  throw new Error('browser did not open a DevTools port')
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.wait = new Map()
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id && this.wait.has(m.id)) {
        const { ok, ko } = this.wait.get(m.id)
        this.wait.delete(m.id)
        m.error ? ko(new Error(m.error.message)) : ok(m.result)
      }
    })
  }
  static async open(url) {
    const ws = new WebSocket(url)
    await new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = () => ko(new Error('CDP connect failed')) })
    return new Cdp(ws)
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((ok, ko) => this.wait.set(id, { ok, ko }))
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  close() { this.ws.close() }
}

async function aiStudioPage(port) {
  for (let i = 0; i < 50; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find((t) => t.type === 'page' && /aistudio\.google\.com|accounts\.google\.com/.test(t.url)) || list.find((t) => t.type === 'page')
    if (page) return Cdp.open(page.webSocketDebuggerUrl)
    await sleep(200)
  }
  throw new Error('no page target')
}

// Page-side helpers. Only stable hooks: the prompt textarea (aria-label / placeholder), Ctrl+Enter to run, and big
// <img> elements in the reply. Nothing here types or reads any Google credential.
const STATE = `(() => {
  const ta = document.querySelector('textarea[aria-label="Enter a prompt"]') || document.querySelector('textarea[placeholder*="prompt" i]') || document.querySelector('ms-prompt-box textarea, textarea')
  const imgs = [...document.querySelectorAll('img')].filter(i => i.naturalWidth >= 512 && i.naturalHeight >= 512 && /^(blob|data):/.test(i.src))
  const text = document.body ? document.body.innerText : ''
  return {
    host: location.host, url: location.href, ready: !!ta && location.host === 'aistudio.google.com',
    images: imgs.length, webdriver: navigator.webdriver,
    model: (text.match(/gemini-[\\w.-]*image[\\w.-]*/) || [null])[0],
    error: (text.match(/(quota|rate limit|failed to generate|permission denied|internal error|try again later|not available in your)[^\\n]{0,120}/i) || [null])[0],
  }
})()`

async function waitSignedIn(cdp) {
  let last = null
  for (let i = 0; i < 1800; i++) { // 30 minutes
    let s
    try { s = await cdp.eval(STATE) } catch { await sleep(1000); continue }
    if (s.ready) return s
    if (s.host !== last) { log(`>>> Sign in to Google in the Viku browser window (now on ${s.host || "a blank page"}). Waiting...`); last = s.host }
    await sleep(1000)
  }
  throw new Error('not signed in after 30 minutes')
}

async function generate(cdp, prompt, n) {
  await cdp.send('Page.navigate', { url: `https://aistudio.google.com/prompts/new_chat?model=${MODEL}` })
  let s
  for (let i = 0; i < 60; i++) { await sleep(500); try { s = await cdp.eval(STATE) } catch { continue } if (s.ready) break }
  if (!s?.ready) throw new Error('AI Studio prompt box not found')
  log('model on page:', s.model || '(no image model name visible)')
  const before = s.images
  await cdp.eval(`(() => { const ta = document.querySelector('textarea[aria-label="Enter a prompt"]') || document.querySelector('textarea'); ta.focus(); ta.value=''; return true })()`)
  await cdp.send('Input.insertText', { text: prompt })
  await sleep(300)
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
  log(`#${n} sent, waiting for the picture...`)
  const t0 = Date.now()
  while (Date.now() - t0 < 180_000) {
    await sleep(1500)
    s = await cdp.eval(STATE)
    if (s.images > before) break
    if (s.error) throw new Error(`AI Studio says: ${s.error}`)
  }
  if (s.images <= before) throw new Error('no picture after 3 minutes')
  await sleep(1500) // let the final image settle
  const data = await cdp.eval(`(async () => {
    const imgs = [...document.querySelectorAll('img')].filter(i => i.naturalWidth >= 512 && i.naturalHeight >= 512 && /^(blob|data):/.test(i.src))
    const img = imgs[imgs.length - 1]
    const blob = await (await fetch(img.src)).blob()
    const buf = new Uint8Array(await blob.arrayBuffer())
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return { type: blob.type, w: img.naturalWidth, h: img.naturalHeight, b64: btoa(s) }
  })()`)
  const ext = /png/.test(data.type) ? 'png' : /webp/.test(data.type) ? 'webp' : 'jpg'
  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, `probe-${n}.${ext}`)
  fs.writeFileSync(file, Buffer.from(data.b64, 'base64'))
  log(`#${n} saved ${data.w}x${data.h} ${data.type} in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${file}`)
  return file
}

const port = await launch()
const cdp = await aiStudioPage(port)
await cdp.send('Page.enable')
const s = await waitSignedIn(cdp)
log('signed in; navigator.webdriver =', s.webdriver)
let ok = 0
for (let i = 0; i < prompts.length; i++) {
  try { await generate(cdp, prompts[i], i + 1); ok++ } catch (e) { log(`#${i + 1} FAILED: ${e.message}`) }
}
log(`done: ${ok}/${prompts.length} pictures`)
cdp.close()
process.exit(ok === prompts.length ? 0 : 1)
