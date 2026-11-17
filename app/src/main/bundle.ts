import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The installed app's own engine:
 *   <resources>/engine/            engine sources + uv.lock + scripts/bootstrap.ps1 (extraResources)
 *   <resources>/uv/uv.exe          the official uv release (pinned + SHA-256 verified at build time)
 *   <install>/engine-env/          created on first launch by bootstrap.ps1:
 *       engine/.venv/              uv sync --frozen --no-dev --group asr
 *       python/                    uv-managed CPython 3.11
 * The engine then runs as <install>/engine-env/engine/.venv/Scripts/viku-engine.exe (data in %APPDATA%\Viku, or VIKU_DATA).
 */
export interface BundlePaths {
  resources: string
  engineSrc: string
  uv: string
  bootstrap: string
  env: string
  engineDir: string
  engineExe: string
  stamp: string
}

export function bundlePaths(): BundlePaths {
  const resources = process.resourcesPath
  const engineSrc = join(resources, 'engine')
  // VIKU_ENGINE_ENV: tests can point the environment somewhere else
  const env = process.env.VIKU_ENGINE_ENV || join(dirname(app.getPath('exe')), 'engine-env')
  const engineDir = join(env, 'engine')
  return {
    resources,
    engineSrc,
    uv: join(resources, 'uv', 'uv.exe'),
    bootstrap: join(engineSrc, 'scripts', 'bootstrap.ps1'),
    env,
    engineDir,
    engineExe: join(engineDir, '.venv', 'Scripts', 'viku-engine.exe'),
    stamp: join(env, 'viku-app.json')
  }
}

function lockHash(p: BundlePaths): string {
  try {
    return createHash('sha256').update(readFileSync(join(p.engineSrc, 'uv.lock'))).digest('hex')
  } catch {
    return ''
  }
}

/** True when the environment is missing or was made by another app version (engine files / lock changed). */
export function setupNeeded(p = bundlePaths()): boolean {
  if (!existsSync(p.engineExe)) return true
  try {
    const s = JSON.parse(readFileSync(p.stamp, 'utf8')) as { app?: string; lock?: string }
    return s.app !== app.getVersion() || s.lock !== lockHash(p)
  } catch {
    return true
  }
}

export interface BootstrapLine {
  kind: 'progress' | 'ready' | 'error' | 'log'
  pct?: number
  message: string
}

/**
 * Run bootstrap.ps1 in a hidden PowerShell (-ExecutionPolicy Bypass), -NoStart: the app starts (and owns) the engine.
 * Resolves with the error message, or null on success.
 */
export function runBootstrap(onLine: (l: BootstrapLine) => void, p = bundlePaths()): Promise<string | null> {
  return new Promise((resolve) => {
    if (!existsSync(p.bootstrap)) return resolve(`bootstrap.ps1 not found at ${p.bootstrap}`)
    if (!existsSync(p.uv)) return resolve(`uv.exe not found at ${p.uv}`)
    const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      p.bootstrap,
      '-Uv',
      p.uv,
      '-InstallDir',
      p.env,
      '-EngineSrc',
      p.engineSrc,
      '-NoStart',
      '-CleanCache'
    ]
    let error: string | null = null
    let ready = false
    let buf = ''
    const child = spawn(existsSync(ps) ? ps : 'powershell.exe', args, { windowsHide: true, cwd: p.resources, env: { ...process.env, PYTHONUTF8: '1' } })
    const handle = (line: string): void => {
      const t = line.trim()
      if (!t) return
      let m: RegExpMatchArray | null
      if ((m = t.match(/^PROGRESS\s+(\d+)\s*(.*)$/))) onLine({ kind: 'progress', pct: Number(m[1]), message: m[2] })
      else if ((m = t.match(/^READY\s*(.*)$/))) {
        ready = true
        onLine({ kind: 'ready', pct: 100, message: m[1] })
      } else if ((m = t.match(/^ERROR\s*(.*)$/))) {
        error = m[1] || 'setup failed'
        onLine({ kind: 'error', message: error })
      } else onLine({ kind: 'log', message: t })
    }
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      let i: number
      while ((i = buf.search(/\r?\n/)) >= 0) {
        handle(buf.slice(0, i))
        buf = buf.slice(i).replace(/^\r?\n/, '')
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      for (const l of d.toString('utf8').split(/\r?\n/)) if (l.trim()) onLine({ kind: 'log', message: l.trim() })
    })
    child.on('error', (e) => resolve(`could not run PowerShell: ${e.message}`))
    child.on('exit', (code) => {
      if (buf) handle(buf)
      if (!error && (code !== 0 || !ready)) error = `setup exited with code ${code ?? '?'}`
      if (!error) {
        try {
          writeFileSync(p.stamp, JSON.stringify({ app: app.getVersion(), lock: lockHash(p), t: new Date().toISOString() }, null, 2), 'utf8')
        } catch (e) {
          error = `could not write ${p.stamp}: ${e instanceof Error ? e.message : String(e)}`
        }
      }
      resolve(error)
    })
  })
}
