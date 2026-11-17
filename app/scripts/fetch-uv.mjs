// Downloads the official uv release for Windows x86_64 (pinned), verifies its SHA-256 against the release's own
// checksum file AND the hash pinned below, unpacks uv.exe into vendor/uv/ and keeps uv's licences next to it.
// The installer ships vendor/uv/ as extraResources (resources/uv/). Run: node scripts/fetch-uv.mjs [--force]
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const UV_VERSION = '0.12.4' // same uv that wrote engine/uv.lock
const ASSET = 'uv-x86_64-pc-windows-msvc.zip'
// pinned from https://github.com/astral-sh/uv/releases/download/0.12.4/uv-x86_64-pc-windows-msvc.zip.sha256
const PINNED_SHA256 = '4f3b7d63cd81fca0da5a655d973d20affca89ce6e5f9a29fd0183cc4204a7639'
const BASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`
const LICENCES = ['LICENSE-MIT', 'LICENSE-APACHE']

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'vendor', 'uv')
const stamp = join(out, 'VERSION.txt')

if (!process.argv.includes('--force') && existsSync(join(out, 'uv.exe')) && existsSync(stamp) && readFileSync(stamp, 'utf8').startsWith(UV_VERSION)) {
  console.log(`uv ${UV_VERSION} already in vendor/uv`)
  process.exit(0)
}

async function get(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'viku-build' } })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

const sumFile = (await get(`${BASE}/${ASSET}.sha256`)).toString('utf8').trim()
const published = sumFile.split(/\s+/)[0].toLowerCase()
if (published !== PINNED_SHA256) throw new Error(`release checksum ${published} != pinned ${PINNED_SHA256}`)
const zip = await get(`${BASE}/${ASSET}`)
const actual = createHash('sha256').update(zip).digest('hex')
if (actual !== PINNED_SHA256) throw new Error(`downloaded ${ASSET} has SHA-256 ${actual}, expected ${PINNED_SHA256}`)
console.log(`verified ${ASSET} (${(zip.length / 1e6).toFixed(1)} MB) sha256 ${actual}`)

// unpack in an empty temp folder (untrusted archive), copy only uv.exe out
const tmp = join(tmpdir(), `viku-uv-${Date.now()}`)
mkdirSync(tmp, { recursive: true })
const zpath = join(tmp, ASSET)
writeFileSync(zpath, zip)
const unpack = join(tmp, 'x')
mkdirSync(unpack)
// Windows' own bsdtar reads zip (a GNU tar earlier on PATH, e.g. Git's, does not)
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
execFileSync(tar, ['-xf', zpath, '-C', unpack], { stdio: 'inherit' })
const exe = [join(unpack, 'uv.exe'), join(unpack, ASSET.replace('.zip', ''), 'uv.exe')].find((p) => existsSync(p))
if (!exe) throw new Error('uv.exe not found in the archive')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
copyFileSync(exe, join(out, 'uv.exe'))
rmSync(tmp, { recursive: true, force: true })

for (const name of LICENCES) {
  const text = await get(`https://raw.githubusercontent.com/astral-sh/uv/${UV_VERSION}/${name}`)
  writeFileSync(join(out, name), text)
}
writeFileSync(
  stamp,
  `${UV_VERSION}\n${ASSET} sha256 ${actual}\nsource ${BASE}/${ASSET}\nuv is dual-licensed MIT OR Apache-2.0 (Astral Software Inc.), see LICENSE-MIT / LICENSE-APACHE.\n`
)
console.log(`uv ${UV_VERSION} -> ${out}`)
