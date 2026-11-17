import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { AlertTriangle, Check, Download, ExternalLink, FolderOpen, KeyRound, Loader2, Pause, Play, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '@/api'
import type { JobEvent, ModelInstallRequest, ModelItem } from '@/api/types'
import { toast, useApp } from '@/state/app'
import { useJobs } from '@/state/jobs'
import { Button, IconButton } from '../ui'

// ---------------------------------------------------------------- store ----

interface ActiveJob {
  id: string
  ids: string[]
  progress: number
  message: string
  bytesDone?: number
  bytesTotal?: number
  fromFolder: boolean
}

interface InstallError {
  code: string
  message: string
  ids: string[]
}

interface ModelsState {
  items: ModelItem[]
  loaded: boolean
  loading: boolean
  loadError: string | null
  job: ActiveJob | null
  error: InstallError | null
  load: () => Promise<void>
  install: (body: ModelInstallRequest, ids: string[]) => Promise<void>
  cancel: () => Promise<void>
  remove: (ids: string[]) => Promise<void>
}

async function refreshHealth(): Promise<void> {
  try {
    useApp.getState().set({ health: await api().health() })
  } catch {
    /* engine down */
  }
}

function bytesOf(ev: JobEvent): { bytesDone?: number; bytesTotal?: number } {
  const r = ev.result as { bytes_done?: unknown; bytes_total?: unknown } | undefined
  if (r && typeof r.bytes_done === 'number' && typeof r.bytes_total === 'number') return { bytesDone: r.bytes_done, bytesTotal: r.bytes_total }
  return {}
}

export const useModels = create<ModelsState>((set, get) => ({
  items: [],
  loaded: false,
  loading: false,
  loadError: null,
  job: null,
  error: null,
  load: async () => {
    set({ loading: true })
    try {
      set({ items: await api().listModels(), loaded: true, loadError: null })
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) })
    } finally {
      set({ loading: false })
    }
  },
  install: async (body, ids) => {
    if (get().job) {
      toast('info', 'A download is already running — wait for it or cancel it first.')
      return
    }
    const prefs = window.viku ? await window.viku.prefs.get() : null
    const req: ModelInstallRequest = { ...body }
    if (prefs?.modelsMirror && !req.mirror_url) req.mirror_url = prefs.modelsMirror
    set({ error: null })
    try {
      const ref = await api().installModels(req)
      set({ job: { id: ref.job, ids, progress: 0, message: body.source_dir ? 'Copying from the folder…' : 'Starting the download…', fromFolder: Boolean(body.source_dir) } })
      const label = ids.length === 1 ? `Install ${get().items.find((m) => m.id === ids[0])?.name ?? ids[0]}` : 'Install models'
      const finish = (): void => {
        set({ job: null })
        void get().load()
        void refreshHealth()
      }
      useJobs.getState().track(ref, label, {
        onEvent: (ev) => {
          const j = get().job
          if (j && j.id === ev.job && ev.state === 'running') set({ job: { ...j, progress: ev.progress, message: ev.message, ...bytesOf(ev) } })
        },
        onDone: () => {
          finish()
          toast('success', ids.length === 1 ? 'Installed — ready to use offline.' : 'Models installed — ready to use offline.')
        },
        onCancel: () => {
          finish()
          toast('info', 'Download paused — press Resume to continue where it stopped.')
        },
        onError: (ev) => {
          finish()
          if (/^cancel/i.test(ev.message)) {
            toast('info', 'Download paused — press Resume to continue where it stopped.')
            return
          }
          set({ error: { code: ev.code ?? 'error', message: ev.error ?? ev.message, ids } })
        }
      })
    } catch (e) {
      set({ error: { code: 'request', message: e instanceof Error ? e.message : String(e), ids } })
    }
  },
  cancel: async () => {
    const j = get().job
    if (!j) return
    const ok = await api().cancelJob(j.id)
    if (!ok) toast('warn', 'This download cannot be cancelled')
  },
  remove: async (ids) => {
    try {
      await api().removeModels(ids)
      toast('success', 'Removed — download it again any time.')
    } catch (e) {
      toast('error', `Could not remove: ${e instanceof Error ? e.message : String(e)}`)
    }
    await get().load()
    void refreshHealth()
  }
}))

// ------------------------------------------------------------- messages ----

export function errorText(code: string, raw: string, item?: ModelItem, short?: boolean): { title: string; body: string } {
  switch (code) {
    case 'hf_auth_required':
      if (short)
        return {
          title: 'Hugging Face did not allow the download',
          body: 'Check that you pressed “Agree and access repository” on the model page with the same account, and that you pasted a Read token. Then try again.'
        }
      return {
        title: 'Hugging Face needs your free account for this model',
        body: `${item?.name ?? 'This model'} is shared on Hugging Face only with people who accept its terms. Open the model page, sign in (or create a free account), press “Agree and access”, then make a Read token under Settings → Access Tokens and paste it below. Or install it from a folder someone copied for you.`
      }
    case 'network':
      return {
        title: 'The download could not reach the internet',
        body: 'Check the Wi-Fi or mobile data, then press Resume. Everything already downloaded is kept, so it continues where it stopped.'
      }
    case 'checksum':
      return {
        title: 'The downloaded file was damaged',
        body: 'Its fingerprint (SHA-256) did not match, so Viku threw it away to keep your install safe. Press Install to download it again. If it keeps failing, use a mirror or install from a folder.'
      }
    case 'bad_request':
      return { title: 'Check the mirror address or folder', body: `${raw}. Fix it in Settings → Models (mirror) or pick the folder again.` }
    case 'request':
      return { title: 'The engine did not accept the request', body: raw }
    default:
      return { title: 'Install failed', body: raw }
  }
}

const fmtMb = (mb: number): string => (mb >= 1000 ? `${(mb / 1000).toFixed(mb >= 10000 ? 0 : 1)} GB` : `${Math.max(1, Math.round(mb))} MB`)
const fmtBytes = (b: number): string => fmtMb(b / 1e6)

// ------------------------------------------------------------- component ----

/** The models & tools list: GET /models driven, used by onboarding ("Engine & models") and Settings → Models. */
export function ModelsPanel({ compact }: { compact?: boolean }) {
  const { items, loaded, loading, loadError, job, error, load, install, cancel, remove } = useModels()
  const apiKind = useApp((s) => s.apiKind)
  const engine = useApp((s) => s.engine)

  useEffect(() => {
    void load()
  }, [load, apiKind, engine?.state])

  const required = items.filter((m) => m.required)
  const optional = items.filter((m) => !m.required)
  const missingRequired = required.filter((m) => !m.installed)
  const missingMb = missingRequired.reduce((a, m) => a + Math.max(0, m.size_mb - m.partial_mb), 0)
  // items that need a Hugging Face token are installed from their own row (token / folder); the rest go in one job
  const direct = missingRequired.filter((m) => !m.needs_token)
  const gated = missingRequired.filter((m) => m.needs_token)
  const installAll = (): void => void install({ ids: direct.map((m) => m.id) }, direct.map((m) => m.id))

  if (!loaded) {
    return (
      <div className="mdl-empty">
        {loading ? <Loader2 size={16} className="spin" aria-hidden /> : <AlertTriangle size={16} aria-hidden />}
        <span>{loading ? 'Asking the engine what is installed…' : loadError ? `The engine did not answer (${loadError}). Start it, then re-check.` : 'Start the engine to see the models.'}</span>
        {!loading && (
          <Button size="sm" icon={RefreshCw} onClick={() => void load()}>
            Re-check
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className={`mdl${compact ? ' compact' : ''}`}>
      <div className={`mdl-summary ${missingRequired.length ? 'todo' : 'ok'}`}>
        <span className="mdl-summary-icon">{missingRequired.length ? <Download size={16} aria-hidden /> : <Check size={16} aria-hidden />}</span>
        <div className="grow">
          <b>{missingRequired.length ? `${missingRequired.length} required item${missingRequired.length === 1 ? '' : 's'} to download` : 'Everything required is installed'}</b>
          <span className="small muted">
            {missingRequired.length ? `About ${fmtMb(missingMb)} — one time, then Viku works offline.` : 'Viku works offline. Optional extras are below.'}
            {gated.length > 0 && ` ${gated.map((m) => m.name.split(' (')[0]).join(', ')} needs your free Hugging Face token (below).`}
          </span>
        </div>
        {direct.length > 0 && (
          <Button variant="primary" icon={Download} onClick={installAll} disabled={Boolean(job)}>
            Install all required
          </Button>
        )}
        <IconButton icon={RefreshCw} label="Re-check" onClick={() => void load()} disabled={loading} />
      </div>

      {job && <JobBar job={job} onCancel={() => void cancel()} />}

      <h3 className="mdl-group">Required</h3>
      {required.map((m) => (
        <ModelRow key={m.id} m={m} job={job} error={error && error.ids.includes(m.id) ? error : null} onInstall={install} onRemove={remove} />
      ))}
      {optional.length > 0 && (
        <>
          <h3 className="mdl-group">Optional</h3>
          {optional.map((m) => (
            <ModelRow key={m.id} m={m} job={job} error={error && error.ids.includes(m.id) ? error : null} onInstall={install} onRemove={remove} />
          ))}
        </>
      )}
      {error && !items.some((m) => error.ids.includes(m.id)) && <ErrorBox code={error.code} raw={error.message} />}
    </div>
  )
}

function JobBar({ job, onCancel }: { job: ActiveJob; onCancel: () => void }) {
  const pct = Math.round(job.progress * 100)
  return (
    <div className="mdl-job" aria-live="polite">
      <div className="mdl-job-top">
        <Loader2 size={14} className="spin" aria-hidden />
        <span className="grow mdl-job-msg">{job.message || 'Working…'}</span>
        <span className="mdl-job-num">
          {job.bytesDone !== undefined && job.bytesTotal ? `${fmtBytes(job.bytesDone)} of ${fmtBytes(job.bytesTotal)} · ` : ''}
          {pct}%
        </span>
        <Button size="sm" variant="ghost" icon={Pause} onClick={onCancel}>
          {job.fromFolder ? 'Cancel' : 'Pause'}
        </Button>
      </div>
      <div className="mdl-bar">
        <span style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
    </div>
  )
}

function ErrorBox({ code, raw, item, short }: { code: string; raw: string; item?: ModelItem; short?: boolean }) {
  const t = errorText(code, raw, item, short)
  return (
    <div className={`mdl-err code-${code}`} role="alert">
      <AlertTriangle size={14} aria-hidden />
      <div>
        <b>{t.title}</b>
        <span>{t.body}</span>
        {code !== 'request' && raw && t.body !== raw && <code className="mdl-raw">{raw}</code>}
      </div>
    </div>
  )
}

function ModelRow({
  m,
  job,
  error,
  onInstall,
  onRemove
}: {
  m: ModelItem
  job: ActiveJob | null
  error: InstallError | null
  onInstall: (body: ModelInstallRequest, ids: string[]) => Promise<void>
  onRemove: (ids: string[]) => Promise<void>
}) {
  const [token, setToken] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (error) rowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [error])
  const busy = Boolean(job)
  const mine = job?.ids.includes(m.id) && !m.installed
  const partial = !m.installed && m.partial_mb > 0
  const tokenNeeded = !m.installed && (m.needs_token || error?.code === 'hf_auth_required')
  const removable = m.installed && (m.source === 'managed' || m.source === null)

  const fromFolder = async (): Promise<void> => {
    const dir = await window.viku?.dialog.openFolder(`Folder that contains ${m.name}`)
    if (dir) await onInstall({ ids: [m.id], source_dir: dir }, [m.id])
  }
  const withToken = async (): Promise<void> => {
    const t = token.trim()
    if (!t) return
    setToken('') // sent once to the engine, never kept by the app
    await onInstall({ ids: [m.id], hf_token: t }, [m.id])
  }
  const openPage = (): void => {
    const url = m.accept_url || m.licence_url
    if (url) void window.viku?.shell.openExternal(url)
  }

  let state: { cls: string; label: string }
  if (m.installed) state = { cls: 'ok', label: m.source === 'bundled' ? 'Built in' : m.source === 'system' ? 'Found on PC' : 'Installed' }
  else if (mine) state = { cls: 'run', label: job?.fromFolder ? 'Copying…' : 'Downloading…' }
  else if (partial) state = { cls: 'part', label: `Paused · ${fmtMb(m.partial_mb)} of ${fmtMb(m.size_mb)}` }
  else state = { cls: 'no', label: 'Not installed' }

  return (
    <div ref={rowRef} className={`mdl-row ${state.cls}${tokenNeeded ? ' gated' : ''}`} data-model={m.id}>
      <div className="mdl-main">
        <span className={`mdl-dot ${state.cls}`}>{m.installed ? <Check size={11} aria-hidden /> : mine ? <Loader2 size={11} className="spin" aria-hidden /> : null}</span>
        <div className="mdl-text">
          <b>{m.name}</b>
          <span className="mdl-purpose">{m.purpose}</span>
          <span className="mdl-meta">
            {m.size_mb > 0 ? fmtMb(m.size_mb) : 'bundled'}
            {' · '}
            {m.licence_url ? (
              <a
                href={m.licence_url}
                onClick={(e) => {
                  e.preventDefault()
                  void window.viku?.shell.openExternal(m.licence_url)
                }}
              >
                {m.licence || 'licence'}
              </a>
            ) : (
              m.licence || 'licence'
            )}
            {m.installed && m.source && m.source !== 'managed' ? ` · ${m.source}` : ''}
          </span>
        </div>
        <span className={`mdl-state ${state.cls}`}>{state.label}</span>
        <div className="mdl-acts">
          {!m.installed && !mine && !tokenNeeded && (
            <Button size="sm" variant={m.required ? 'default' : 'ghost'} icon={partial ? Play : Download} onClick={() => void onInstall({ ids: [m.id] }, [m.id])} disabled={busy}>
              {partial ? 'Resume' : 'Install'}
            </Button>
          )}
          {removable &&
            (confirmRemove ? (
              <>
                <Button size="sm" variant="danger" onClick={() => void onRemove([m.id]).then(() => setConfirmRemove(false))}>
                  Remove {fmtMb(m.size_mb)}?
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <IconButton icon={Trash2} label={`Remove ${m.name}`} onClick={() => setConfirmRemove(true)} disabled={busy} />
            ))}
        </div>
      </div>

      {tokenNeeded && !mine && (
        <div className="mdl-gate">
          <div className="mdl-gate-head">
            <KeyRound size={14} aria-hidden />
            <b>This model needs a free Hugging Face account</b>
          </div>
          <ol className="mdl-steps">
            <li>Open the model page, sign in (or sign up — it is free) and press “Agree and access repository”.</li>
            <li>
              On Hugging Face go to Settings → Access Tokens, create a <b>Read</b> token and paste it here. It goes straight to the Viku engine on this PC
              (kept encrypted for later downloads) — the app window does not store it.
            </li>
          </ol>
          <div className="mdl-gate-row">
            <Button size="sm" icon={ExternalLink} onClick={openPage} disabled={!m.accept_url && !m.licence_url}>
              Open model page
            </Button>
            <input
              className="input mdl-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="hf_… read token"
              aria-label={`Hugging Face token for ${m.name}`}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') void withToken()
              }}
            />
            <Button size="sm" variant="primary" icon={Download} onClick={() => void withToken()} disabled={busy || !token.trim()}>
              {partial ? 'Resume' : 'Install'}
            </Button>
          </div>
          <div className="mdl-gate-alt small muted">
            Got the model on a USB stick or from another PC?
            <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => void fromFolder()} disabled={busy}>
              Install from folder…
            </Button>
          </div>
        </div>
      )}
      {!m.installed && !tokenNeeded && !mine && error === null && m.gated && (
        <div className="mdl-gate-alt small muted">
          <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => void fromFolder()} disabled={busy}>
            Install from folder…
          </Button>
        </div>
      )}
      {error && <ErrorBox code={error.code} raw={error.message} item={m} short={tokenNeeded} />}
    </div>
  )
}
