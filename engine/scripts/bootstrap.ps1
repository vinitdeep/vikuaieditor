<#
.SYNOPSIS
  Viku engine bootstrap for the installer / first run: creates the engine's Python environment from uv.lock with a
  bundled uv.exe, then (optionally) starts the engine. Idempotent - safe to run on every launch.

.DESCRIPTION
  Everything lives inside -InstallDir (nothing in the user's profile except what uv itself needs):
    <InstallDir>\engine\      engine sources (copied from -EngineSrc when that is a different folder)
    <InstallDir>\engine\.venv  the environment (uv sync --frozen --no-dev --group asr)
    <InstallDir>\python\       uv-managed CPython 3.11 (UV_PYTHON_INSTALL_DIR)
    <InstallDir>\uv-cache\     uv download cache (UV_CACHE_DIR); safe to delete after setup
  Progress for the app: lines "PROGRESS <0-100> <message>" on stdout; the last line is "READY <url>" or
  "ERROR <message>" (exit code 1).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File bootstrap.ps1 -Uv "C:\Program Files\Viku\uv.exe" `
      -InstallDir "$env:LOCALAPPDATA\Viku" -Port 8765
#>
param(
  [Parameter(Mandatory = $true)][string]$Uv,
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [string]$EngineSrc = "",
  [string]$DataDir = "",
  [int]$Port = 8765,
  [switch]$NoStart,
  [switch]$CleanCache
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Say([int]$pct, [string]$msg) { Write-Output ("PROGRESS {0} {1}" -f $pct, $msg) }
function Fail([string]$msg) { Write-Output ("ERROR " + $msg); exit 1 }
# Native tools (uv, python) report progress on stderr; in Windows PowerShell 5.1 "2>&1" turns those lines into
# error records, which must not stop the script. Returns the output as strings; $LASTEXITCODE is kept.
function Native([string]$exe, [string[]]$argv) {
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { $o = & $exe @argv 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $old }
  return $o
}

try {
  if (-not $EngineSrc) { $EngineSrc = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
  if (-not (Test-Path -LiteralPath $Uv -PathType Leaf)) { Fail "uv.exe not found at $Uv" }
  $Uv = (Resolve-Path -LiteralPath $Uv).Path
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $InstallDir = (Resolve-Path -LiteralPath $InstallDir).Path
  $EngineSrc = (Resolve-Path -LiteralPath $EngineSrc).Path
  $Engine = Join-Path $InstallDir "engine"

  $env:UV_PYTHON_INSTALL_DIR = Join-Path $InstallDir "python"
  $env:UV_CACHE_DIR = Join-Path $InstallDir "uv-cache"
  $env:UV_PYTHON_PREFERENCE = "only-managed"   # never pick up a system Python
  $env:UV_NO_CONFIG = "1"                       # ignore any uv.toml in the user's profile
  $env:UV_LINK_MODE = "copy"
  Remove-Item Env:VIRTUAL_ENV -ErrorAction SilentlyContinue
  Remove-Item Env:UV_PROJECT_ENVIRONMENT -ErrorAction SilentlyContinue

  Say 2 "checking uv"
  $uvVer = Native $Uv @("--version")
  if ($LASTEXITCODE -ne 0) { Fail "uv does not run: $uvVer" }
  Say 4 "$uvVer"

  # 1. engine sources ------------------------------------------------------------------------------------------
  if ($EngineSrc -ne $Engine) {
    Say 6 "copying engine files"
    New-Item -ItemType Directory -Force -Path $Engine | Out-Null
    foreach ($f in @("pyproject.toml", "uv.lock", "README.md")) {
      Copy-Item -LiteralPath (Join-Path $EngineSrc $f) -Destination $Engine -Force
    }
    # mirror the package (robocopy exit codes < 8 are success); skip caches
    & robocopy (Join-Path $EngineSrc "viku") (Join-Path $Engine "viku") /MIR /NFL /NDL /NJH /NJS /NP /XD __pycache__ | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "copying the engine files failed (robocopy $LASTEXITCODE)" }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $Engine "uv.lock"))) { Fail "uv.lock missing in $Engine" }

  # 2. Python 3.11 (uv-managed, inside the install dir) ---------------------------------------------------------
  Say 8 "installing Python 3.11 (once)"
  $out = Native $Uv @("python", "install", "3.11")
  if ($LASTEXITCODE -ne 0) { Fail ("Python install failed: " + ($out | Select-Object -Last 3 | Out-String).Trim()) }
  Say 20 "Python 3.11 ready"

  # 3. environment from the lock file ---------------------------------------------------------------------------
  $lockHash = (Get-FileHash -LiteralPath (Join-Path $Engine "uv.lock") -Algorithm SHA256).Hash
  $stamp = Join-Path $Engine ".viku-bootstrap.json"
  $py = Join-Path $Engine ".venv\Scripts\python.exe"
  $fresh = $true
  if ((Test-Path -LiteralPath $stamp) -and (Test-Path -LiteralPath $py)) {
    try { $fresh = ((Get-Content -LiteralPath $stamp -Raw | ConvertFrom-Json).lock -ne $lockHash) } catch { $fresh = $true }
  }
  if ($fresh) {
    Say 22 "installing engine packages (first run downloads ~350 MB)"
    $pct = 22
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Uv
    $psi.Arguments = "sync --frozen --no-dev --group asr --python 3.11 --project `"$Engine`""
    $psi.UseShellExecute = $false
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardOutput = $true
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $Engine
    $proc = [System.Diagnostics.Process]::Start($psi)
    $tail = New-Object System.Collections.Generic.List[string]
    # uv reports on stderr; read it line by line and turn "Downloading/Prepared/Installed" into progress
    while (-not $proc.StandardError.EndOfStream) {
      $line = $proc.StandardError.ReadLine()
      if (-not $line) { continue }
      $tail.Add($line); if ($tail.Count -gt 12) { $tail.RemoveAt(0) }
      if ($line -match "^\s*Downloading\s+(\S+)") { $pct = [Math]::Min($pct + 3, 80); Say $pct ("downloading " + $Matches[1]) }
      elseif ($line -match "^\s*(Prepared|Installed|Resolved|Audited|Uninstalled)\b") { $pct = [Math]::Min($pct + 4, 88); Say $pct $line.Trim() }
    }
    $null = $proc.StandardOutput.ReadToEnd()
    $proc.WaitForExit()
    if ($proc.ExitCode -ne 0) { Fail ("package install failed: " + (($tail | Select-Object -Last 4) -join " | ")) }
    @{ lock = $lockHash; uv = "$uvVer"; t = (Get-Date).ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $stamp -Encoding UTF8
  } else {
    Say 88 "engine packages already installed"
  }

  # 4. smoke test ------------------------------------------------------------------------------------------------
  Say 90 "checking the engine environment"
  $check = Native $py @("-X", "utf8", "-c", "import viku.server, torch, onnxruntime, faster_whisper, cv2; print('ok', torch.__version__)")
  if ($LASTEXITCODE -ne 0) { Fail ("engine environment is broken: " + ($check | Select-Object -Last 2 | Out-String).Trim()) }
  Say 92 ("environment ok (" + ($check | Select-Object -Last 1) + ")")
  if ($CleanCache) { Remove-Item -LiteralPath $env:UV_CACHE_DIR -Recurse -Force -ErrorAction SilentlyContinue }

  # 5. start the engine --------------------------------------------------------------------------------------------
  $url = "http://127.0.0.1:$Port"
  if ($NoStart) { Say 100 "ready (not started)"; Write-Output "READY $url"; exit 0 }
  try { $h = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 2; if ($h.ok) { Say 100 "engine already running"; Write-Output "READY $url"; exit 0 } } catch { }
  Say 94 "starting the engine"
  $env:VIKU_PORT = "$Port"
  if ($DataDir) { $env:VIKU_DATA = $DataDir }
  $exe = Join-Path $Engine ".venv\Scripts\viku-engine.exe"
  $log = Join-Path $InstallDir "engine.log"
  Start-Process -FilePath $exe -WorkingDirectory $Engine -WindowStyle Hidden -RedirectStandardOutput $log `
      -RedirectStandardError (Join-Path $InstallDir "engine.err.log") | Out-Null
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Milliseconds 700
    try { $h = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 3; if ($h.ok) { break } } catch { }
  }
  if (-not $h -or -not $h.ok) { Fail "the engine did not answer on $url (see $log)" }
  if ($h.setup_needed) { Say 100 ("engine running; first-run setup needed: " + ($h.setup_missing -join ", ")) }
  else { Say 100 "engine running" }
  Write-Output "READY $url"
  exit 0
} catch {
  Fail ($_.Exception.Message)
}
