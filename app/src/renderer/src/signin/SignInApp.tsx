import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ClipboardPaste,
  Globe,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  House,
  Image as ImageIcon,
  KeyRound,
  ListPlus,
  Loader2,
  Music2,
  RotateCw,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import type { CaptureEvent, GeminiMode, GeminiViewState, PromptItem, SignInCard } from '@shared/ipc'
import { api, initApi } from '@/api'
import type { AuthStatus } from '@/api/types'
import { isRec, str } from '@/api/normalize'
import { toast, useApp } from '@/state/app'
import { useJobs } from '@/state/jobs'
import { Logo } from '@/components/TopBar'
import { Button, IconButton, Progress } from '@/components/ui'
import { Toasts } from '@/components/shell/Shell'

const bridge = window.viku

function Card({ id, active, onClick, icon: Icon, title, sub, status, tone }: { id: SignInCard; active: boolean; onClick: (id: SignInCard) => void; icon: typeof Music2; title: string; sub: string; status: string; tone: 'on' | 'off' | 'warn' }) {
  return (
    <button type="button" className={`si-card${active ? ' on' : ''}`} onClick={() => onClick(id)} aria-pressed={active}>
      <span className={`si-icon si-${id}`}>
        <Icon size={18} aria-hidden />
      </span>
      <span className="si-card-body">
        <span className="si-card-title">{title}</span>
        <span className="si-card-sub">{sub}</span>
      </span>
      <span className={`si-status s-${tone}`}>
        <span className="dot" aria-hidden />
        {status}
      </span>
    </button>
  )
}

export function SignInApp() {
  const [ready, setReady] = useState(false)
  const [card, setCard] = useState<SignInCard>('gemini')
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [gem, setGem] = useState<GeminiViewState | null>(null)
  const [queue, setQueue] = useState<PromptItem[]>([])
  const [captures, setCaptures] = useState<CaptureEvent[]>([])

  useEffect(() => {
    void (async () => {
      const a = await initApi()
      useApp.getState().set({ apiKind: a.kind })
      a.subscribe((ev) => useJobs.getState().ingest(ev))
      setAuth(await a.authStatus().catch(() => null))
      setReady(true)
    })()
    if (!bridge) return
    const offs = [
      bridge.signin.onFocusCard((c) => setCard(c)),
      bridge.signin.onQueue((q) => setQueue([...q])),
      bridge.signin.onCapture((c) => setCaptures((x) => [c, ...x].slice(0, 24))),
      bridge.signin.onToast((t) => toast(t.kind, t.text)),
      bridge.signin.onGeminiState((s) => setGem(s))
    ]
    void bridge.signin.list().then((q) => setQueue([...q]))
    void bridge.signin.geminiState().then(setGem)
    return () => offs.forEach((o) => o())
  }, [])

  const refreshAuth = (): void => {
    void api()
      .authStatus()
      .then(setAuth)
      .catch(() => undefined)
  }

  return (
    <div className="si-app">
      <header className="si-top">
        <Logo size={20} />
        <span className="tb-app">Viku</span>
        <span className="muted">Sign in &amp; connections</span>
        <span className="grow" />
        <span className="si-privacy">
          <ShieldCheck size={13} aria-hidden /> You sign in yourself — Viku never sees or stores passwords
        </span>
      </header>
      <div className="si-main">
        <aside className="si-side">
          <Card
            id="gemini"
            active={card === 'gemini'}
            onClick={setCard}
            icon={Sparkles}
            title="Google AI Studio"
            sub="Free illustrations with Gemini, in your own browser session"
            status={gem?.mode === 'browser' ? (gem.extension?.connected ? 'Automatic (extension)' : gem.watching ? 'Uses your browser' : 'Downloads not watched') : gem?.signedIn ? 'Signed in' : 'Not signed in'}
            tone={gem?.mode === 'browser' ? (gem.extension?.connected || gem.watching ? 'on' : 'warn') : gem?.signedIn ? 'on' : 'off'}
          />
          <Card id="heygen" active={card === 'heygen'} onClick={setCard} icon={Music2} title="HeyGen" sub="Royalty-free music beds for reels" status={auth?.heygen ? 'Connected' : 'Not connected'} tone={auth?.heygen ? 'on' : 'off'} />
          <Card
            id="ebible"
            active={card === 'ebible'}
            onClick={setCard}
            icon={BookOpen}
            title="eBible"
            sub="Download IRV Odia, IRV Hindi and WEB once, then fully offline"
            status={auth?.ebible === 'downloaded' ? 'Downloaded' : 'Missing'}
            tone={auth?.ebible === 'downloaded' ? 'on' : 'warn'}
          />
          <div className="si-note small muted">Everything here is optional. Viku works offline with your local library, music and models.</div>
        </aside>
        <section className="si-content">
          {card === 'gemini' && <GeminiPane gem={gem} queue={queue} captures={captures} />}
          {card === 'heygen' && ready && <HeygenPane connected={Boolean(auth?.heygen)} onChange={refreshAuth} />}
          {card === 'ebible' && ready && <EbiblePane status={auth?.ebible ?? 'missing'} onChange={refreshAuth} />}
        </section>
      </div>
      <Toasts />
    </div>
  )
}

function ModeSwitch({ mode }: { mode: GeminiMode }) {
  const set = (m: GeminiMode): void => void bridge?.signin.setMode(m)
  return (
    <div className="gem-mode" role="radiogroup" aria-label="Where AI Studio runs">
      <button type="button" role="radio" aria-checked={mode === 'browser'} className={mode === 'browser' ? 'on' : ''} onClick={() => set('browser')}>
        <Globe size={12} aria-hidden /> Your browser
      </button>
      <button type="button" role="radio" aria-checked={mode === 'embedded'} className={mode === 'embedded' ? 'on' : ''} onClick={() => set('embedded')}>
        <Sparkles size={12} aria-hidden /> Inside Viku
      </button>
    </div>
  )
}

function BrowserGuide({ gem }: { gem: GeminiViewState | null }) {
  const changeFolder = async (): Promise<void> => {
    const dir = await bridge?.dialog.openFolder('Folder your browser saves downloads to')
    if (dir) await bridge?.prefs.set({ downloadsDir: dir })
  }
  const steps: { icon: typeof Globe; title: string; body: string }[] = [
    { icon: Globe, title: 'Open AI Studio in your browser', body: 'Sign in there with your Google account, as you normally would. Choose a Gemini model that makes images.' },
    { icon: ClipboardPaste, title: 'Send next, then paste', body: 'Viku copies the next prompt. Click the AI Studio prompt box, press Ctrl+V and run it.' },
    { icon: Download, title: 'Download the image', body: 'Use the download button on the picture. Viku sees it arrive in your Downloads folder and files it under the planned name.' }
  ]
  return (
    <div className="gem-guide">
      <div className="gem-guide-in">
        <ExtensionGuide gem={gem} />
        <details className="gem-manual">
          <summary>Or do it by hand (copy, paste, download)</summary>
        <p className="muted">Google only allows sign-in from a normal browser like Chrome or Edge, so AI Studio opens there. Viku never sees your password.</p>
        <ol className="gem-steps">
          {steps.map((st, i) => (
            <li key={st.title}>
              <span className="gem-step-n num">{i + 1}</span>
              <span className="grow">
                <span className="gem-step-title">
                  <st.icon size={13} aria-hidden /> {st.title}
                </span>
                <span className="small muted">{st.body}</span>
              </span>
            </li>
          ))}
        </ol>
        <Button variant="primary" icon={ExternalLink} onClick={() => void bridge?.signin.openBrowser()}>
          Open AI Studio in your browser
        </Button>
        <div className={`gem-watch small ${gem?.watching ? 'ok' : 'warn'}`}>
          <span className="dot" aria-hidden />
          <span className="grow ellipsis" title={gem?.watchDir}>
            {gem?.watching ? 'Watching ' : 'Cannot watch '}
            <b>{gem?.watchDir || 'Downloads'}</b>
          </span>
          <button type="button" className="linkish" onClick={() => void changeFolder()}>
            <FolderOpen size={11} aria-hidden /> Change
          </button>
        </div>
        <div className="small muted">
          Only images that arrive while a prompt is waiting are picked up (at least 1024 px). They are copied; your Downloads folder is left as it is.
        </div>
        </details>
      </div>
    </div>
  )
}

const EXT_STATE: Record<string, string> = {
  idle: 'Ready — it takes prompts as soon as they are queued',
  working: 'Making a picture',
  signin: 'Sign in to Google in the AI Studio tab it opened',
  paused: 'Paused after an AI Studio limit',
  off: 'Turned off in the extension'
}

/** Automatic route: the Viku extension in the user's own Chrome / Edge runs the queue in AI Studio. */
function ExtensionGuide({ gem }: { gem: GeminiViewState | null }) {
  const ext = gem?.extension
  const copyAddress = (): void => {
    void navigator.clipboard.writeText('chrome://extensions').then(() => toast('success', 'Copied — paste it in the address bar of Chrome (Edge: edge://extensions)'))
  }
  if (ext?.connected) {
    const paused = ext.pausedUntil ? Math.max(1, Math.ceil((ext.pausedUntil - Date.now()) / 60000)) : 0
    return (
      <div className="gem-ext on">
        <h2>
          <Sparkles size={16} aria-hidden /> Automatic — Viku extension connected
        </h2>
        <p className="muted">
          Queued prompts are made one at a time in an AI Studio tab of your browser, with your own Google account, and come back here by themselves. Keep the browser open; you can keep working.
        </p>
        <div className={`gem-watch small ${ext.state === 'signin' || paused ? 'warn' : 'ok'}`}>
          <span className="dot" aria-hidden />
          <span className="grow">
            {paused ? `Paused after an AI Studio limit — carries on in about ${paused} min (Send next tries now)` : (EXT_STATE[ext.state ?? 'idle'] ?? EXT_STATE.idle)}
            {ext.note && ext.state === 'working' ? `: ${ext.note}` : ''}
          </span>
          <span className="muted">v{ext.version}</span>
        </div>
      </div>
    )
  }
  const steps: { title: string; body: string }[] = [
    { title: 'Open the extension folder', body: 'The Viku extension comes with Viku. Keep this folder where it is.' },
    { title: 'Open your browser’s extensions page', body: 'In Chrome go to chrome://extensions (Edge: edge://extensions) and switch on Developer mode (top right).' },
    { title: 'Load unpacked', body: 'Click “Load unpacked” and choose the folder from step 1. Viku’s icon appears in the toolbar.' },
    { title: 'Sign in to Google in that browser', body: 'Open aistudio.google.com once and sign in with your own account. That is all — Viku connects by itself.' }
  ]
  return (
    <div className="gem-ext">
      <h2>
        <Sparkles size={16} aria-hidden /> Automatic: add the Viku extension
      </h2>
      <p className="muted">
        Google blocks AI Studio inside other apps, so Viku makes the pictures in your own Chrome or Edge with a small extension. You sign in to Google there yourself; Viku never sees your password. Set up once.
      </p>
      <ol className="gem-steps">
        {steps.map((st, i) => (
          <li key={st.title}>
            <span className="gem-step-n num">{i + 1}</span>
            <span className="grow">
              <span className="gem-step-title">{st.title}</span>
              <span className="small muted">{st.body}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="row gap">
        <Button variant="primary" icon={FolderOpen} onClick={() => void bridge?.signin.revealExtension()}>
          Open extension folder
        </Button>
        <Button icon={Copy} onClick={copyAddress}>
          Copy chrome://extensions
        </Button>
      </div>
      <div className="gem-watch small warn">
        <span className="dot" aria-hidden />
        <span className="grow">{ext?.port ? 'Waiting for the extension…' : 'The extension link could not start (another program uses its port)'}</span>
      </div>
    </div>
  )
}

function EmbeddedHost() {
  const hostRef = useRef<HTMLDivElement>(null)
  // keep the AI Studio view glued to the placeholder rect
  useLayoutEffect(() => {
    const el = hostRef.current
    if (!el || !bridge) return
    const send = (): void => {
      const r = el.getBoundingClientRect()
      void bridge.signin.setGeminiBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
    }
    const ro = new ResizeObserver(send)
    ro.observe(el)
    window.addEventListener('resize', send)
    send()
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', send)
      void bridge.signin.setGeminiBounds(null)
    }
  }, [])
  return (
    <div className="gem-host" ref={hostRef}>
      {!bridge && <div className="gem-placeholder">AI Studio opens here in the desktop app.</div>}
      {bridge && (
        <div className="gem-placeholder">
          <Loader2 size={18} className="spin" /> Loading Google AI Studio…
        </div>
      )}
    </div>
  )
}

function GeminiPane({ gem, queue, captures }: { gem: GeminiViewState | null; queue: PromptItem[]; captures: CaptureEvent[] }) {
  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')
  const mode: GeminiMode = gem?.mode ?? 'browser'

  const add = async (): Promise<void> => {
    const p = prompt.trim()
    if (!p || !bridge) return
    const n = name.trim() || `illustration-${String(queue.length + 1).padStart(2, '0')}`
    await bridge.signin.queue([{ prompt: p, name: n }])
    setPrompt('')
    setName('')
  }

  const waiting = queue.filter((q) => q.status === 'queued').length
  const sent = queue.filter((q) => q.status === 'sent').length

  return (
    <div className="gem">
      <div className="gem-bar">
        <ModeSwitch mode={mode} />
        {mode === 'browser' ? (
          <>
            <span className="grow" />
            <span className={`si-status s-${gem?.extension?.connected || gem?.watching ? 'on' : 'warn'}`}>
              <span className="dot" aria-hidden />
              {gem?.extension?.connected ? 'Extension connected — automatic' : gem?.watching ? 'Watching Downloads' : 'Downloads folder not found'}
            </span>
          </>
        ) : (
          <>
        <IconButton icon={ArrowLeft} label="Back" onClick={() => void bridge?.signin.geminiNav('back')} />
        <IconButton icon={ArrowRight} label="Forward" onClick={() => void bridge?.signin.geminiNav('forward')} />
        <IconButton icon={gem?.loading ? Loader2 : RotateCw} className={gem?.loading ? 'spin-icon' : ''} label="Reload" onClick={() => void bridge?.signin.geminiNav('reload')} />
        <IconButton icon={House} label="AI Studio home" onClick={() => void bridge?.signin.geminiNav('home')} />
        <span className="gem-url ellipsis" title={gem?.url}>
          {gem?.url || 'https://aistudio.google.com/'}
        </span>
        <span className={`si-status s-${gem?.signedIn ? 'on' : 'off'}`}>
          <span className="dot" aria-hidden />
          {gem?.signedIn ? 'Google session active' : 'Sign in inside the page'}
        </span>
          </>
        )}
      </div>
      {mode === 'embedded' && !gem?.signedIn && (
        <div className="gem-warn small">
          If Google says “This browser or app may not be secure”, switch to <b>Your browser</b>. Google blocks sign-in inside apps for many accounts.
        </div>
      )}
      <div className="gem-split">
        {mode === 'browser' ? <BrowserGuide gem={gem} /> : <EmbeddedHost />}
        <aside className="gem-queue">
          <div className="gq-head">
            <span>Prompt queue</span>
            <span className="muted small num">
              {waiting} waiting · {sent} sent
            </span>
          </div>
          <div className="gq-add">
            <textarea className="input area" rows={3} placeholder="Describe an illustration…" value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Prompt" />
            <div className="row gap">
              <input className="input grow" placeholder="file name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="File name" />
              <IconButton icon={ListPlus} label="Add to queue" onClick={() => void add()} />
            </div>
          </div>
          <div className="gq-list">
            {!queue.length && <div className="muted small pad">Prompts queued from a reel’s Cutaway inspector appear here.</div>}
            {queue.map((q, i) => (
              <div key={q.id} className={`gq-item gs-${q.status}`}>
                <span className="gq-n num">{i + 1}</span>
                <div className="grow gq-body">
                  <div className="gq-name ellipsis">{q.name}</div>
                  <div className="gq-prompt small">{q.prompt}</div>
                  {q.file && (
                    <div className="small gq-file ellipsis">
                      <Check size={11} aria-hidden /> {q.file.split(/[\\/]/).pop()} · via {q.via}
                    </div>
                  )}
                </div>
                <span className={`gq-status num`}>{q.status}</span>
                <IconButton icon={X} label="Remove" size={12} onClick={() => void bridge?.signin.remove(q.id)} />
              </div>
            ))}
          </div>
          <div className="gq-actions">
            <Button variant="primary" icon={Send} disabled={!waiting} onClick={() => void bridge?.signin.sendNext()}>
              Send next
            </Button>
            <IconButton icon={Trash2} label="Clear captured" onClick={() => void bridge?.signin.clearDone()} />
          </div>
          {captures.length > 0 && (
            <div className="gq-caps">
              <div className="small muted">Captured</div>
              <div className="caps-grid">
                {captures.slice(0, 8).map((c) => (
                  <button key={c.file} type="button" className="cap-tile" title={`${c.file}\n${c.width}×${c.height} via ${c.via}`} onClick={() => void bridge?.shell.reveal(c.file)}>
                    <ImageIcon size={14} aria-hidden />
                    <span className="ellipsis small">{c.file.split(/[\\/]/).pop()}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="gq-help small muted">
            {mode === 'browser'
              ? gem?.extension?.connected
                ? 'The Viku extension makes each queued prompt in your browser and files the picture here under the planned name.'
                : 'Images you download while a prompt is waiting (≥ 1024 px) are copied here under the planned name, in order.'
              : 'Images are captured from downloads or from the page’s own network responses (≥ 1024 px) and filed under the planned name, in order.'}
            <button type="button" className="linkish" onClick={async () => void bridge?.shell.reveal((await bridge.prefs.get()).capturesDir)}>
              <FolderOpen size={11} aria-hidden /> Captures folder
            </button>
          </div>
        </aside>
      </div>
    </div>
  )
}

function HeygenPane({ connected, onChange }: { connected: boolean; onChange: () => void }) {
  const [jobId, setJobId] = useState<string | null>(null)
  const job = useJobs((s) => (jobId ? s.jobs[jobId] : undefined))
  const [code, setCode] = useState<{ code: string; url: string } | null>(null)

  useEffect(() => {
    if (!job) return
    const r = job.result
    if (isRec(r) && str(r.code)) setCode({ code: str(r.code), url: str(r.url, 'https://app.heygen.com/') })
    else {
      const m = /([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(job.message)
      const u = /(https?:\/\/\S+)/.exec(job.message)
      if (m) setCode({ code: m[1], url: u?.[1] ?? 'https://app.heygen.com/' })
    }
  }, [job])

  const start = async (): Promise<void> => {
    try {
      const ref = await api().heygenLogin()
      setJobId(ref.job)
      useJobs.getState().track(ref, 'HeyGen sign-in', {
        onDone: () => {
          toast('success', 'HeyGen connected')
          setCode(null)
          onChange()
        }
      })
    } catch (e) {
      toast('error', `HeyGen sign-in failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="si-pane">
      <div className="si-hero">
        <span className="si-icon si-heygen big">
          <Music2 size={26} />
        </span>
        <div>
          <h2>HeyGen music</h2>
          <p className="muted">Generate music beds by intent (“hopeful worship piano, gentle build”). Sign-in uses a device code — you approve it in your own browser.</p>
        </div>
      </div>
      {connected ? (
        <div className="si-ok">
          <Check size={16} /> Connected. Generate tracks from Library → Music.
        </div>
      ) : code ? (
        <div className="device">
          <div className="small muted">Enter this code on the HeyGen page:</div>
          <div className="device-code num">{code.code}</div>
          <div className="row gap center">
            <Button icon={Copy} onClick={() => void navigator.clipboard.writeText(code.code)}>
              Copy code
            </Button>
            <Button variant="primary" icon={ExternalLink} onClick={() => void bridge?.shell.openExternal(code.url)}>
              Open sign-in page
            </Button>
          </div>
          {job && (job.state === 'running' || job.state === 'queued') && (
            <div className="small muted row gap center">
              <Loader2 size={12} className="spin" /> Waiting for approval…
            </div>
          )}
        </div>
      ) : (
        <Button variant="primary" icon={KeyRound} onClick={() => void start()} disabled={Boolean(job && job.state === 'running')}>
          Sign in with a device code
        </Button>
      )}
    </div>
  )
}

function EbiblePane({ status, onChange }: { status: 'downloaded' | 'missing'; onChange: () => void }) {
  const [jobId, setJobId] = useState<string | null>(null)
  const job = useJobs((s) => (jobId ? s.jobs[jobId] : undefined))
  const start = async (): Promise<void> => {
    const ref = await api().bibleDownload()
    setJobId(ref.job)
    useJobs.getState().track(ref, 'Download Bibles', {
      onDone: () => {
        toast('success', 'Bibles downloaded — verse lookup is offline now')
        onChange()
      }
    })
  }
  const busy = job && (job.state === 'running' || job.state === 'queued')
  return (
    <div className="si-pane">
      <div className="si-hero">
        <span className="si-icon si-ebible big">
          <BookOpen size={26} />
        </span>
        <div>
          <h2>eBible</h2>
          <p className="muted">One-time download of public-domain / open-licence translations from eBible.org, parsed for fast offline lookup. No account needed.</p>
        </div>
      </div>
      <div className="bibles">
        {[
          ['ory', 'ଓଡ଼ିଆ', 'Indian Revised Version (IRV) Odia'],
          ['hin2017', 'हिन्दी', 'Indian Revised Version (IRV) Hindi 2017'],
          ['eng-web', 'English', 'World English Bible (WEB)']
        ].map(([code, native, name]) => (
          <div key={code} className="bible-row">
            <span className="bible-native">{native}</span>
            <span className="grow">
              <span>{name}</span>
              <span className="muted small"> · {code}</span>
            </span>
            {status === 'downloaded' ? <Check size={14} className="ok" /> : <Download size={14} className="muted" />}
          </div>
        ))}
      </div>
      {busy && job ? (
        <div className="dl-progress">
          <div className="row gap">
            <Loader2 size={13} className="spin" />
            <span className="grow small">{job.message}</span>
            <span className="num small">{Math.round(job.progress * 100)}%</span>
          </div>
          <Progress value={job.progress} />
        </div>
      ) : status === 'downloaded' ? (
        <div className="si-ok">
          <Check size={16} /> Downloaded — lookups work offline.
          <Button size="sm" variant="ghost" icon={RotateCw} onClick={() => void start()}>
            Re-download
          </Button>
        </div>
      ) : (
        <Button variant="primary" icon={Download} onClick={() => void start()}>
          Download Bibles
        </Button>
      )}
    </div>
  )
}
