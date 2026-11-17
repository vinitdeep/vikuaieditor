import { useEffect, useState } from 'react'
import { api, initApi } from '@/api'
import { toast, useApp } from '@/state/app'
import { currentReel, useEditor } from '@/state/editor'
import { useJobs } from '@/state/jobs'
import { usePlayback } from '@/state/playback'
import { handleCapture, resumeQueue, syncQueue } from '@/lib/gemini'
import { useLibraryIndex } from '@/lib/cutaways'
import { useTranscriptSel } from '@/state/transcriptSel'
import { useHotkeys } from '@/lib/hotkeys'
import { TopBar } from '@/components/TopBar'
import { Logo } from '@/components/Logo'
import { Browser } from '@/components/browser/Browser'
import { Viewer } from '@/components/viewer/Viewer'
import { Inspector } from '@/components/inspector/Inspector'
import { Timeline } from '@/components/timeline/Timeline'
import { AutomateView, useAuto } from '@/components/automate/AutomateView'
import { ActivityDrawer, ExportDialog, Splitter, Toasts } from '@/components/shell/Shell'
import { SettingsDialog } from '@/components/shell/SettingsDialog'
import { ShortcutsSheet } from '@/components/shell/ShortcutsSheet'
import { Onboarding } from '@/components/shell/Onboarding'
import { EngineBanner } from '@/components/shell/EngineBanner'
import { SetupScreen } from '@/components/shell/SetupScreen'
import { AboutDialog } from '@/components/shell/AboutDialog'
import type { EngineStatus } from '@shared/ipc'

async function boot(onWait: (msg: string) => void): Promise<void> {
  const a = await initApi(onWait)
  const app = useApp.getState()
  const params = new URLSearchParams(location.search)
  const prefs = window.viku ? await window.viku.prefs.get() : null
  const forced = params.get('adapter')
  app.set({ apiKind: a.kind, adapterPref: forced === 'mock' || forced === 'live' ? forced : (prefs?.adapter ?? 'auto') })
  a.subscribe((ev) => useJobs.getState().ingest(ev))

  const bridge = window.viku
  if (bridge) {
    app.set({ engine: await bridge.engine.status() })
    bridge.engine.onStatus((s) => {
      const prev = useApp.getState().engine
      useApp.getState().set({ engine: s })
      if (useApp.getState().apiKind === 'mock' && s.state === 'running' && prev?.state !== 'running') {
        void bridge.prefs.get().then((p) => {
          if (p.adapter !== 'mock') toast('info', 'The engine is up.', { label: 'Switch to live data', run: () => location.reload() })
        })
      }
    })
    bridge.signin.onCapture((ev) => void handleCapture(ev))
    bridge.signin.onQueue((items) => syncQueue(items))
    bridge.signin.onToast((t) => toast(t.kind, t.text))
    bridge.signin.onGeminiState((g) => useApp.getState().set({ gemini: g }))
    void bridge.signin.geminiState().then((g) => useApp.getState().set({ gemini: g }))
  }

  const [health, auth, settings] = await Promise.allSettled([a.health(), a.authStatus(), a.getSettings()])
  app.set({
    health: health.status === 'fulfilled' ? health.value : null,
    auth: auth.status === 'fulfilled' ? auth.value : null,
    settings: settings.status === 'fulfilled' ? settings.value : null
  })

  const mode = params.get('mode')
  if (mode === 'automate' || mode === 'manual') app.set({ mode })

  void useLibraryIndex.getState().load()
  // first run (or ?onboarding=1): the welcome guide
  if ((prefs && !prefs.onboarded && !params.has('no-onboarding')) || params.has('onboarding')) app.set({ onboardingOpen: true })

  await useEditor.getState().loadProjects()
  const first = useEditor.getState().projects[0]
  if (first) await useEditor.getState().openProject(first.id)
  // AI Studio prompts queued before a reload / restart: badges back on their cutaways, late captures attached
  if (a.kind === 'live' || params.has('debug')) void resumeQueue()

  // refresh sign-in chips when the window regains focus
  window.addEventListener('focus', () => {
    void api()
      .authStatus()
      .then((s) => useApp.getState().set({ auth: s }))
      .catch(() => undefined)
  })

  if (params.has('debug')) {
    Object.assign(window, { __viku: { useApp, useEditor, usePlayback, useJobs, useAuto, useTranscriptSel, api, currentReel } })
  }
}

export function App() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [waitMsg, setWaitMsg] = useState<string | null>(null)
  // first launch of the installed app: the engine environment is being created (bootstrap.ps1)
  const [setup, setSetup] = useState<EngineStatus | null>(null)
  const mode = useApp((s) => s.mode)
  const layout = useApp((s) => s.layout)
  const setLayout = useApp((s) => s.setLayout)
  useHotkeys()

  useEffect(() => {
    const bridge = window.viku
    if (!bridge) return
    const show = (st: EngineStatus): void => setSetup(st.state === 'setup' || (st.state === 'error' && st.setup?.error) ? st : null)
    void bridge.engine.status().then(show)
    return bridge.engine.onStatus(show)
  }, [])

  useEffect(() => {
    boot(setWaitMsg)
      .then(() => setReady(true))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  if (setup && (!ready || setup.state === 'setup')) return <SetupScreen status={setup} />

  if (!ready) {
    return (
      <div className="splash">
        <Logo size={44} />
        <div className="splash-name">Viku</div>
        <div className="splash-sub">{error ? `Could not start: ${error}` : (waitMsg ?? 'Sermon Reel Studio')}</div>
        {!error && <div className="splash-bar" />}
      </div>
    )
  }

  return (
    <div className="app">
      <TopBar />
      <EngineBanner />
      {mode === 'manual' ? (
        <div className="workspace">
          <div className="upper">
            <div className="pane" style={{ width: layout.left }}>
              <Browser />
            </div>
            <Splitter axis="x" value={layout.left} min={260} max={560} onChange={(v) => setLayout({ left: v })} />
            <div className="pane grow">
              <Viewer />
            </div>
            <Splitter axis="x" value={layout.right} min={270} max={520} invert onChange={(v) => setLayout({ right: v })} />
            <div className="pane" style={{ width: layout.right }}>
              <Inspector />
            </div>
          </div>
          <Splitter axis="y" value={layout.bottom} min={190} max={560} invert onChange={(v) => setLayout({ bottom: v })} />
          <div className="lower" style={{ height: layout.bottom }}>
            <Timeline />
          </div>
        </div>
      ) : (
        <AutomateView />
      )}
      <ActivityDrawer />
      <SettingsDialog />
      <ExportDialog />
      <ShortcutsSheet />
      <Onboarding />
      <AboutDialog />
      <Toasts />
    </div>
  )
}
