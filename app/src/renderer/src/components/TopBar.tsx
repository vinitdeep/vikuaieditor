import { Activity, Clapperboard, Download, Keyboard, Settings2, Sparkles, Wand2 } from 'lucide-react'
import { Logo } from './Logo'
import { useApp } from '@/state/app'
import { runningCount, useJobs } from '@/state/jobs'
import { useEditor, useReel } from '@/state/editor'
import { useGen } from '@/lib/gemini'
import { IconButton, Segmented } from './ui'
import type { SignInCard } from '@shared/ipc'

export { Logo }

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

  const geminiOn = Boolean(gemini?.extension?.connected || gemini?.signedIn || auth?.gemini_web)
  const aiOpen = useApp((s) => s.aiOpen)
  const aiWaiting = useGen((s) => Object.keys(s.queued).length)
  const toggleAi = (): void => set({ aiOpen: !aiOpen, activityOpen: false })
  const engState: 'on' | 'warn' | 'off' =
    apiKind === 'mock' ? 'warn' : engine?.state === 'running' || (!engine && health) ? 'on' : engine?.state === 'starting' || engine?.state === 'checking' ? 'warn' : 'off'
  const engTitle =
    apiKind === 'mock'
      ? `Mock data — engine ${engine?.state ?? 'not connected'}`
      : `Engine ${engine?.state ?? 'running'} · ${health ? `v${health.version} · GPU: ${typeof health.gpu === 'string' ? health.gpu : health.gpu ? 'yes' : 'CPU only'}` : ''}`

  return (
    <header className="topbar">
      <div className="tb-left">
        <Logo size={26} />
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
          <button
            type="button"
            className={`schip s-${geminiOn ? 'on' : 'off'}${aiOpen ? ' active' : ''}${aiWaiting ? ' busy' : ''}`}
            onClick={toggleAi}
            aria-expanded={aiOpen}
            title={geminiOn ? 'AI pictures — Google AI Studio connected' : 'AI pictures — set up Google AI Studio'}
          >
            <span className="dot" aria-hidden />
            AI pictures
            {aiWaiting > 0 && (
              <span className="tb-count num" aria-label={`${aiWaiting} pictures waiting`}>
                {aiWaiting}
              </span>
            )}
          </button>
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
        <button type="button" className={`tb-activity${running ? ' busy' : ''}`} onClick={() => set({ activityOpen: !useApp.getState().activityOpen, aiOpen: false })} title="Activity">
          <Activity size={14} aria-hidden />
          {running > 0 && <span className="tb-count num">{running}</span>}
        </button>
        <IconButton icon={Keyboard} label="Keyboard shortcuts" onClick={() => set({ shortcutsOpen: true })} kbd="?" />
        <IconButton icon={Settings2} label="Settings" onClick={() => set({ settingsOpen: true })} kbd="Ctrl+," />
        <button type="button" className="btn btn-primary btn-md tb-export" onClick={() => set({ exportOpen: true })} disabled={!reel && mode === 'manual'}>
          {mode === 'automate' ? <Sparkles size={14} aria-hidden /> : <Download size={14} aria-hidden />}
          <span>Export</span>
        </button>
      </div>
    </header>
  )
}
