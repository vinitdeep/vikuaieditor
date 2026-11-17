import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Prefs, Rect } from '../shared/ipc'

interface Stored extends Prefs {
  windowBounds?: Rect & { maximized?: boolean }
}

function defaults(): Stored {
  // In dev the app lives at <root>/app, the engine at <root>/engine.
  const appRoot = app.isPackaged ? resolve(process.resourcesPath) : resolve(app.getAppPath())
  const port = Number(process.env.VIKU_PORT) || 8765
  return {
    adapter: 'auto',
    engineUrl: `http://127.0.0.1:${port}`,
    engineCommand: 'uv run viku-engine',
    engineCwd: app.isPackaged ? join(appRoot, 'engine') : resolve(appRoot, '..', 'engine'),
    autoStartEngine: true,
    capturesDir: join(app.getPath('userData'), 'captures', 'pending'),
    onboarded: false,
    engineSource: app.isPackaged ? 'bundled' : 'custom',
    modelsMirror: '',
    geminiMode: 'browser',
    downloadsDir: app.getPath('downloads')
  }
}

/** Only what the user changed is written to prefs.json; defaults are recomputed at every start. */
let raw: Partial<Stored> | null = null

function file(): string {
  return join(app.getPath('userData'), 'prefs.json')
}

function readRaw(): Partial<Stored> {
  if (raw) return raw
  try {
    if (existsSync(file())) {
      raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Stored>
      return raw
    }
  } catch {
    /* corrupt prefs: fall back to defaults */
  }
  raw = {}
  return raw
}

export function loadPrefs(): Stored {
  const merged: Stored = { ...defaults(), ...readRaw() }
  // an explicit port for this run (tests, a second engine) wins over the stored URL
  if (process.env.VIKU_PORT) merged.engineUrl = `http://127.0.0.1:${Number(process.env.VIKU_PORT)}`
  // the packaged app never runs `uv run` from a folder unless the user picked a custom engine
  if (app.isPackaged && merged.engineSource !== 'custom') merged.engineSource = 'bundled'
  return merged
}

export function savePrefs(patch: Partial<Stored>): Stored {
  const d = defaults()
  const next: Partial<Stored> = { ...readRaw(), ...patch }
  // drop values equal to their default, so a later version's defaults apply
  for (const k of Object.keys(next) as (keyof Stored)[]) {
    if (k !== 'windowBounds' && JSON.stringify(next[k]) === JSON.stringify(d[k])) delete next[k]
  }
  raw = next
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(file(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* non-fatal */
  }
  return loadPrefs()
}

export function publicPrefs(): Prefs {
  const { adapter, engineUrl, engineCommand, engineCwd, autoStartEngine, capturesDir, onboarded, engineSource, modelsMirror, geminiMode, downloadsDir } = loadPrefs()
  return { adapter, engineUrl, engineCommand, engineCwd, autoStartEngine, capturesDir, onboarded, engineSource, modelsMirror, geminiMode, downloadsDir }
}
