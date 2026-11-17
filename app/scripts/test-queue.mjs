// AI Studio queue persistence (mock data, isolated profile):
//  1. queue a generation for an empty cutaway -> gemini-queue.json holds it with its meta
//  2. reload the window -> the cutaway still shows "queued"
//  3. quit, mark the prompt captured in the JSON (as if AI Studio delivered while Viku was closed), restart
//     -> resumeQueue attaches the image to the cutaway and marks it attached
// Usage: npm run build && node scripts/test-queue.mjs
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const profile = join(tmpdir(), `viku-queue-${Date.now()}`)
const qfile = join(profile, 'gemini-queue.json')
const ok = (c, m) => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`)
  if (!c) process.exitCode = 1
}
const launch = () =>
  electron.launch({
    executablePath: require('electron'),
    args: [root],
    env: { ...process.env, VIKU_QUERY: 'adapter=mock&debug=1&no-onboarding=1', VIKU_NO_ENGINE: '1', VIKU_USER_DATA: profile }
  })
const ready = async (page) => {
  await page.waitForSelector('.topbar', { timeout: 30000 })
  await page.waitForFunction(() => window.__viku?.useEditor.getState().project, null, { timeout: 30000 })
}
// pick (or make) an empty cutaway in the open reel
const target = (page) =>
  page.evaluate(() => {
    const v = window.__viku
    const p = v.useEditor.getState().project
    for (const r of p.reels) {
      const i = r.cutaways.findIndex((c) => !c.img)
      if (i >= 0) {
        v.useEditor.getState().openReel(r.id)
        return { reelId: r.id, index: i, t0: r.cutaways[i].t0 }
      }
    }
    const r = p.reels[0]
    v.useEditor.getState().openReel(r.id)
    v.useEditor.getState().edit('Add cutaway', (x) => void x.cutaways.push({ t0: 30, t1: 34, img: '', z0: 1, z1: 1.1, pan: [0, 0] }))
    return { reelId: r.id, index: r.cutaways.length, t0: 30 }
  })

let app = await launch()
let page = await app.firstWindow()
await ready(page)
const tg = await target(page)
console.log('target', tg)
await page.evaluate(({ reelId, index }) => window.__viku.generateForCutaway(reelId, index), tg)
await page.waitForTimeout(1200)
ok(existsSync(qfile), 'gemini-queue.json written')
const q1 = JSON.parse(readFileSync(qfile, 'utf8'))
const item = q1.items.find((i) => i.meta?.reelId === tg.reelId)
ok(Boolean(item) && item.status === 'queued' && typeof item.meta.t0 === 'number', `queued item with meta ${JSON.stringify(item?.meta)}`)

await page.reload()
await ready(page)
await page.waitForTimeout(1500)
const queuedAfterReload = await page.evaluate(() => Object.keys(window.__viku.useGen?.getState().queued ?? {}))
const badge = await page.locator('.clip-cutaway.queued').count()
ok(badge > 0 || queuedAfterReload.length > 0, `after reload the cutaway still shows queued (badges ${badge})`)
await app.close()

// simulate a capture that arrived while Viku was closed
const img = join(profile, 'captured.png')
const lib = join(root, 'build', 'icons')
const png = readdirSync(lib).find((f) => f.endsWith('.png'))
copyFileSync(join(lib, png), img)
const q2 = JSON.parse(readFileSync(qfile, 'utf8'))
for (const i of q2.items) if (i.id === item.id) Object.assign(i, { status: 'captured', file: img, via: 'download' })
writeFileSync(qfile, JSON.stringify(q2, null, 2))

app = await launch()
page = await app.firstWindow()
await ready(page)
await page.waitForTimeout(2500)
const after = await page.evaluate(({ reelId, t0 }) => {
  const r = window.__viku.useEditor.getState().project.reels.find((x) => x.id === reelId)
  return r?.cutaways.find((c) => Math.abs(c.t0 - t0) < 0.02)?.img ?? null
}, tg)
ok(after === img, `after restart the late capture is on the cutaway (${after})`)
const q3 = JSON.parse(readFileSync(qfile, 'utf8'))
ok(q3.items.find((i) => i.id === item.id)?.meta?.attached === true, 'queue item marked attached')
await page.screenshot({ path: join(root, 'screenshots', 'queue-resumed.png') })
await app.close()
