// Renders build/icon.svg (and the simplified build/icon-small.svg for <= 32 px) to PNGs and packs build/icon.ico.
// Usage: node scripts/make-icons.mjs   (needs an installed Chrome or Edge; output is committed, so rarely re-run)
import { chromium } from 'playwright-core'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const build = join(root, 'build')
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512]
const browsers = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
]
const exe = browsers.find((p) => existsSync(p))
if (!exe) throw new Error('No Chrome / Edge found')

const big = readFileSync(join(build, 'icon.svg'), 'utf8')
const small = readFileSync(join(build, 'icon-small.svg'), 'utf8')
const browser = await chromium.launch({ executablePath: exe })
const page = await browser.newPage({ deviceScaleFactor: 1 })
mkdirSync(join(build, 'icons'), { recursive: true })

const pngs = {}
for (const s of SIZES) {
  const svg = (s <= 32 ? small : big).replace(/width="\d+" height="\d+"/, `width="${s}" height="${s}"`)
  await page.setViewportSize({ width: s, height: s })
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`)
  const buf = await page.locator('svg').screenshot({ omitBackground: true })
  pngs[s] = buf
  writeFileSync(join(build, 'icons', `${s}x${s}.png`), buf)
}
await browser.close()

writeFileSync(join(build, 'icon.png'), pngs[512])
mkdirSync(join(root, 'resources'), { recursive: true })
copyFileSync(join(build, 'icon.png'), join(root, 'resources', 'icon.png'))

// ICO container with PNG-compressed entries (Windows Vista+).
const entries = [16, 24, 32, 48, 64, 128, 256]
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(entries.length, 4)
const dir = Buffer.alloc(16 * entries.length)
let offset = 6 + dir.length
entries.forEach((s, i) => {
  const b = pngs[s]
  const o = i * 16
  dir.writeUInt8(s >= 256 ? 0 : s, o)
  dir.writeUInt8(s >= 256 ? 0 : s, o + 1)
  dir.writeUInt8(0, o + 2)
  dir.writeUInt8(0, o + 3)
  dir.writeUInt16LE(1, o + 4)
  dir.writeUInt16LE(32, o + 6)
  dir.writeUInt32LE(b.length, o + 8)
  dir.writeUInt32LE(offset, o + 12)
  offset += b.length
})
writeFileSync(join(build, 'icon.ico'), Buffer.concat([header, dir, ...entries.map((s) => pngs[s])]))
console.log('wrote build/icon.ico, build/icon.png, build/icons/*.png, resources/icon.png')
