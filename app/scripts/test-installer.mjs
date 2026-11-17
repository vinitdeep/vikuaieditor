// End-to-end test of the real installer:
//   silent per-user install into %TEMP%\viku-install-test -> launch the installed Viku.exe with a fresh VIKU_DATA
//   -> "Setting up Viku" runs bootstrap.ps1 -> engine answers /health -> onboarding shows the models
//   -> install one small required item (fonts) through the UI -> quit -> silent uninstall -> temp dirs removed.
// Usage: npm run dist && node scripts/test-installer.mjs [--keep]
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse((await import('node:fs')).readFileSync(join(root, 'package.json'), 'utf8'))
const setup = join(root, 'release', `Viku-Setup-${pkg.version}.exe`)
const installDir = join(tmpdir(), 'viku-install-test')
const dataDir = join(tmpdir(), 'viku-install-data')
const shots = join(root, 'screenshots')
const PORT = 8799
const keep = process.argv.includes('--keep')
mkdirSync(shots, { recursive: true })
const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync(setup)) throw new Error(`build the installer first: ${setup}`)
log(`installer ${setup} (${(statSync(setup).size / 1e6).toFixed(1)} MB)`)
for (const d of [installDir, dataDir]) rmSync(d, { recursive: true, force: true })

// 1. silent per-user install (/S, /currentuser, /D must be last and unquoted)
const r = spawnSync(setup, ['/S', '/currentuser', `/D=${installDir}`], { stdio: 'inherit' })
log('installer exit', r.status)
const exe = join(installDir, 'Viku.exe')
for (let i = 0; i < 60 && !existsSync(exe); i++) await sleep(1000)
if (!existsSync(exe)) throw new Error('Viku.exe not installed')
log('installed:', readdirSync(installDir).join(', '))
const lnk = [join(process.env.USERPROFILE, 'Desktop', 'Viku.lnk'), join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Viku.lnk')]
log('shortcuts:', lnk.map((p) => `${p} ${existsSync(p) ? 'OK' : 'MISSING'}`).join(' | '))

// 2. launch the installed app with a fresh data dir
const app = await electron.launch({
  executablePath: exe,
  args: [],
  env: { ...process.env, VIKU_DATA: dataDir, VIKU_PORT: String(PORT), VIKU_QUERY: 'debug=1' },
  timeout: 60000
})
const page = await app.firstWindow()
page.on('console', (m) => {
  if (m.type() === 'error') log('console:', m.text())
})
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.unmaximize()
  w.setBounds({ x: 20, y: 20, width: 1500, height: 940 })
})
const shot = async (name) => {
  await page.screenshot({ path: join(shots, `installer-${name}.png`) })
  log('screenshot', `installer-${name}.png`)
}

let failure = null
try {
// 3. setup screen (bootstrap)
await page.waitForSelector('.first-run, .ob, .topbar', { timeout: 120000 })
if (await page.$('.first-run')) {
  await page.waitForTimeout(1500)
  await shot('01-setup-start')
  let n = 0
  let lastPct = -1
  while (await page.$('.first-run')) {
    const pct = await page.$eval('.setup-pct', (e) => e.textContent).catch(() => '')
    const msg = await page.$eval('.setup-msg', (e) => e.textContent).catch(() => '')
    if (pct !== lastPct) log('setup', pct, msg)
    lastPct = pct
    if (await page.$('.setup-bar.failed')) {
      await page.click('.setup-logtoggle')
      await shot('01x-setup-failed')
      throw new Error(`setup failed: ${msg}`)
    }
    if (n === 20) {
      await page.click('.setup-logtoggle').catch(() => undefined)
      await shot('02-setup-progress')
    }
    n++
    if (Date.now() - t0 > 15 * 60_000) throw new Error('setup took longer than 15 minutes')
    await sleep(1500)
  }
  log('setup screen gone')
} else log('no setup screen (environment already present?)')

// 4. engine + onboarding (the app starts engine-env's viku-engine.exe after the setup)
let health = null
for (let i = 0; i < 120 && !health; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) })
    if (res.ok) health = await res.json()
  } catch {
    await sleep(1500)
  }
}
if (!health) {
  const st = await page.evaluate(() => window.viku.engine.status())
  log('engine status:', st.state, st.message)
  console.log(st.log.slice(-25).join('\n'))
  await shot('03x-no-engine')
  throw new Error('the engine did not answer /health')
}
log('engine up after', ((Date.now() - t0) / 1000).toFixed(0), 's')
log('/health ok:', health.ok, 'version', health.version, 'setup_needed', health.setup_needed, 'missing', (health.setup_missing ?? []).join(','))
await page.waitForSelector('.ob', { timeout: 60000 })
await page.waitForTimeout(800)
await shot('03-onboarding')
await page.click('.ob-next')
await page.waitForTimeout(500)
await page.click('.ob-next')
await page.waitForSelector('.mdl-row', { timeout: 60000 })
await page.waitForTimeout(800)
await shot('04-models')
// install the 2 MB fonts item through the UI (real download, SHA-256 verified by the engine)
const fonts = await page.$('.mdl-row[data-model="fonts"]')
if (fonts && !(await fonts.$('.mdl-state.ok'))) {
  await fonts.$eval('button:has-text("Install")', (b) => b.click())
  await page.waitForSelector('.mdl-row[data-model="fonts"] .mdl-state.ok', { timeout: 120000 })
  log('fonts installed via the UI')
} else log('fonts already installed (engine fetches them on first start)')
const gate = await page.$('.mdl-gate')
log('HF token prompt shown:', Boolean(gate))
if (gate) await gate.scrollIntoViewIfNeeded()
await page.waitForTimeout(600)
await shot('05-models-after')
const models = await (await fetch(`http://127.0.0.1:${PORT}/models`)).json()
log('models:', models.map((m) => `${m.id}=${m.installed ? 'ok' : 'missing'}${m.needs_token ? '(token)' : ''}`).join(' '))

// About dialog in the installed app
await page.evaluate(() => window.__viku?.useApp.getState().set({ onboardingOpen: false, aboutOpen: true }))
await page.waitForSelector('.about-row', { timeout: 20000 })
await page.waitForTimeout(800)
await shot('06-about')

} catch (e) {
  failure = e
  log('FAILED:', e instanceof Error ? e.message : String(e))
  await page.screenshot({ path: join(shots, 'installer-zz-failure.png') }).catch(() => undefined)
}
// 5. quit: the app kills the engine it started
await app.close()
await sleep(2500)
let up = true
try {
  await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) })
} catch {
  up = false
}
log('engine still answering after quit:', up)
const ps = execFileSync('powershell', ['-NoProfile', '-Command', `@(Get-Process | Where-Object { $_.Path -like '${installDir}\\*' }).Count`]).toString().trim()
log('processes left under the install dir:', ps)
const envSize = execFileSync('powershell', ['-NoProfile', '-Command', `"{0:N0}" -f ((Get-ChildItem -LiteralPath '${join(installDir, 'engine-env')}' -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)`]).toString().trim()
log('engine-env size MB:', envSize)

if (keep || failure) {
  log(failure ? 'failure: leaving the install for inspection' : '--keep: leaving', installDir, dataDir)
  process.exit(failure ? 1 : 0)
}

// 6. silent uninstall (keeps user data: VIKU_DATA here is a temp dir we delete ourselves)
const uninst = join(installDir, 'Uninstall Viku.exe')
spawnSync(uninst, ['/S', '/currentuser'], { stdio: 'inherit' })
for (let i = 0; i < 120 && existsSync(exe); i++) await sleep(1000)
for (let i = 0; i < 30 && lnk.some((p) => existsSync(p)); i++) await sleep(1000)
log('after uninstall: Viku.exe exists =', existsSync(exe), '| install dir exists =', existsSync(installDir), '| shortcuts =', lnk.map((p) => existsSync(p)).join('/'))
for (const d of [installDir, dataDir]) rmSync(d, { recursive: true, force: true })
log('temp dirs removed:', !existsSync(installDir) && !existsSync(dataDir))
