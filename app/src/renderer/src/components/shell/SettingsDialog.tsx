import { useEffect, useState } from 'react'
import { Check, Cpu, FolderOpen, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import type { Prefs } from '@shared/ipc'
import { api } from '@/api'
import type { ExportPreset, Settings } from '@/api/types'
import { toast, useApp } from '@/state/app'
import { Button, IconButton, Segmented, Tabs, Toggle } from '../ui'
import { Modal } from './Shell'

type Tab = 'general' | 'folders' | 'export' | 'engine'

function FolderRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="irow">
      <span className="irow-label">{label}</span>
      <span className="irow-ctl row gap">
        <input className="input grow" value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} onKeyDown={(e) => e.stopPropagation()} aria-label={label} />
        <IconButton
          icon={FolderOpen}
          label={`Browse for ${label}`}
          onClick={async () => {
            const p = await window.viku?.dialog.openFolder(label)
            if (p) onChange(p)
          }}
        />
      </span>
    </div>
  )
}

export function SettingsDialog() {
  const open = useApp((s) => s.settingsOpen)
  const set = useApp((s) => s.set)
  const settings = useApp((s) => s.settings)
  const health = useApp((s) => s.health)
  const engine = useApp((s) => s.engine)
  const apiKind = useApp((s) => s.apiKind)
  const [tab, setTab] = useState<Tab>('general')
  const [draft, setDraft] = useState<Settings | null>(null)
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [prefsDirty, setPrefsDirty] = useState(false)

  useEffect(() => {
    if (!open) return
    setDraft(settings ? structuredClone(settings) : null)
    void window.viku?.prefs.get().then((p) => setPrefs(p))
    setPrefsDirty(false)
  }, [open, settings])

  if (!open) return null
  const close = (): void => set({ settingsOpen: false })
  const patch = (p: Partial<Settings>): void => setDraft((d) => (d ? { ...d, ...p } : d))
  const patchPreset = (i: number, p: Partial<ExportPreset>): void => setDraft((d) => (d ? { ...d, export_presets: d.export_presets.map((x, k) => (k === i ? { ...x, ...p } : x)) } : d))
  const patchPrefs = (p: Partial<Prefs>): void => {
    setPrefs((x) => (x ? { ...x, ...p } : x))
    setPrefsDirty(true)
  }

  const save = async (): Promise<void> => {
    try {
      if (draft) {
        const saved = await api().saveSettings(draft)
        set({ settings: saved })
      }
      if (prefs && prefsDirty && window.viku) {
        const before = await window.viku.prefs.get()
        await window.viku.prefs.set(prefs)
        if (before.adapter !== prefs.adapter || before.engineUrl !== prefs.engineUrl) {
          toast('info', 'Data source changed — reloading')
          setTimeout(() => location.reload(), 600)
        }
      }
      toast('success', 'Settings saved')
      close()
    } catch (e) {
      toast('error', `Could not save settings: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const ready = health?.offline_ready
  const models: [string, boolean | undefined, string][] = [
    ['Speech recognition (IndicConformer / Whisper)', ready?.asr, 'asr'],
    ['Speech enhancement (DeepFilterNet3)', ready?.denoise, 'denoise'],
    ['Viku Brain embeddings (multilingual-e5-small)', ready?.embed, 'embed'],
    ['Offline Bibles (IRV ory · IRV hin2017 · WEB)', ready?.bible, 'bible'],
    ['Illustration library index', ready?.library, 'library']
  ]

  return (
    <Modal
      title="Settings"
      onClose={close}
      width={720}
      footer={
        <>
          <span className="grow" />
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <Tabs
        className="settings-tabs"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'general', label: 'General' },
          { id: 'folders', label: 'Folders' },
          { id: 'export', label: 'Export presets' },
          { id: 'engine', label: 'Engine & models' }
        ]}
      />
      {!draft && tab !== 'engine' ? (
        <div className="muted pad">Settings are unavailable until the engine answers.</div>
      ) : (
        <div className="settings-body">
          {tab === 'general' && draft && (
            <>
              <div className="irow">
                <span className="irow-label">Church name</span>
                <span className="irow-ctl">
                  <input className="input" value={draft.church_name} onChange={(e) => patch({ church_name: e.target.value })} onKeyDown={(e) => e.stopPropagation()} aria-label="Church name" />
                </span>
              </div>
              <div className="irow">
                <span className="irow-label">Credit line</span>
                <span className="irow-ctl">
                  <input className="input" value={draft.credit_line} onChange={(e) => patch({ credit_line: e.target.value })} onKeyDown={(e) => e.stopPropagation()} aria-label="Credit line" />
                </span>
              </div>
              <div className="irow">
                <span className="irow-label">Default language</span>
                <span className="irow-ctl">
                  <Segmented
                    size="sm"
                    ariaLabel="Default language"
                    value={draft.default_language}
                    onChange={(v) => patch({ default_language: v })}
                    options={[
                      { id: 'or', label: 'ଓଡ଼ିଆ' },
                      { id: 'hi', label: 'हिन्दी' },
                      { id: 'en', label: 'English' },
                      { id: 'auto', label: 'Auto' }
                    ]}
                  />
                </span>
              </div>
              <p className="rule-note small">The credit line is drawn at the bottom of every reel.</p>
            </>
          )}
          {tab === 'folders' && draft && (
            <>
              <FolderRow label="Data folder" value={draft.data_dir} onChange={(v) => patch({ data_dir: v })} />
              <FolderRow label="Projects" value={draft.projects_dir} onChange={(v) => patch({ projects_dir: v })} />
              <FolderRow label="Illustrations" value={draft.library_dir} onChange={(v) => patch({ library_dir: v })} />
              <FolderRow label="Music" value={draft.music_dir} onChange={(v) => patch({ music_dir: v })} />
              <FolderRow label="Exports" value={draft.exports_dir} onChange={(v) => patch({ exports_dir: v })} />
              {prefs && <FolderRow label="AI Studio captures" value={prefs.capturesDir} onChange={(v) => patchPrefs({ capturesDir: v })} />}
            </>
          )}
          {tab === 'export' && draft && (
            <div className="presets">
              <div className="preset-row head small muted">
                <span>Name</span>
                <span>Width</span>
                <span>Height</span>
                <span>FPS</span>
                <span>Max s</span>
                <span />
              </div>
              {draft.export_presets.map((p, i) => (
                <div key={i} className="preset-row">
                  <input className="input" value={p.name} onChange={(e) => patchPreset(i, { name: e.target.value })} onKeyDown={(e) => e.stopPropagation()} aria-label="Preset name" />
                  <input className="input num" type="number" value={p.width} onChange={(e) => patchPreset(i, { width: Number(e.target.value) })} aria-label="Width" />
                  <input className="input num" type="number" value={p.height} onChange={(e) => patchPreset(i, { height: Number(e.target.value) })} aria-label="Height" />
                  <input className="input num" type="number" value={p.fps} onChange={(e) => patchPreset(i, { fps: Number(e.target.value) })} aria-label="FPS" />
                  <input
                    className="input num"
                    type="number"
                    value={p.max_seconds ?? ''}
                    placeholder="—"
                    onChange={(e) => patchPreset(i, { max_seconds: e.target.value ? Number(e.target.value) : undefined })}
                    aria-label="Max seconds"
                  />
                  <IconButton icon={Trash2} label="Remove preset" onClick={() => patch({ export_presets: draft.export_presets.filter((_, k) => k !== i) })} />
                </div>
              ))}
              <Button
                size="sm"
                icon={Plus}
                onClick={() => patch({ export_presets: [...draft.export_presets, { id: `preset-${Date.now().toString(36)}`, name: 'New preset', width: 1080, height: 1920, fps: 30, max_seconds: 60 }] })}
              >
                Add preset
              </Button>
            </div>
          )}
          {tab === 'engine' && (
            <>
              <div className="engine-card">
                <Cpu size={18} aria-hidden />
                <div className="grow">
                  <div>
                    {apiKind === 'mock' ? 'Mock data' : 'Live engine'} · {apiKind === 'mock' && engine?.state === 'checking' ? 'engine not connected' : (engine?.state ?? 'unknown')}
                    {health && ` · v${health.version}`}
                  </div>
                  <div className="small muted">
                    {engine?.url ?? prefs?.engineUrl} · GPU: {health ? (typeof health.gpu === 'string' ? health.gpu : health.gpu ? 'yes' : 'CPU only') : '—'}
                  </div>
                </div>
                <Button
                  size="sm"
                  icon={RefreshCw}
                  onClick={async () => {
                    const s = await window.viku?.engine.restart()
                    if (s) useApp.getState().set({ engine: s })
                  }}
                >
                  Restart engine
                </Button>
              </div>
              <div className="models">
                {models.map(([label, ok, id]) => (
                  <div key={id} className="model-row">
                    <span className={`model-dot ${ok ? 'ok' : 'no'}`}>{ok ? <Check size={11} /> : <X size={11} />}</span>
                    <span className="grow">{label}</span>
                    <span className="small muted">{ok ? 'offline ready' : 'not installed'}</span>
                  </div>
                ))}
              </div>
              {prefs && (
                <>
                  <div className="irow">
                    <span className="irow-label">Data source</span>
                    <span className="irow-ctl">
                      <Segmented
                        size="sm"
                        ariaLabel="Data source"
                        value={prefs.adapter}
                        onChange={(v) => patchPrefs({ adapter: v })}
                        options={[
                          { id: 'auto', label: 'Auto' },
                          { id: 'live', label: 'Engine' },
                          { id: 'mock', label: 'Mock data' }
                        ]}
                      />
                    </span>
                  </div>
                  <div className="irow">
                    <span className="irow-label">Engine URL</span>
                    <span className="irow-ctl">
                      <input className="input" value={prefs.engineUrl} onChange={(e) => patchPrefs({ engineUrl: e.target.value })} onKeyDown={(e) => e.stopPropagation()} aria-label="Engine URL" />
                    </span>
                  </div>
                  <div className="irow">
                    <span className="irow-label">Start command</span>
                    <span className="irow-ctl">
                      <input className="input mono" value={prefs.engineCommand} onChange={(e) => patchPrefs({ engineCommand: e.target.value })} onKeyDown={(e) => e.stopPropagation()} aria-label="Engine command" />
                    </span>
                  </div>
                  <FolderRow label="Engine folder" value={prefs.engineCwd} onChange={(v) => patchPrefs({ engineCwd: v })} />
                  <div className="irow">
                    <span className="irow-label">Auto-start</span>
                    <span className="irow-ctl">
                      <Toggle checked={prefs.autoStartEngine} onChange={(v) => patchPrefs({ autoStartEngine: v })} label="Start the engine when Viku opens (and stop it on quit)" />
                    </span>
                  </div>
                </>
              )}
              {engine && engine.log.length > 0 && <pre className="engine-log">{engine.log.slice(-14).join('\n')}</pre>}
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
