import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react'
import type { EngineStatus } from '@shared/ipc'
import { Logo } from '../Logo'
import { Button } from '../ui'

const STAGES: [number, string][] = [
  [0, 'Checking the bundled tools'],
  [8, 'Installing Python 3.11'],
  [22, 'Downloading the engine packages'],
  [90, 'Checking the environment'],
  [100, 'Starting the engine']
]

/**
 * Full-window "Setting up Viku" screen shown on the installed app's first launch while bootstrap.ps1 creates the
 * engine environment (Python 3.11 + packages from uv.lock, ~350 MB download). Fed by the PROGRESS lines.
 */
export function SetupScreen({ status }: { status: EngineStatus }) {
  const s = status.setup
  const failed = status.state === 'error' && Boolean(s?.error)
  const pct = Math.max(0, Math.min(100, s?.pct ?? 0))
  const [showLog, setShowLog] = useState(false)
  const [busy, setBusy] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)
  const started = useRef(Date.now())
  const [, tick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [s?.log.length, showLog])

  const retry = async (): Promise<void> => {
    setBusy(true)
    try {
      const st = await window.viku?.engine.setupRetry()
      if (st?.state === 'running') location.reload()
    } finally {
      setBusy(false)
    }
  }
  const secs = Math.round((Date.now() - started.current) / 1000)
  const stage = STAGES.filter(([p]) => pct >= p).length - 1

  return (
    <div className="first-run" role="main" aria-label="Setting up Viku">
      <div className="setup-card">
        <Logo size={56} />
        <h1>{failed ? 'Viku could not finish setting up' : 'Setting up Viku'}</h1>
        <p className="setup-sub">
          {failed
            ? 'The engine environment could not be created. Check the internet connection and try again — everything already downloaded is kept.'
            : 'First start only: Viku is preparing its offline engine on this PC. This downloads about 350 MB and takes a few minutes. Please keep the window open.'}
        </p>

        <div className={`setup-bar${failed ? ' failed' : ''}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${failed ? 100 : Math.max(pct, 3)}%` }} />
        </div>
        <div className="setup-line">
          {failed ? <AlertTriangle size={14} aria-hidden /> : <Loader2 size={14} className="spin" aria-hidden />}
          <span className="grow setup-msg">{failed ? s?.error : s?.message || 'Preparing…'}</span>
          <span className="setup-pct">{failed ? '' : `${pct}%`}</span>
        </div>

        <ol className="setup-stages">
          {STAGES.map(([p, label], i) => (
            <li key={p} className={failed && i === stage ? 'fail' : i < stage || (pct >= 100 && i === stage) ? 'done' : i === stage ? 'on' : ''}>
              <span className="setup-dot" />
              {label}
            </li>
          ))}
        </ol>

        {failed && (
          <div className="setup-actions">
            <Button variant="primary" icon={RefreshCw} onClick={() => void retry()} disabled={busy}>
              {busy ? 'Trying again…' : 'Try again'}
            </Button>
          </div>
        )}

        <button type="button" className="setup-logtoggle" onClick={() => setShowLog(!showLog)} aria-expanded={showLog}>
          {showLog ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
          Details {!failed && `· ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`}
        </button>
        {showLog && (
          <pre className="setup-log" ref={logRef}>
            {(s?.log ?? []).join('\n') || 'waiting for the first progress line…'}
          </pre>
        )}
      </div>
    </div>
  )
}
