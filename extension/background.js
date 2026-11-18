// Viku extension - background service worker.
//
// Talks to the Viku desktop app on this computer (http://127.0.0.1:47917-47921, never the internet) and keeps ONE
// AI Studio tab as the "Viku tab". The content script in that tab runs the prompts; this worker only proxies
// its requests to Viku (content scripts cannot reach 127.0.0.1) and opens the tab when Viku has work.
// Nothing here reads or types Google credentials: the user signs in to Google themselves, in this browser.

const PORTS = [47917, 47918, 47919, 47920, 47921]
const VERSION = chrome.runtime.getManifest().version
const MODEL_DEFAULT = 'gemini-3.1-flash-image'

async function get(key, def) {
  const v = await chrome.storage.local.get(key)
  return v[key] ?? def
}
async function sget(key, def) {
  const v = await chrome.storage.session.get(key)
  return v[key] ?? def
}
const sset = (obj) => chrome.storage.session.set(obj)

async function setStatus(patch) {
  const cur = await sget('status', {})
  await sset({ status: { ...cur, ...patch, at: Date.now() } })
}

async function viku(path, init) {
  const port = await sget('port', 0)
  // Viku closed: look for it again at most once a minute (each refused port is a console line in the browser)
  if (!port && path === '/viku/hello' && Date.now() < (await sget('nextScan', 0))) throw new Error('Viku is not running')
  const order = port ? [port, ...PORTS.filter((p) => p !== port)] : PORTS
  let lastErr = null
  for (const p of order) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}${path}`, { ...init, signal: AbortSignal.timeout(path === '/viku/result' ? 60000 : 4000) })
      if (res.status === 404 && path === '/viku/hello') continue
      if (!res.ok) throw new Error(`Viku answered ${res.status}`)
      const body = await res.json()
      if (path === '/viku/hello' && body.app !== 'viku') continue
      if (p !== port) await sset({ port: p })
      return body
    } catch (e) {
      lastErr = e
      if (port && p === port) await sset({ port: 0 })
    }
  }
  if (path === '/viku/hello') await sset({ nextScan: Date.now() + 60000 })
  throw lastErr ?? new Error('Viku is not running')
}

async function hello(extra = {}) {
  const tabId = await get('tabId', 0)
  let tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null
  if (tab && !AISTUDIO_TAB.test(tab.url || tab.pendingUrl || '')) tab = null // the browser restarted and the id now names another tab
  const page = !tab ? 'none' : /^https:\/\/aistudio\.google\.com\//.test(tab.url || tab.pendingUrl || '') ? 'aistudio' : /accounts\.google\.com/.test(tab.url || '') ? 'signin' : 'other'
  const status = await sget('status', {})
  const body = await viku('/viku/hello', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: VERSION, enabled: await get('enabled', true), page, state: status.state || 'idle', note: status.note || '', ...extra })
  })
  return { body, tab, page }
}

const AISTUDIO_TAB = /^https:\/\/(aistudio|accounts)\.google\.com\//
const VIKU_FRESH = /^https:\/\/aistudio\.google\.com\/prompts\/new_chat\?[^#]*model=gemini-[\w.-]*image/

/**
 * The ONE AI Studio tab Viku works in. Remembered across extension reloads (tab ids live as long as the browser);
 * a Viku tab that is already open is adopted instead of opening another, and extra Viku tabs from before are closed.
 * Only when there is none does it open a new one, in the background so it never steals focus.
 */
async function workerTab(model, activate) {
  const url = `https://aistudio.google.com/prompts/new_chat?model=${encodeURIComponent(model || MODEL_DEFAULT)}`
  const own = await get('ownTabs', [])
  const all = await chrome.tabs.query({ url: ['https://aistudio.google.com/*', 'https://accounts.google.com/*'] }).catch(() => [])
  const live = (id) => all.find((t) => t.id === id)
  let tab = live(await get('tabId', 0)) || own.map(live).find(Boolean) || all.find((t) => VIKU_FRESH.test(t.url || t.pendingUrl || '')) || null
  if (!tab) tab = await chrome.tabs.create({ url, active: Boolean(activate) })
  else if (activate) await chrome.tabs.update(tab.id, { active: true })
  // close other Viku tabs left from earlier runs (only ones Viku itself opened)
  for (const id of own) if (id !== tab.id && live(id)) await chrome.tabs.remove(id).catch(() => undefined)
  await chrome.storage.local.set({ tabId: tab.id, ownTabs: [tab.id] })
  return tab
}

/** Fingerprint of the extension's own files as they are on disk now (an unpacked extension reads them from its folder). */
async function codeHash() {
  let text = ''
  for (const f of ['manifest.json', 'background.js', 'content.js', 'popup.js', 'popup.html']) {
    text += await fetch(chrome.runtime.getURL(f), { cache: 'no-store' })
      .then((r) => r.text())
      .catch(() => '')
  }
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Viku updates the extension folder when it is updated; Chrome keeps running the old code until the extension is
 * reloaded. Compare the files on disk with the ones this copy started with and reload by itself when they changed.
 */
async function reloadIfUpdated() {
  const now = await codeHash().catch(() => '')
  if (!now) return false
  const was = await get('codeHash', '')
  if (!was) {
    await chrome.storage.local.set({ codeHash: now })
    return false
  }
  if (was === now) return false
  await chrome.storage.local.set({ codeHash: now })
  chrome.runtime.reload()
  return true
}

async function tick(reason) {
  if (reason === 'alarm' && (await reloadIfUpdated())) return
  if (!(await get('enabled', true))) {
    await setStatus({ state: 'off', note: 'Turned off in the Viku extension' })
    await hello().catch(() => undefined)
    return
  }
  let h
  try {
    h = await hello()
  } catch {
    await setStatus({ state: 'no-viku', note: 'Open Viku on this computer' })
    return
  }
  await setStatus({ viku: true, port: await sget('port', 0), waiting: h.body.waiting, version: h.body.version })
  if (!h.body.enabled) return // Viku is not in "Your browser" mode
  if (h.body.waiting > 0) {
    const tab = await workerTab(h.body.model, h.page === 'signin')
    if (h.page === 'signin') await setStatus({ state: 'signin', note: 'Sign in to Google in the AI Studio tab' })
    // wake the content script (background tabs throttle its timers). A tab Chrome put to sleep to save memory, or one
    // still running an old copy of the script, does not answer: load it again so the script runs.
    if (tab.discarded) await chrome.tabs.reload(tab.id).catch(() => undefined)
    else
      await chrome.tabs.sendMessage(tab.id, { type: 'poke', reason }).catch(async () => {
        const t = await chrome.tabs.get(tab.id).catch(() => null)
        if (t && t.status === 'complete' && /^https:\/\/aistudio\.google\.com\//.test(t.url || '')) await chrome.tabs.reload(tab.id).catch(() => undefined)
      })
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create('viku', { periodInMinutes: 0.5 })
  await chrome.storage.local.set({ codeHash: await codeHash().catch(() => '') }) // the code this copy runs
  // after a reload / update, a Viku tab left open still runs the OLD script (Chrome does not re-inject it):
  // refresh only Viku's own tabs, recognised by the image-model address they were opened with
  const mine = await get('tabId', 0)
  const old = await chrome.tabs.query({ url: 'https://aistudio.google.com/*' }).catch(() => [])
  for (const t of old) if (t.id === mine || VIKU_FRESH.test(t.url || '')) await chrome.tabs.reload(t.id).catch(() => undefined)
  void tick('installed')
})
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('viku', { periodInMinutes: 0.5 })
  void tick('startup')
})
chrome.alarms.onAlarm.addListener(() => void tick('alarm'))
chrome.tabs.onRemoved.addListener(async (id) => {
  if (id === (await get('tabId', 0))) await chrome.storage.local.set({ tabId: 0 })
})

// Messages from the content script (worker tab only) and the popup.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  ;(async () => {
    const fromTab = sender.tab?.id
    const isWorker = fromTab && fromTab === (await get('tabId', 0))
    switch (msg?.type) {
      case 'whoami': {
        if (!isWorker || !(await get('enabled', true))) return reply({ worker: false })
        try {
          const h = await hello()
          return reply({ worker: true, waiting: h.body.enabled ? h.body.waiting : 0, model: h.body.model || MODEL_DEFAULT })
        } catch {
          await setStatus({ state: 'no-viku', note: 'Open Viku on this computer' })
          return reply({ worker: true, waiting: 0 })
        }
      }
      case 'claim': {
        // a content script asks for work: only the Viku tab gets any, never the user's own AI Studio tabs
        if (!isWorker || !(await get('enabled', true))) return reply({ item: null, worker: Boolean(isWorker) })
        try {
          const r = await viku('/viku/next', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          if (r.item) await setStatus({ state: 'working', note: r.item.name })
          else await setStatus({ state: 'idle', note: '' })
          return reply({ item: r.item ?? null, model: r.model || MODEL_DEFAULT, worker: true })
        } catch (e) {
          await setStatus({ state: 'no-viku', note: 'Open Viku on this computer' })
          return reply({ item: null, worker: true, error: String(e) })
        }
      }
      case 'result': {
        if (!isWorker) return reply({ ok: false })
        const r = await viku('/viku/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: msg.id, mime: msg.mime, b64: msg.b64 }) })
        const done = (await get('done', 0)) + 1
        await chrome.storage.local.set({ done })
        await setStatus({ state: 'idle', note: '', last: msg.name || '' })
        return reply(r)
      }
      case 'fail': {
        if (!isWorker) return reply({ ok: false })
        const r = await viku('/viku/fail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: msg.id, error: msg.error, kind: msg.kind }) }).catch(() => ({ pause: true }))
        await setStatus({ state: r.pause ? 'paused' : 'idle', note: msg.error })
        if (msg.kind === 'attention') await workerTab(undefined, true) // show the tab so the user can see what AI Studio wants
        return reply(r)
      }
      case 'status': {
        await sset({ nextScan: 0 }) // opening the popup looks for Viku right away
        await tick('popup').catch(() => undefined)
        return reply({ status: await sget('status', {}), enabled: await get('enabled', true), done: await get('done', 0), tabId: await get('tabId', 0) })
      }
      case 'enable': {
        await chrome.storage.local.set({ enabled: Boolean(msg.on) })
        await tick('toggle').catch(() => undefined)
        return reply({ ok: true })
      }
      case 'show-tab': {
        await workerTab(undefined, true)
        return reply({ ok: true })
      }
      default:
        return reply({ ok: false })
    }
  })().catch((e) => reply({ ok: false, error: String(e) }))
  return true // async reply
})
