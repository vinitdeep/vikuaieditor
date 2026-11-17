import { useState } from 'react'
import { CircleAlert, Loader2, Play, RefreshCw, Settings2, X } from 'lucide-react'
import { useApp } from '@/state/app'
import { Button, IconButton } from '../ui'

/**
 * Shown when the engine is not answering: live data cannot load or save, or the app fell back to sample data.
 * Hidden when the user chose "Mock data" on purpose.
 */
export function EngineBanner() {
  const engine = useApp((s) => s.engine)
  const apiKind = useApp((s) => s.apiKind)
  const adapterPref = useApp((s) => s.adapterPref)
  const set = useApp((s) => s.set)
  const [hidden, setHidden] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!window.viku || !engine || adapterPref === 'mock') return null
  const state = engine.state
  const up = state === 'running'
  const starting = state === 'starting' || busy

  let kind: 'down' | 'fallback' | 'up-on-mock' | null = null
  if (apiKind === 'live' && !up) kind = 'down'
  else if (apiKind === 'mock' && !up) kind = 'fallback'
  else if (apiKind === 'mock' && up) kind = 'up-on-mock'
  if (!kind) return null
  const key = `${kind}:${state}`
  if (hidden === key) return null

  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      const s = await window.viku?.engine.start()
      if (s) set({ engine: s })
      if (s?.state === 'running' && apiKind === 'mock') location.reload()
    } finally {
      setBusy(false)
    }
  }

  const title =
    kind === 'up-on-mock'
      ? 'The engine is running.'
      : starting
        ? 'Starting the engine…'
        : kind === 'down'
          ? 'The engine is not running — changes can’t be saved and jobs won’t start.'
          : 'The engine is not running — you are looking at sample data.'
  const detail = kind !== 'up-on-mock' && !starting ? (engine.message && !/not running/i.test(engine.message) ? engine.message : '') : ''

  return (
    <div className={`engine-banner eb-${kind}${starting ? ' starting' : ''}`} role="alert">
      {starting ? <Loader2 size={15} className="spin" aria-hidden /> : <CircleAlert size={15} aria-hidden />}
      <span className="eb-text">
        <b>{title}</b>
        {detail && <span className="eb-detail">{detail}</span>}
      </span>
      {kind === 'up-on-mock' ? (
        <Button size="sm" variant="primary" icon={RefreshCw} onClick={() => location.reload()}>
          Switch to live data
        </Button>
      ) : (
        <>
          <Button size="sm" variant="ghost" icon={Settings2} onClick={() => set({ settingsOpen: true })}>
            Engine settings
          </Button>
          <Button size="sm" variant="primary" icon={Play} onClick={() => void start()} disabled={starting}>
            Start engine
          </Button>
        </>
      )}
      <IconButton icon={X} label="Hide" onClick={() => setHidden(key)} />
    </div>
  )
}
