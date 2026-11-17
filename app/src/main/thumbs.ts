import { nativeImage, protocol } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { imageInfo } from './imageSize'

/**
 * `viku-thumb://img/?p=<absolute path>&w=<px>` → a small JPEG of a local image, cached on disk.
 * The library holds 1536×2752 PNGs (~8 MB each); the grid and the timeline only need ~320 px wide.
 * Windows shell thumbnails are tried first (async, off the main thread); when their aspect ratio is off
 * we fall back to decoding + resizing with nativeImage. Cache key = path + size + mtime + width.
 */
export const THUMB_SCHEME = 'viku-thumb'
const IMG_RE = /\.(png|jpe?g|webp|gif|bmp)$/i
const MAX_PARALLEL = 3

export function registerThumbScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: THUMB_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
}

export function handleThumbs(cacheDir: () => string): void {
  const inflight = new Map<string, Promise<string>>()
  let active = 0
  const waiters: (() => void)[] = []
  const slot = async (): Promise<() => void> => {
    if (active >= MAX_PARALLEL) await new Promise<void>((r) => waiters.push(r))
    active++
    return () => {
      active--
      waiters.shift()?.()
    }
  }

  const make = async (src: string, w: number, out: string): Promise<string> => {
    const release = await slot()
    try {
      const head = readHead(src)
      const info = head ? imageInfo(head) : null
      let img: Electron.NativeImage | null = null
      try {
        const t = await nativeImage.createThumbnailFromPath(src, { width: w, height: Math.round(w * 2.4) })
        const s = t.getSize()
        const ok = !t.isEmpty() && (!info || Math.abs(s.width / s.height - info.width / info.height) < 0.03)
        if (ok) img = s.width > w ? t.resize({ width: w, quality: 'good' }) : t
      } catch {
        /* no shell thumbnail: decode below */
      }
      if (!img) {
        const full = nativeImage.createFromBuffer(await readFile(src))
        if (full.isEmpty()) throw new Error('not an image')
        img = full.getSize().width > w ? full.resize({ width: w, quality: 'good' }) : full
      }
      await writeFile(out, img.toJPEG(84))
      return out
    } finally {
      release()
    }
  }

  protocol.handle(THUMB_SCHEME, async (req) => {
    try {
      const u = new URL(req.url)
      const src = u.searchParams.get('p') ?? ''
      const w = Math.max(32, Math.min(1080, Number(u.searchParams.get('w')) || 320))
      if (!src || !IMG_RE.test(src) || !existsSync(src)) return new Response('not found', { status: 404 })
      const st = statSync(src)
      const key = createHash('sha1').update(`${src}|${st.size}|${st.mtimeMs}|${w}`).digest('hex').slice(0, 24)
      const dir = cacheDir()
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const out = join(dir, `${key}.jpg`)
      if (!existsSync(out)) {
        let p = inflight.get(out)
        if (!p) {
          p = make(src, w, out).finally(() => inflight.delete(out))
          inflight.set(out, p)
        }
        await p
      }
      return new Response(await readFile(out), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'max-age=31536000, immutable' } })
    } catch (e) {
      return new Response(e instanceof Error ? e.message : 'error', { status: 500 })
    }
  })
}

function readHead(p: string): Buffer | null {
  try {
    const fd = openSync(p, 'r')
    try {
      const buf = Buffer.alloc(256 * 1024)
      const n = readSync(fd, buf, 0, buf.length, 0)
      return buf.subarray(0, n)
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}
