import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

/**
 * Local bridge for the Viku browser extension (extension/ at the repo root).
 *
 * Google blocks AI Studio in embedded views and in remote-controlled browsers, so the church's own signed-in Chrome /
 * Edge runs the prompts through the extension instead. The extension's service worker calls this server on
 * 127.0.0.1 only; requests must come from a browser extension (Origin chrome-extension://...), so web pages cannot
 * read the queue or push pictures in.
 */
export interface ExtHandler {
  extHello(info: ExtHelloInfo): ExtHello
  extNext(): { item: { id: string; prompt: string; name: string } | null; model: string }
  extResult(id: string, buf: Buffer): { ok: boolean; file?: string; error?: string }
  extFail(id: string, error: string, kind: string): { ok: boolean; pause: boolean }
}

export interface ExtHelloInfo {
  version?: string
  enabled?: boolean
  page?: string
  state?: string
  note?: string
}

export interface ExtHello {
  app: 'viku'
  version: string
  /** Viku is in "Your browser" mode, so the extension should work */
  enabled: boolean
  waiting: number
  model: string
  paused: boolean
}

export const EXT_PORTS = [47917, 47918, 47919, 47920, 47921]
const MAX_BODY = 40 * 1024 * 1024

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, ko) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        ko(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')))
    req.on('error', ko)
  })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Starts on the first free port of EXT_PORTS (or VIKU_EXT_PORT). Resolves to the port, or null if none was free. */
export function startExtBridge(h: ExtHandler): Promise<number | null> {
  const forced = Number(process.env.VIKU_EXT_PORT) || 0
  const ports = forced ? [forced] : EXT_PORTS
  const server = createServer((req, res) => {
    void (async () => {
      const origin = String(req.headers.origin ?? '')
      if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return json(res, 403, { error: 'extension only' })
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
      let body: Record<string, unknown>
      try {
        const text = await readBody(req)
        body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
      } catch {
        return json(res, 400, { error: 'bad body' })
      }
      const url = (req.url ?? '').split('?')[0]
      try {
        if (url === '/viku/hello') return json(res, 200, h.extHello(body as ExtHelloInfo))
        if (url === '/viku/next') return json(res, 200, h.extNext())
        if (url === '/viku/result') {
          const id = String(body.id ?? '')
          const b64 = String(body.b64 ?? '')
          if (!id || !b64) return json(res, 400, { error: 'id and b64 required' })
          return json(res, 200, h.extResult(id, Buffer.from(b64, 'base64')))
        }
        if (url === '/viku/fail') return json(res, 200, h.extFail(String(body.id ?? ''), String(body.error ?? 'failed'), String(body.kind ?? 'error')))
        return json(res, 404, { error: 'unknown' })
      } catch (err) {
        return json(res, 500, { error: String(err) })
      }
    })()
  })
  return new Promise((resolve) => {
    let i = 0
    const tryNext = (): void => {
      if (i >= ports.length) return resolve(null)
      const port = ports[i++]
      server.once('error', tryNext)
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error')
        server.on('error', () => undefined)
        resolve(port)
      })
    }
    tryNext()
  })
}
