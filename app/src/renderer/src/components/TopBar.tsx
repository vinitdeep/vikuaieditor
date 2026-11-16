import { Activity, Clapperboard, Download, Settings2, Sparkles, Wand2 } from 'lucide-react'
import { useApp } from '@/state/app'
import { runningCount, useJobs } from '@/state/jobs'
import { useEditor, useReel } from '@/state/editor'
import { IconButton, Segmented } from './ui'
import type { SignInCard } from '@shared/ipc'

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id="vk-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffe17e" />
          <stop offset="1" stopColor="#f2b71c" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="6.5" fill="url(#vk-g)" />
      <path d="M6.6 8.2 12 17.6l5.4-9.4" stroke="#1d1700" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="6.3" r="1.55" fill="#1d1700" />
    </svg>
  )
}

function StatusChip({ label, state, onClick, title }: { label: string; state: 'on' | 'off' | 'warn'; onClick: () => void; title: string }) {
  return (
    <button type="button" className={`schip s-${state}`} onClick={onClick} title={title}>
      <span className="dot" aria-hidden />
      {label}
    </button>
  )
}

export function TopBar() {
  const mode = useApp((s) => s.mode)
  const set = useApp((s) => s.set)
  const auth = useApp((s) => s.auth)
  const gemini = useApp((s) => s.gemini)
  const engine = useApp((s) => s.engine)
  const health = useApp((s) => s.health)
  const apiKind = useApp((s) => s.apiKind)
  const running = useJobs(runningCount)
  const project = useEditor((s) => s.project)
  const dirty = useEditor((s) => s.dirty)
  const reel = useReel()

  const openSignin = (card: SignInCard): void => {
    void window.viku?.signin.open(card)
  }

  const geminiOn = Boolean(gemini?.signedIn || auth?.gemini_web)
  const engState: 'on' | 'warn' | 'off' =
    apiKind === 'mock' ? 'warn' : engine?.state === 'running' || (!engine && health) ? 'on' : engine?.state === 'starting' || engine?.state === 'checking' ? 'warn' : 'off'
  const engTitle =
    apiKind === 'mock'
      ? `Mock data — engine ${engine?.state ?? 'not connected'}`
      : `Engine ${engine?.state ?? 'running'} · ${health ? `v${health.version} · GPU: ${typeof health.gpu === 'string' ? health.gpu : health.gpu ? 'yes' : 'CPU only'}` : ''}`

  return (
    <header className="topbar">
      <div className="tb-left">
        <Logo />
        <span className="tb-app">Viku</span>
        <span className="tb-sep" aria-hidden />
        <span className="tb-project" title={project?.video_path}>
          {project ? project.name : 'No project'}
          {reel && mode === 'manual' && (
            <>
              <span className="tb-crumb">/</span>
              <span className={`tb-reel lang-${reel.language}`}>{reel.title || 'Untitled reel'}</span>
            </>
          )}
          {dirty && <span className="tb-dirty" title="Saving…" />}
        </span>
      </div>

      <div className="tb-center">
        <Segmented
          size="lg"
          ariaLabel="Mode"
          value={mode}
          onChange={(m) => set({ mode: m })}
          options={[
            { id: 'automate', label: 'Automate', icon: Wand2, title: 'One click: sermon → finished reels' },
            { id: 'manual', label: 'Manual', icon: Clapperboard, title: 'Edit reels on the timeline' }
          ]}
        />
      </div>

      <div className="tb-right">
        <div className="tb-chips">
          <StatusChip label="Gemini" state={geminiOn ? 'on' : 'off'} onClick={() => openSignin('gemini')} title={geminiOn ? 'Google AI Studio: signed in' : 'Google AI Studio: not signed in — click to open Sign-in'} />
          <StatusChip label="HeyGen" state={auth?.heygen ? 'on' : 'off'} onClick={() => openSignin('heygen')} title={auth?.heygen ? 'HeyGen music: signed in' : 'HeyGen music: not signed in'} />
          <StatusChip
            label="eBible"
            state={auth?.ebible === 'downloaded' ? 'on' : 'off'}
            onClick={() => openSignin('ebible')}
            title={auth?.ebible === 'downloaded' ? 'Bibles downloaded (offline)' : 'Bibles not downloaded yet'}
          />
        </div>
        <button type="button" className={`engine-dot e-${engState}`} onClick={() => set({ settingsOpen: true })} title={engTitle} aria-label={engTitle}>
          <span aria-hidden />
          {apiKind === 'mock' ? 'Mock' : 'Engine'}
        </button>
        <button type="button" className={`tb-activity${running ? ' busy' : ''}`} onClick={() => set({ activityOpen: !useApp.getState().activityOpen })} title="Activity">
          <Activity size={14} aria-hidden />
          {running > 0 && <span className="tb-count num">{running}</span>}
        </button>
        <IconButton icon={Settings2} label="Settings" onClick={() => set({ settingsOpen: true })} kbd="Ctrl+," />
        <button type="button" className="btn btn-primary btn-md tb-export" onClick={() => set({ exportOpen: true })} disabled={!reel && mode === 'manual'}>
          {mode === 'automate' ? <Sparkles size={14} aria-hidden /> : <Download size={14} aria-hidden />}
          <span>Export</span>
        </button>
      </div>
    </header>
  )
}
