import { useEffect, useMemo, useState } from 'react'
import { CircleAlert, ExternalLink, FolderOpen, ImageIcon, Loader2, PauseCircle, Play, RotateCw, Sparkles, Trash2, X } from 'lucide-react'
import type { PromptItem } from '@shared/ipc'
import { api } from '@/api'
import { useApp } from '@/state/app'
import { readableName } from '@/lib/cutaways'
import { ExtensionSetup } from '../ExtensionSetup'
import { FacePicker } from '../FacePicker'
import { faceThumb, useFaces } from '@/lib/faces'
import { Button, IconButton, Progress, Thumb } from '../ui'

/** "reel3-04-carried-home" → "carried home" (falls back to the whole name) */
function pictureTitle(name: string): string {
  const m = name.match(/^reel[^-]*-(.+)$/)
  return readableName(m ? m[1] : name) || name
}

function reelLabel(i: PromptItem): string {
  const id = i.meta?.reelId
  if (!id) return 'Added by hand'
  return `Reel ${id.split('~').pop() ?? id} · cutaway ${(i.meta?.index ?? 0) + 1}`
}

const ORDER: Record<string, number> = { sent: 0, queued: 1, failed: 2, captured: 3 }

/**
 * AI pictures, inside the main window: the Viku browser extension makes each queued prompt in the user's own
 * AI Studio and the picture lands on its cutaway. Status, progress and the queue live here, so generating never
 * opens another window. (The Sign-in window stays for HeyGen, eBible and the advanced "Inside Viku" mode.)
 */
export function AiPicturesDrawer() {
  const open = useApp((s) => s.aiOpen)
  const set = useApp((s) => s.set)
  const gem = useApp((s) => s.gemini)
  const [items, setItems] = useState<PromptItem[]>([])
  const [, setNow] = useState(0)

  useEffect(() => {
    const b = window.viku
    if (!b) return
    void b.signin.list().then((q) => setItems([...q]))
    return b.signin.onQueue((q) => setItems([...q]))
  }, [])

  // pause countdown + Escape to close, only while open
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => setNow(Date.now()), 15000)
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') set({ aiOpen: false })
    }
    window.addEventListener('keydown', k)
    return () => {
      clearInterval(t)
      window.removeEventListener('keydown', k)
    }
  }, [open, set])

  const faces = useFaces((s) => s.faces)
  const faceFile = (id: string): string | undefined => faces.find((f) => f.id === id)?.file
  const ext = gem?.extension
  const connected = Boolean(ext?.connected)
  const embedded = gem?.mode === 'embedded'
  const sorted = useMemo(
    () => [...items].sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.status === 'captured' ? (b.sentAt ?? 0) - (a.sentAt ?? 0) : (a.queuedAt ?? 0) - (b.queuedAt ?? 0))),
    [items]
  )
  const n = {
    waiting: items.filter((i) => i.status === 'queued').length,
    making: items.filter((i) => i.status === 'sent').length,
    done: items.filter((i) => i.status === 'captured').length,
    failed: items.filter((i) => i.status === 'failed').length
  }
  const total = n.waiting + n.making + n.done
  const busy = n.waiting + n.making > 0
  const pausedMin = ext?.pausedUntil ? Math.max(1, Math.ceil((ext.pausedUntil - Date.now()) / 60000)) : 0

  let tone: 'ok' | 'work' | 'warn' | 'off' = 'ok'
  let headline: string
  let sub: string
  if (embedded) {
    tone = 'warn'
    headline = 'AI Studio runs inside Viku (advanced mode)'
    sub = 'Prompts are sent from the Sign-in window. Switch back to “Your browser” there to make them automatically.'
  } else if (!connected) {
    tone = 'off'
    headline = busy ? `${n.waiting + n.making} picture${n.waiting + n.making === 1 ? '' : 's'} waiting — add the Viku extension` : 'Make pictures with your own AI Studio'
    sub = 'Set up once: the Viku extension makes each picture in your Chrome or Edge, with your own Google account, for free.'
  } else if (pausedMin) {
    tone = 'warn'
    headline = `Paused — AI Studio limit reached`
    sub = `Carries on by itself in about ${pausedMin} min.`
  } else if (busy) {
    tone = 'work'
    headline = `Making picture ${Math.min(total, n.done + 1)} of ${total}`
    sub = 'In an AI Studio tab of your browser, one at a time. Each picture lands on its cutaway by itself.'
  } else if (n.done) {
    headline = `${n.done} picture${n.done === 1 ? '' : 's'} made`
    sub = 'Reels that were already rendered are re-rendered with their new pictures.'
  } else {
    headline = 'Ready'
    sub = 'Pictures are made as soon as a reel needs them — in your browser, with your own Google account.'
  }

  const retry = async (i: PromptItem): Promise<void> => {
    const b = window.viku
    if (!b) return
    await b.signin.remove(i.id)
    await b.signin.queue([{ prompt: i.prompt, name: i.name, folder: i.folder, meta: i.meta, faceId: i.faceId }])
  }
  const retryAll = async (): Promise<void> => {
    for (const i of items.filter((x) => x.status === 'failed')) await retry(i)
  }

  return (
    <aside className={`drawer aip${open ? ' open' : ''}`} aria-hidden={!open} aria-label="AI pictures">
      <header>
        <Sparkles size={14} aria-hidden />
        <span className="grow">AI pictures</span>
        <span className={`aip-pill p-${connected ? 'on' : embedded ? 'warn' : 'off'}`}>
          <span className="dot" aria-hidden />
          {connected ? 'AI Studio connected' : embedded ? 'Inside Viku' : 'Not set up'}
        </span>
        <IconButton icon={X} label="Close AI pictures" onClick={() => set({ aiOpen: false })} />
      </header>
      <div className="drawer-body aip-body">
        <section className={`aip-status t-${tone}`}>
          <span className="aip-status-icon" aria-hidden>
            {tone === 'work' ? <Loader2 size={16} className="spin" /> : tone === 'warn' ? <PauseCircle size={16} /> : <Sparkles size={16} />}
          </span>
          <div className="aip-status-text">
            <div className="aip-headline" role="status" aria-atomic="true">
              {headline}
            </div>
            <div className="small muted">{sub}</div>
          </div>
          {connected && total > 0 && busy && (
            <div className="aip-progress">
              <Progress value={n.done / total} tone={tone === 'warn' ? 'gold' : 'green'} />
              <span className="num small muted">
                {n.done}/{total}
              </span>
            </div>
          )}
          {pausedMin > 0 && (
            <Button size="sm" icon={Play} onClick={() => void window.viku?.signin.sendNext()}>
              Try now
            </Button>
          )}
        </section>

        {!connected && !embedded && <ExtensionSetup port={ext?.port} />}

        <FacePicker compact />

        {sorted.length > 0 && (
          <section className="aip-list" aria-label="Pictures">
            <div className="aip-list-head small">
              <span className="grow">Pictures</span>
              <span className="muted num">
                {n.waiting} waiting · {n.done} done{n.failed ? ` · ${n.failed} failed` : ''}
              </span>
            </div>
            <ul>
              {sorted.map((i) => (
                <li key={i.id} className={`aip-item s-${i.status}`}>
                  {i.status === 'captured' && i.file ? (
                    <button type="button" className="aip-thumb" title="Show the picture in Explorer" onClick={() => void window.viku?.shell.reveal(i.file as string)}>
                      <Thumb src={api().thumbUrl(i.file, 120)} alt={pictureTitle(i.name)} />
                    </button>
                  ) : (
                    <span className="aip-thumb ph" aria-hidden>
                      {i.status === 'sent' ? <Loader2 size={14} className="spin" /> : i.status === 'failed' ? <CircleAlert size={14} /> : <ImageIcon size={14} />}
                    </span>
                  )}
                  <span className="aip-item-text">
                    <span className="aip-item-title ellipsis" title={i.prompt}>
                      {pictureTitle(i.name)}
                    </span>
                    <span className="aip-item-sub small muted">
                      {i.faceId && (
                        <span className="aip-face" title={`Same face: ${i.faceName ?? ''}`}>
                          {faceFile(i.faceId) ? <Thumb src={faceThumb(faceFile(i.faceId) as string, 48)} alt={i.faceName ?? 'Face'} /> : null}
                        </span>
                      )}
                      <span className="ellipsis">{reelLabel(i)}</span>
                    </span>
                    {i.status === 'failed' && i.error && <span className="small aip-err">{i.error}</span>}
                  </span>
                  <span className={`aip-chip c-${i.status}`}>{i.status === 'sent' ? 'Making…' : i.status === 'queued' ? 'Waiting' : i.status === 'captured' ? 'Done' : 'Failed'}</span>
                  {i.status === 'failed' && <IconButton icon={RotateCw} label={`Try ${pictureTitle(i.name)} again`} onClick={() => void retry(i)} />}
                  {i.status !== 'sent' && <IconButton icon={X} label={`Remove ${pictureTitle(i.name)}`} onClick={() => void window.viku?.signin.remove(i.id)} />}
                </li>
              ))}
            </ul>
          </section>
        )}
        {!sorted.length && connected && <div className="muted small pad">Nothing queued. Empty cutaways get a new picture when you make reels with “New AI”, or with ✦ Generate on a cutaway.</div>}
      </div>
      <footer className="aip-foot">
        {n.failed > 0 && (
          <Button size="sm" variant="ghost" icon={RotateCw} onClick={() => void retryAll()}>
            Retry failed
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={Trash2} disabled={!n.done} onClick={() => void window.viku?.signin.clearDone()}>
          Clear done
        </Button>
        <span className="grow" />
        <Button size="sm" variant="ghost" icon={FolderOpen} onClick={async () => void window.viku?.shell.reveal((await window.viku.prefs.get()).capturesDir)}>
          Folder
        </Button>
        {(!connected || embedded) && (
          <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => void window.viku?.signin.open('gemini')} title="The Sign-in window: copy-and-paste mode and AI Studio inside Viku">
            Advanced
          </Button>
        )}
      </footer>
    </aside>
  )
}
