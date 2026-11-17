import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Brain,
  Captions,
  Check,
  Church,
  Clapperboard,
  Cpu,
  FolderOpen,
  HardDrive,
  Images,
  Loader2,
  Music2,
  Play,
  RefreshCw,
  Sparkles,
  Type,
  Volume2,
  Wand2,
  X,
  type LucideIcon
} from 'lucide-react'
import { api } from '@/api'
import type { Health, LangOpt, Settings } from '@/api/types'
import { toast, useApp } from '@/state/app'
import { useJobs } from '@/state/jobs'
import { Button, IconButton, Segmented } from '../ui'
import { Logo } from '../Logo'

const STEPS = ['Welcome', 'Data folder', 'Engine & models', 'Sign-ins', 'Your church', 'Done'] as const

/** Shown once on first run (prefs.onboarded), re-openable from Settings → General. */
export function Onboarding() {
  const open = useApp((s) => s.onboardingOpen)
  const set = useApp((s) => s.set)
  const settings = useApp((s) => s.settings)
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<Settings | null>(null)

  useEffect(() => {
    if (open) {
      setStep(0)
      setDraft(settings ? structuredClone(settings) : null)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null

  const finish = async (then?: 'automate' | 'manual'): Promise<void> => {
    if (draft && settings && JSON.stringify(draft) !== JSON.stringify(settings)) {
      try {
        set({ settings: await api().saveSettings(draft) })
      } catch (e) {
        toast('error', `Could not save settings: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    await window.viku?.prefs.set({ onboarded: true })
    set({ onboardingOpen: false, ...(then ? { mode: then } : {}) })
  }
  const patch = (p: Partial<Settings>): void => setDraft((d) => (d ? { ...d, ...p } : d))
  const last = STEPS.length - 1

  return (
    <div className="ob-back" role="dialog" aria-modal aria-label="Welcome to Viku">
      <div className="ob">
        <aside className="ob-rail">
          <div className="ob-brand">
            <Logo size={30} />
            <span>Viku</span>
          </div>
          <ol className="ob-steps">
            {STEPS.map((s, i) => (
              <li key={s} className={i === step ? 'on' : i < step ? 'done' : ''}>
                <button type="button" onClick={() => setStep(i)} disabled={i > step + 1}>
                  <span className="ob-dot">{i < step ? <Check size={11} aria-hidden /> : i + 1}</span>
                  {s}
                </button>
              </li>
            ))}
          </ol>
          <span className="grow" />
          <button type="button" className="ob-skip" onClick={() => void finish()}>
            Skip setup
          </button>
        </aside>

        <main className="ob-main">
          <IconButton className="ob-close" icon={X} label="Close" onClick={() => void finish()} />
          <div className="ob-page" key={step}>
            {step === 0 && <Welcome />}
            {step === 1 && <DataFolder draft={draft} patch={patch} />}
            {step === 2 && <EngineModels />}
            {step === 3 && <SignIns />}
            {step === 4 && <ChurchStep draft={draft} patch={patch} />}
            {step === 5 && <DoneStep onGo={(m) => void finish(m)} />}
          </div>
          {step < last && (
            <footer className="ob-foot">
              {step > 0 ? (
                <Button variant="ghost" icon={ArrowLeft} onClick={() => setStep(step - 1)}>
                  Back
                </Button>
              ) : (
                <span />
              )}
              <span className="ob-progress" aria-hidden>
                {STEPS.map((_, i) => (
                  <span key={i} className={i <= step ? 'on' : ''} />
                ))}
              </span>
              <Button variant="primary" className="ob-next" onClick={() => setStep(step + 1)}>
                {step === 0 ? 'Get started' : step === 3 ? 'Continue' : 'Next'}
                <ArrowRight size={14} aria-hidden />
              </Button>
            </footer>
          )}
        </main>
      </div>
    </div>
  )
}

function Head({ kicker, title, children }: { kicker: string; title: string; children?: React.ReactNode }) {
  return (
    <header className="ob-head">
      <span className="ob-kicker">{kicker}</span>
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </header>
  )
}

function Welcome() {
  const feats: [LucideIcon, string, string][] = [
    [Wand2, 'Automate', 'One sermon in, finished 9:16 reels out — captions, verse cards, illustrations, music and a thumbnail each.'],
    [Clapperboard, 'Edit by hand', 'A calm, keyboard-first editor: pick lines from the transcript, trim on the timeline, fix captions.'],
    [HardDrive, 'Yours, offline', 'Speech recognition, Bibles and the clip finder run on this PC. Online helpers are optional.']
  ]
  return (
    <div className="ob-welcome">
      <div className="ob-hero">
        <Logo size={84} />
      </div>
      <Head kicker="Welcome" title="Sermons into reels, in your language">
        Viku turns a long Odia, Hindi or English sermon into short vertical reels that end on hope. This takes about a minute to set up.
      </Head>
      <div className="ob-feats">
        {feats.map(([Icon, t, d]) => (
          <div key={t} className="ob-feat">
            <span className="ob-feat-icon">
              <Icon size={16} aria-hidden />
            </span>
            <b>{t}</b>
            <span>{d}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function DataFolder({ draft, patch }: { draft: Settings | null; patch: (p: Partial<Settings>) => void }) {
  const health = useApp((s) => s.health)
  const dataDir = health?.data_dir || draft?.data_dir || '%APPDATA%\\Viku'
  const browse = async (key: 'projects_dir' | 'exports_dir', title: string): Promise<void> => {
    const p = await window.viku?.dialog.openFolder(title)
    if (p) patch({ [key]: p })
  }
  return (
    <>
      <Head kicker="Step 2 of 5" title="Where should your work live?">
        Projects hold the proxy video, transcript and reels of each sermon; finished MP4s and thumbnails go to exports. Pick a drive with room — a 2-hour sermon needs about 2 GB.
      </Head>
      {!draft ? (
        <div className="ob-note">Connect the engine (next step) to choose folders — they are kept by the engine.</div>
      ) : (
        <div className="ob-fields">
          <label className="ob-field">
            <span>Projects</span>
            <span className="ob-path">
              <input className="input" value={draft.projects_dir} onChange={(e) => patch({ projects_dir: e.target.value })} spellCheck={false} onKeyDown={(e) => e.stopPropagation()} />
              <Button icon={FolderOpen} onClick={() => void browse('projects_dir', 'Projects folder')}>
                Browse
              </Button>
            </span>
          </label>
          <label className="ob-field">
            <span>Exports</span>
            <span className="ob-path">
              <input
                className="input"
                value={draft.exports_dir}
                placeholder="Next to each project (default)"
                onChange={(e) => patch({ exports_dir: e.target.value })}
                spellCheck={false}
                onKeyDown={(e) => e.stopPropagation()}
              />
              <Button icon={FolderOpen} onClick={() => void browse('exports_dir', 'Exports folder')}>
                Browse
              </Button>
            </span>
          </label>
        </div>
      )}
      <div className="ob-note">
        <HardDrive size={14} aria-hidden />
        <span>
          Models, Bibles, fonts and your illustration library stay in the data folder <code>{dataDir}</code>.
        </span>
      </div>
    </>
  )
}

interface ModelRow {
  id: string
  icon: LucideIcon
  label: string
  enables: string
  ok: boolean | undefined
  fix?: string
}

function modelRows(h: Health | null): ModelRow[] {
  const r = h?.offline_ready
  const d = h?.details ?? {}
  const n = (k: string): number | undefined => (typeof d[k] === 'number' ? (d[k] as number) : undefined)
  const b = (k: string): boolean | undefined => (typeof d[k] === 'boolean' ? (d[k] as boolean) : undefined)
  const rows: ModelRow[] = [
    { id: 'asr', icon: Captions, label: 'Speech recognition', enables: 'Transcripts and captions in Odia and Hindi (IndicConformer)', ok: b('asr_indic') ?? r?.asr, fix: 'Download the IndicConformer model into models/' },
    { id: 'whisper', icon: Captions, label: 'English recognition', enables: 'English sermons (Whisper)', ok: b('asr_whisper_en'), fix: 'Optional — only needed for English sermons' },
    { id: 'denoise', icon: Volume2, label: 'Speech enhancement', enables: 'Clean, even voice on every reel (DeepFilterNet3)', ok: r?.denoise },
    { id: 'embed', icon: Brain, label: 'Viku Brain', enables: 'Finds reel-worthy moments; matches illustrations and verses by meaning', ok: r?.embed, fix: 'Without it the clip finder falls back to keywords' },
    { id: 'bible', icon: BookOpen, label: 'Offline Bibles', enables: 'Verse cards and lookup — IRV Odia, IRV Hindi, WEB', ok: r?.bible, fix: 'Download them in the next step (one time)' },
    { id: 'library', icon: Images, label: 'Illustration library', enables: `Cutaways picked automatically${n('library_images') !== undefined ? ` · ${n('library_images')} images` : ''}`, ok: r?.library, fix: 'Add images in Library, or generate them in AI Studio' },
    { id: 'music', icon: Music2, label: 'Music beds', enables: `Background music under every reel${n('music_tracks') !== undefined ? ` · ${n('music_tracks')} tracks` : ''}`, ok: n('music_tracks') === undefined ? undefined : (n('music_tracks') ?? 0) > 0 },
    { id: 'fonts', icon: Type, label: 'Caption fonts', enables: 'Noto Sans Oriya / Devanagari for captions', ok: b('fonts'), fix: 'Downloaded on first render when online' }
  ]
  return rows.filter((x) => x.ok !== undefined || ['asr', 'denoise', 'embed', 'bible', 'library'].includes(x.id))
}

function EngineModels() {
  const engine = useApp((s) => s.engine)
  const health = useApp((s) => s.health)
  const apiKind = useApp((s) => s.apiKind)
  const [busy, setBusy] = useState(false)
  const running = apiKind === 'live' ? engine?.state !== 'stopped' && engine?.state !== 'error' : engine?.state === 'running'

  const refresh = async (): Promise<void> => {
    setBusy(true)
    try {
      useApp.getState().set({ health: await api().health() })
    } catch {
      /* engine still down */
    } finally {
      setBusy(false)
    }
  }
  const start = async (): Promise<void> => {
    setBusy(true)
    const s = await window.viku?.engine.start()
    if (s) useApp.getState().set({ engine: s })
    setBusy(false)
    if (s?.state === 'running') {
      if (apiKind === 'mock') toast('info', 'The engine is up.', { label: 'Switch to live data', run: () => location.reload() })
      else void refresh()
    }
  }
  const rows = modelRows(health)
  const ready = rows.filter((r) => r.ok).length

  return (
    <>
      <Head kicker="Step 3 of 5" title="Engine & offline models">
        The engine does the heavy work on this PC. Here is what is ready — anything missing only switches its feature off.
      </Head>
      <div className={`ob-engine ${running ? 'ok' : 'down'}`}>
        <span className="ob-engine-icon">{engine?.state === 'starting' ? <Loader2 size={18} className="spin" /> : <Cpu size={18} />}</span>
        <div className="grow">
          <b>{running ? 'Engine is running' : engine?.state === 'starting' ? 'Starting the engine…' : apiKind === 'mock' ? 'Engine not connected — showing sample data' : 'Engine is not running'}</b>
          <span className="small muted">
            {health ? `v${health.version} · ${typeof health.gpu === 'string' ? health.gpu : health.gpu ? 'GPU' : 'CPU only'}` : (engine?.message ?? 'http://127.0.0.1:8765')}
          </span>
        </div>
        {running ? (
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void refresh()} disabled={busy}>
            Re-check
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={Play} onClick={() => void start()} disabled={busy || engine?.state === 'starting'}>
            Start engine
          </Button>
        )}
      </div>
      <div className="ob-models">
        <div className="ob-models-head small muted">
          {health ? `${ready} of ${rows.length} ready` : 'Start the engine to check models'}
        </div>
        {rows.map((r) => (
          <div key={r.id} className={`ob-model ${r.ok ? 'ok' : r.ok === false ? 'no' : 'unk'}`}>
            <span className="ob-model-icon">
              <r.icon size={15} aria-hidden />
            </span>
            <span className="ob-model-text">
              <b>{r.label}</b>
              <span>{r.enables}</span>
              {!r.ok && r.fix && health && <span className="ob-fix">{r.fix}</span>}
            </span>
            <span className={`ob-state ${r.ok ? 'ok' : r.ok === false ? 'no' : 'unk'}`}>{r.ok ? 'Ready' : r.ok === false ? 'Missing' : '—'}</span>
          </div>
        ))}
      </div>
    </>
  )
}

function SignIns() {
  const auth = useApp((s) => s.auth)
  const gemini = useApp((s) => s.gemini)
  const [dl, setDl] = useState(false)
  const geminiOn = Boolean(gemini?.signedIn || auth?.gemini_web)
  const download = async (): Promise<void> => {
    try {
      setDl(true)
      const ref = await api().bibleDownload()
      useJobs.getState().track(ref, 'Download Bibles (eBible)', {
        onDone: () => {
          setDl(false)
          void api()
            .authStatus()
            .then((a) => useApp.getState().set({ auth: a }))
          void api()
            .health()
            .then((h) => useApp.getState().set({ health: h }))
        },
        onError: () => setDl(false)
      })
    } catch (e) {
      setDl(false)
      toast('error', `Download failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const cards: { id: 'gemini' | 'heygen' | 'ebible'; icon: LucideIcon; title: string; body: string; on: boolean; action: React.ReactNode }[] = [
    {
      id: 'gemini',
      icon: Sparkles,
      title: 'Google AI Studio',
      body: 'Generate illustrations for cutaways the library cannot fill — free, in your own signed-in browser tab. Images land on the timeline by themselves.',
      on: geminiOn,
      action: (
        <Button size="sm" variant={geminiOn ? 'ghost' : 'default'} onClick={() => void window.viku?.signin.open('gemini')}>
          {geminiOn ? 'Open' : 'Sign in'}
        </Button>
      )
    },
    {
      id: 'heygen',
      icon: Music2,
      title: 'HeyGen music',
      body: 'Generate a fresh music bed from a mood (“hopeful worship piano”). Uses a device code — no password in Viku.',
      on: Boolean(auth?.heygen),
      action: (
        <Button size="sm" variant={auth?.heygen ? 'ghost' : 'default'} onClick={() => void window.viku?.signin.open('heygen')}>
          {auth?.heygen ? 'Open' : 'Sign in'}
        </Button>
      )
    },
    {
      id: 'ebible',
      icon: BookOpen,
      title: 'eBible download',
      body: 'One-time download of IRV Odia, IRV Hindi and the World English Bible for offline verse cards. No account.',
      on: auth?.ebible === 'downloaded',
      action:
        auth?.ebible === 'downloaded' ? (
          <span className="ob-done-chip">
            <Check size={12} aria-hidden /> Downloaded
          </span>
        ) : (
          <Button size="sm" variant="primary" onClick={() => void download()} disabled={dl}>
            {dl ? <Loader2 size={13} className="spin" aria-hidden /> : null}
            {dl ? 'Downloading…' : 'Download'}
          </Button>
        )
    }
  ]
  return (
    <>
      <Head kicker="Step 4 of 5 · optional" title="Online helpers">
        Everything works offline. These add generated pictures, fresh music and full Bibles — you can do them later from the chips in the top bar.
      </Head>
      <div className="ob-cards">
        {cards.map((c) => (
          <div key={c.id} className={`ob-card${c.on ? ' on' : ''}`}>
            <span className="ob-card-icon">
              <c.icon size={18} aria-hidden />
            </span>
            <div className="ob-card-text">
              <b>
                {c.title}
                {c.on && (
                  <span className="ob-on">
                    <Check size={11} aria-hidden /> connected
                  </span>
                )}
              </b>
              <span>{c.body}</span>
            </div>
            <div className="ob-card-act">{c.action}</div>
          </div>
        ))}
      </div>
    </>
  )
}

function ChurchStep({ draft, patch }: { draft: Settings | null; patch: (p: Partial<Settings>) => void }) {
  if (!draft) {
    return (
      <>
        <Head kicker="Step 5 of 5" title="Your church" />
        <div className="ob-note">The engine keeps these settings — start it, then set your church name in Settings → General.</div>
      </>
    )
  }
  return (
    <>
      <Head kicker="Step 5 of 5" title="Your church">
        The credit line is drawn small at the bottom of every reel, so people know where the message came from.
      </Head>
      <div className="ob-church">
        <div className="ob-fields">
          <label className="ob-field">
            <span>Church name</span>
            <input className="input" value={draft.church_name} placeholder="e.g. Grace Church Sambalpur" onChange={(e) => patch({ church_name: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
          </label>
          <label className="ob-field">
            <span>Credit line</span>
            <input className="input" value={draft.credit_line} placeholder="Pastor's name · Church name" onChange={(e) => patch({ credit_line: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
          </label>
          <div className="ob-field">
            <span>Usual sermon language</span>
            <Segmented
              ariaLabel="Default language"
              value={draft.default_language}
              onChange={(v: LangOpt) => patch({ default_language: v })}
              options={[
                { id: 'or', label: 'ଓଡ଼ିଆ Odia' },
                { id: 'hi', label: 'हिन्दी Hindi' },
                { id: 'en', label: 'English' },
                { id: 'auto', label: 'Mixed / auto' }
              ]}
            />
          </div>
        </div>
        <div className="ob-phone" aria-label="Credit line preview">
          <span className="ob-phone-cap">ସେ ମୋତେ କେବେ ଛାଡ଼ି ନାହାନ୍ତି।</span>
          <span className="ob-phone-credit">{draft.credit_line || draft.church_name || 'Your credit line'}</span>
          <Church size={22} className="ob-phone-mark" aria-hidden />
        </div>
      </div>
    </>
  )
}

function DoneStep({ onGo }: { onGo: (m: 'automate' | 'manual') => void }) {
  return (
    <div className="ob-done">
      <span className="ob-done-badge">
        <Check size={30} aria-hidden />
      </span>
      <Head kicker="All set" title="You're ready">
        Start with one sermon. You can change everything later in Settings, and reopen this guide from Settings → General.
      </Head>
      <div className="ob-choices">
        <button type="button" className="ob-choice primary" onClick={() => onGo('automate')}>
          <Wand2 size={20} aria-hidden />
          <b>Automate a sermon</b>
          <span>Pick a video, get finished reels</span>
        </button>
        <button type="button" className="ob-choice" onClick={() => onGo('manual')}>
          <Clapperboard size={20} aria-hidden />
          <b>Open the editor</b>
          <span>Choose moments yourself</span>
        </button>
      </div>
      <p className="small muted">
        Tip: press <kbd className="kbd">?</kbd> anywhere for keyboard shortcuts.
      </p>
    </div>
  )
}
