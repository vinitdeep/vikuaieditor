import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { EngineRequest, EngineResponse, EngineStatus, Prefs, SetupStatus } from '../shared/ipc'
import { bundlePaths, runBootstrap, setupNeeded } from './bundle'

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
  private setupRun: Promise<boolean> | null = null
  status: EngineStatus

  constructor(
    private prefs: () => Prefs,
    private packaged: boolean
  ) {
    super()
    this.status = { state: 'checking', url: prefs().engineUrl, spawned: false, bundled: this.bundled(), log: [] }
  }

  /** the installed app runs the engine it ships (unless the user chose a custom engine in Settings) */
  bundled(): boolean {
    return this.packaged && this.prefs().engineSource !== 'custom'
  }

  private set(patch: Partial<EngineStatus>): void {
    this.status = { ...this.status, ...patch, url: this.prefs().engineUrl, bundled: this.bundled(), log: this.log.slice(-40) }
    this.emit('status', this.status)
  }

  /**
   * First launch of the installed app: bootstrap.ps1 builds <install>/engine-env (Python 3.11 + packages from uv.lock).
   * Shows as state 'setup' with the PROGRESS lines; returns false when it failed.
   */
  private runSetup(): Promise<boolean> {
    if (this.setupRun) return this.setupRun
    const setup: SetupStatus = { pct: 0, message: 'Preparing the Viku engine…', log: [] }
    const push = (): void => this.set({ state: 'setup', message: setup.message, setup: { ...setup, log: setup.log.slice(-60) } })
    push()
    this.pushLog('$ bootstrap.ps1 (first-run engine setup)')
    this.setupRun = runBootstrap((l) => {
      if (l.kind === 'progress') {
        setup.pct = Math.max(setup.pct, l.pct ?? setup.pct)
        setup.message = l.message
      } else if (l.kind === 'ready') {
        setup.pct = 100
        setup.message = 'Engine environment ready'
      } else if (l.kind === 'error') {
        setup.error = l.message
      }
      setup.log.push(l.kind === 'progress' ? `${l.pct}% ${l.message}` : l.message)
      this.pushLog(l.message)
      push()
    }).then((err) => {
      this.setupRun = null
      if (err) {
        setup.error = err
        this.set({ state: 'error', message: `Engine setup failed: ${err}`, setup: { ...setup, log: setup.log.slice(-60) } })
        return false
      }
      setup.done = true
      this.set({ setup: { ...setup, log: setup.log.slice(-60) } })
      return true
    })
    return this.setupRun
  }

  /** "Try again" on the setup screen: rerun the bootstrap even when the stamp says it is current. */
  async setupRetry(): Promise<EngineStatus> {
    await this.kill()
    this.stopping = false
    if (!this.bundled()) return this.ensure()
    const ok = await this.runSetup()
    if (!ok) return this.status
    return this.spawnEngine()
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
    if (this.bundled() && !process.env.VIKU_NO_ENGINE && p.adapter !== 'mock' && setupNeeded()) {
      // the installed app's engine environment is missing (first launch) or from another version
      const ok = await this.runSetup()
      if (!ok) {
        this.startWatch()
        return this.status
      }
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
    const bundled = this.bundled()
    const b = bundled ? bundlePaths() : null
    const cwd = b ? b.engineDir : p.engineCwd
    if (b && !existsSync(b.engineExe)) {
      if (!(await this.runSetup())) return this.status
    }
    if (!existsSync(cwd)) {
      this.set({ state: 'error', message: `Engine folder not found: ${cwd}` })
      return this.status
    }
    let port = ''
    try {
      port = new URL(p.engineUrl).port
    } catch {
      /* keep the engine's default */
    }
    this.pushLog(b ? `$ ${b.engineExe}` : `$ ${p.engineCommand}   (in ${p.engineCwd})`)
    this.set({ state: 'starting', message: 'Starting engine…', spawned: true })
    try {
      // packaged: the bundled starter content (illustrations) lives in <resources>/starter
      const starter = app.isPackaged ? join(process.resourcesPath, 'starter') : ''
      const env = {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1',
        ...(port ? { VIKU_PORT: port } : {}),
        ...(starter && existsSync(starter) && !process.env.VIKU_STARTER ? { VIKU_STARTER: starter } : {})
      }
      // bundled: run the venv's console script directly (no shell, path may contain spaces)
      const child = b
        ? spawn(b.engineExe, [], { cwd, windowsHide: true, env })
        : spawn(p.engineCommand, { cwd, shell: true, windowsHide: true, env })
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
        if (this.status.state === 'setup') return
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
    if (this.proc || this.setupRun) return this.status
    this.stopping = false
    if (this.bundled() && setupNeeded()) {
      if (!(await this.runSetup())) return this.status
    }
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
