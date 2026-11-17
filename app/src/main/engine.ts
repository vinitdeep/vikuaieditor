import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import type { EngineRequest, EngineResponse, EngineStatus, Prefs } from '../shared/ipc'

const LOG_LINES = 200

/**
 * Owns the connection to the Python engine:
 *  - probes GET /health, spawns the configured command when it is down (and kills it on quit)
 *  - proxies JSON requests for the renderer (no CORS / webSecurity concerns)
 *  - holds one SSE connection to GET /events and re-emits each payload
 */
export class EngineManager extends EventEmitter {
  private proc: ChildProcess | null = null
  private log: string[] = []
  private sseAbort: AbortController | null = null
  private sseRetry: NodeJS.Timeout | null = null
  private watch: NodeJS.Timeout | null = null
  private stopping = false
  status: EngineStatus

  constructor(private prefs: () => Prefs) {
    super()
    this.status = { state: 'checking', url: prefs().engineUrl, spawned: false, log: [] }
  }

  private set(patch: Partial<EngineStatus>): void {
    this.status = { ...this.status, ...patch, url: this.prefs().engineUrl, log: this.log.slice(-40) }
    this.emit('status', this.status)
  }

  private pushLog(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim()) this.log.push(line)
    }
    if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES)
  }

  async health(timeoutMs = 1500): Promise<boolean> {
    const res = await this.request({ method: 'GET', path: '/health', timeoutMs })
    return res.ok
  }

  async request(req: EngineRequest): Promise<EngineResponse> {
    const url = this.prefs().engineUrl.replace(/\/$/, '') + req.path
    try {
      const res = await fetch(url, {
        method: req.method,
        headers: req.body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(req.timeoutMs ?? 30000)
      })
      const text = await res.text()
      let data: unknown = text
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        /* keep text */
      }
      const error = res.ok ? undefined : extractError(data) ?? `HTTP ${res.status}`
      return { ok: res.ok, status: res.status, data, error }
    } catch (e) {
      return { ok: false, status: 0, data: null, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** Called at startup and from "Restart engine". */
  async ensure(): Promise<EngineStatus> {
    const p = this.prefs()
    this.set({ state: 'checking', message: 'Checking engine…' })
    if (await this.health()) {
      this.set({ state: 'running', message: 'Engine is running' })
      this.startEvents()
      this.startWatch()
      return this.status
    }
    if (p.adapter === 'mock' || !p.autoStartEngine || process.env.VIKU_NO_ENGINE) {
      this.set({ state: 'stopped', message: p.adapter === 'mock' ? 'Mock data mode' : 'Engine not running' })
      // keep watching: connect as soon as an engine started elsewhere answers
      this.startWatch()
      return this.status
    }
    return this.spawnEngine()
  }

  private async spawnEngine(): Promise<EngineStatus> {
    const p = this.prefs()
    if (!existsSync(p.engineCwd)) {
      this.set({ state: 'error', message: `Engine folder not found: ${p.engineCwd}` })
      return this.status
    }
    this.pushLog(`$ ${p.engineCommand}   (in ${p.engineCwd})`)
    this.set({ state: 'starting', message: 'Starting engine…', spawned: true })
    try {
      const child = spawn(p.engineCommand, {
        cwd: p.engineCwd,
        shell: true,
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' }
      })
      this.proc = child
      child.stdout?.on('data', (d: Buffer) => this.pushLog(d.toString('utf8')))
      child.stderr?.on('data', (d: Buffer) => this.pushLog(d.toString('utf8')))
      child.on('exit', (code) => {
        this.proc = null
        this.stopEvents()
        if (!this.stopping) this.set({ state: 'error', spawned: false, message: `Engine exited (code ${code ?? '?'})` })
      })
    } catch (e) {
      this.set({ state: 'error', message: e instanceof Error ? e.message : String(e) })
      return this.status
    }
    // First `uv run` may sync a venv: allow up to 3 minutes.
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline && this.proc) {
      await sleep(1000)
      if (await this.health(1200)) {
        this.set({ state: 'running', message: 'Engine is running' })
        this.startEvents()
        this.startWatch()
        return this.status
      }
    }
    if (this.status.state === 'starting') this.set({ state: 'error', message: 'Engine did not answer /health in time' })
    return this.status
  }

  /** Light liveness watch: flips the status dot when the engine goes away or comes back. */
  private startWatch(): void {
    if (this.watch) return
    this.watch = setInterval(() => {
      void this.health(2000).then((ok) => {
        if (ok && this.status.state !== 'running') {
          this.set({ state: 'running', message: 'Engine is running' })
          this.startEvents()
        } else if (!ok && this.status.state === 'running') {
          this.set({ state: 'stopped', message: 'Engine stopped responding' })
          this.stopEvents()
        }
      })
    }, 5000)
  }

  private startEvents(): void {
    if (this.sseAbort) return
    const ctrl = new AbortController()
    this.sseAbort = ctrl
    const url = this.prefs().engineUrl.replace(/\/$/, '') + '/events'
    void (async () => {
      try {
        const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: ctrl.signal })
        if (!res.ok || !res.body) throw new Error(`events HTTP ${res.status}`)
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
            const block = buf.slice(0, idx)
            buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '')
            const data = block
              .split(/\r?\n/)
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).replace(/^ /, ''))
              .join('\n')
            if (!data) continue
            try {
              this.emit('event', JSON.parse(data))
            } catch {
              /* ignore keep-alives / non-JSON */
            }
          }
        }
      } catch {
        /* connection dropped */
      }
      if (this.sseAbort === ctrl) {
        this.sseAbort = null
        if (!this.stopping && this.status.state === 'running') {
          this.sseRetry = setTimeout(() => this.startEvents(), 2000)
        }
      }
    })()
  }

  private stopEvents(): void {
    if (this.sseRetry) clearTimeout(this.sseRetry)
    this.sseRetry = null
    this.sseAbort?.abort()
    this.sseAbort = null
  }

  /** "Start engine" button: spawn even when auto-start is off (no-op when it already answers). */
  async start(): Promise<EngineStatus> {
    if (await this.health()) {
      this.set({ state: 'running', message: 'Engine is running' })
      this.startEvents()
      this.startWatch()
      return this.status
    }
    if (this.proc) return this.status
    this.stopping = false
    return this.spawnEngine()
  }

  async restart(): Promise<EngineStatus> {
    await this.kill()
    this.stopping = false
    return this.ensure()
  }

  /** Kill only what we spawned. */
  async kill(): Promise<void> {
    this.stopping = true
    this.stopEvents()
    if (this.watch) clearInterval(this.watch)
    this.watch = null
    const child = this.proc
    this.proc = null
    if (!child || child.pid === undefined) return
    const pid = child.pid
    await new Promise<void>((done) => {
      if (process.platform === 'win32') {
        // shell:true means the python process is a grandchild: kill the whole tree.
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => done())
      } else {
        child.kill('SIGTERM')
        done()
      }
    })
    this.set({ state: 'stopped', spawned: false, message: 'Engine stopped' })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function extractError(data: unknown): string | undefined {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    if (typeof d.detail === 'string') return d.detail
    if (typeof d.error === 'string') return d.error
    if (typeof d.message === 'string') return d.message
    if (Array.isArray(d.detail)) return JSON.stringify(d.detail)
  }
  if (typeof data === 'string' && data.length < 300) return data
  return undefined
}
