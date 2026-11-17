import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Search } from 'lucide-react'
import type { AppInfo } from '@shared/ipc'
import { api } from '@/api'
import type { LicenceItem } from '@/api/types'
import { useApp } from '@/state/app'
import { Logo } from '../Logo'
import { Modal } from './Shell'

interface Row extends LicenceItem {
  group: string
}

const GROUP_LABEL: Record<string, string> = {
  app: 'Viku app',
  python: 'Python packages',
  package: 'Python packages',
  model: 'Models',
  models: 'Models',
  tool: 'Tools',
  tools: 'Tools',
  font: 'Fonts',
  fonts: 'Fonts',
  data: 'Data',
  bible: 'Bibles',
  runtime: 'Engine runtime',
  library: 'Libraries'
}

/** About Viku: version + every third-party licence (GET /licences for the engine, the app shell's own list). */
export function AboutDialog() {
  const open = useApp((s) => s.aboutOpen)
  const set = useApp((s) => s.set)
  const health = useApp((s) => s.health)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [engineLic, setEngineLic] = useState<LicenceItem[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setQ('')
    void window.viku?.app.info().then(setInfo)
    api()
      .licences()
      .then((l) => {
        setEngineLic(l)
        setErr(null)
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
  }, [open])

  const rows = useMemo<Row[]>(() => {
    const shell: Row[] = (info?.shellLicences ?? []).map((l) => ({ ...l, group: 'Viku app' }))
    const eng: Row[] = (engineLic ?? []).map((l) => ({ ...l, group: GROUP_LABEL[(l.kind ?? '').toLowerCase()] ?? (l.kind ? l.kind[0].toUpperCase() + l.kind.slice(1) : 'Engine') }))
    return [...shell, ...eng]
  }, [info, engineLic])

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    return t ? rows.filter((r) => `${r.name} ${r.licence} ${r.group} ${r.version ?? ''}`.toLowerCase().includes(t)) : rows
  }, [rows, q])

  if (!open) return null
  const close = (): void => set({ aboutOpen: false })
  const groups = [...new Set(shown.map((r) => r.group))]

  return (
    <Modal title="About Viku" onClose={close} width={680}>
      <div className="about">
        <div className="about-head">
          <Logo size={52} />
          <div className="grow">
            <div className="about-name">Viku — Sermon Reel Studio</div>
            <div className="small muted">
              Version {info?.version ?? window.viku?.versions.app ?? '—'}
              {health ? ` · engine ${health.version}` : ''}
              {info ? ` · Electron ${info.electron} · Chromium ${info.chrome.split('.')[0]}` : ''}
              {info?.uv ? ` · ${info.uv.split(' ').slice(0, 2).join(' ')}` : ''}
            </div>
            {info && <div className="small muted about-path">Data: {info.userData}</div>}
          </div>
        </div>
        <p className="small muted about-note">
          Viku is built on free and open-source software. Each component below keeps its own licence; models and tools downloaded during setup carry
          theirs into the data folder.
        </p>
        <label className="about-search">
          <Search size={14} aria-hidden />
          <input
            className="input"
            placeholder={`Search ${rows.length} components and licences…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            aria-label="Search licences"
            autoFocus
          />
        </label>
        {err && <div className="about-warn small">The engine's licence list is unavailable ({err}). The app's own components are listed.</div>}
        <div className="about-list" role="list">
          {groups.map((g) => (
            <section key={g}>
              <h4>{g}</h4>
              {shown
                .filter((r) => r.group === g)
                .map((r, i) => {
                  const key = `${g}:${r.name}:${i}`
                  return (
                    <div key={key} className="about-row" role="listitem">
                      <button type="button" className="about-main" onClick={() => setExpanded(expanded === key ? null : key)} disabled={!r.text} aria-expanded={r.text ? expanded === key : undefined}>
                        <span className="grow about-pkg">
                          {r.name}
                          {r.version && <span className="muted"> {r.version}</span>}
                        </span>
                        <span className="about-lic">{r.licence}</span>
                      </button>
                      {r.url && (
                        <a
                          className="about-link"
                          href={r.url}
                          title={r.url}
                          aria-label={`Open the ${r.name} licence`}
                          onClick={(e) => {
                            e.preventDefault()
                            void window.viku?.shell.openExternal(r.url as string)
                          }}
                        >
                          <ExternalLink size={13} aria-hidden />
                        </a>
                      )}
                      {expanded === key && r.text && <pre className="about-text">{r.text}</pre>}
                    </div>
                  )
                })}
            </section>
          ))}
          {!shown.length && <div className="muted small pad">Nothing matches “{q}”.</div>}
        </div>
      </div>
    </Modal>
  )
}
