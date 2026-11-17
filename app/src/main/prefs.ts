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
  return {
    adapter: 'auto',
    engineUrl: 'http://127.0.0.1:8765',
    engineCommand: 'uv run viku-engine',
    engineCwd: resolve(appRoot, '..', 'engine'),
    autoStartEngine: true,
    capturesDir: join(app.getPath('userData'), 'captures', 'pending'),
    onboarded: false
  }
}

let cache: Stored | null = null

function file(): string {
  return join(app.getPath('userData'), 'prefs.json')
}

export function loadPrefs(): Stored {
  if (cache) return cache
  const base = defaults()
  try {
    if (existsSync(file())) {
      const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Stored>
      cache = { ...base, ...parsed }
      return cache
    }
  } catch {
    /* corrupt prefs: fall back to defaults */
  }
  cache = base
  return cache
}

export function savePrefs(patch: Partial<Stored>): Stored {
  const next: Stored = { ...loadPrefs(), ...patch }
  cache = next
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(file(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* non-fatal */
  }
  return next
}

export function publicPrefs(): Prefs {
  const { adapter, engineUrl, engineCommand, engineCwd, autoStartEngine, capturesDir, onboarded } = loadPrefs()
  return { adapter, engineUrl, engineCommand, engineCwd, autoStartEngine, capturesDir, onboarded }
}
