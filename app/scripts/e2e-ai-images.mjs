/* global window -- page.evaluate callbacks run in the renderer */
// AI pictures end to end on the mock adapter, with the REAL Sign-in queue + Downloads watcher (browser mode):
// a rendered reel's empty cutaway is queued -> "Send next" -> an image lands in Downloads -> filed onto the cutaway ->
// the reel re-renders by itself. Own Electron profile; opening the browser and the clipboard are stubbed out.
// Usage: npm run build && node scripts/e2e-ai-images.mjs
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
const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const REEL = 'r-satan-defeated'

const work = mkdtempSync(join(tmpdir(), 'viku-e2e-ai-'))
const downloads = join(work, 'Downloads')
mkdirSync(downloads)
const picture = join(work, 'gemini-picture.png')
execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xd08030:s=1080x1920', '-frames:v', '1', picture])

const app = await electron.launch({
  executablePath: require('electron'),
  args: [root],
  env: { ...process.env, VIKU_USER_DATA: join(work, 'profile'), VIKU_QUERY: 'debug=1&adapter=mock&no-onboarding=1' },
  timeout: 60000
})
// never open the real browser or touch the user's clipboard
await app.evaluate(({ shell, clipboard }) => {
  shell.openExternal = async () => undefined
  clipboard.writeText = () => undefined
})
const page = await app.firstWindow()
const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.waitForSelector('.topbar', { timeout: 90000 })
const st = (fn, a) => page.evaluate(fn, a)

let failed = null
try {
  await st((dir) => window.viku.prefs.set({ geminiMode: 'browser', downloadsDir: dir }), downloads)
  await st(() => window.viku.signin.setMode('browser'))

  // the reel was rendered before its picture existed
  const rendered = await st(async (rid) => {
    const a = window.__viku.api()
    const ref = await a.render(rid)
    for (let i = 0; i < 80; i++) {
      const s = await a.listProjects()
      for (const ps of s) {
        const p = await a.getProject(ps.id)
        const r = p.reels.find((x) => x.id === rid)
        if (r && r.status === 'rendered') return { job: ref.job, empty: r.cutaways.filter((c) => !c.img).length }
      }
      await new Promise((res) => setTimeout(res, 250))
    }
    return null
  }, REEL)
  log('rendered first:', JSON.stringify(rendered))
  if (!rendered || rendered.empty < 1) throw new Error('need a rendered reel with an empty cutaway')

  const n = await st(async (rid) => {
    const a = window.__viku.api()
    for (const ps of await a.listProjects()) {
      const r = (await a.getProject(ps.id)).reels.find((x) => x.id === rid)
      if (r) return window.__viku.queueEmptyCutaways([r])
    }
    return -1
  }, REEL)
  let q = await st(() => window.viku.signin.list())
  log('queued:', n, '| queue:', JSON.stringify(q.map((i) => [i.status, i.meta?.reelId, i.name])))
  if (n < 1 || q.length !== n || q.some((i) => i.meta?.reelId !== REEL)) throw new Error('empty cutaways were not queued for the reel')

  for (let k = 0; k < n; k++) {
    const sent = await st(() => window.viku.signin.sendNext())
    log('send next:', sent.method, sent.item?.status)
    await sleep(300)
    // "the user downloads the image": a new file (a copy would keep the old modified time, which the watcher ignores)
    writeFileSync(join(downloads, `Gemini_Generated_Image_${k}.png`), readFileSync(picture))
    for (let i = 0; i < 40; i++) {
      q = await st(() => window.viku.signin.list())
      if (q[k]?.status === 'captured') break
      await sleep(250)
    }
    log('after download:', JSON.stringify(q.map((i) => [i.status, Boolean(i.meta?.attached)])))
    await sleep(1500)
    log('toasts:', JSON.stringify(await st(() => (window.__viku.useApp.getState().toasts ?? []).map((t) => t.text))))
    if (q[k]?.status !== 'captured') throw new Error('the downloaded image was not filed')
  }

  // the reel re-renders on its own once its last picture is in
  let job = null
  for (let i = 0; i < 80 && !(job && job.state === 'done'); i++) {
    job = await st(() => {
      const s = window.__viku.useJobs.getState()
      const id = s.order.find((x) => /new pictures/.test(s.jobs[x].label ?? ''))
      return id ? { label: s.jobs[id].label, state: s.jobs[id].state } : null
    })
    await sleep(250)
  }
  log('re-render job:', JSON.stringify(job))
  if (!job || job.state !== 'done') throw new Error('the reel did not re-render after its pictures arrived')
  const after = await st(async (rid) => {
    const a = window.__viku.api()
    for (const ps of await a.listProjects()) {
      const r = (await a.getProject(ps.id)).reels.find((x) => x.id === rid)
      if (r) return r.cutaways.map((c) => (c.img ? c.img.split(/[\\/]/).pop() : null))
    }
    return null
  }, REEL)
  log('cutaway images now:', JSON.stringify(after))
  if (after.some((x) => !x)) throw new Error('a cutaway is still empty')
  await sleep(500)
  await page.screenshot({ path: join(shots, 'ai-images-done.png') })
} catch (e) {
  failed = e
  log('FAILED:', e instanceof Error ? e.stack : String(e))
  await page.screenshot({ path: join(shots, 'ai-images-zz-failure.png') }).catch(() => undefined)
}
log('console errors:', errors.length, errors.slice(0, 3))
await app.close()
process.exit(failed ? 1 : 0)
