import { useState } from 'react'
import { Film, FilePlus2, Loader2, Play, RefreshCw, ScanSearch } from 'lucide-react'
import { api } from '@/api'
import type { LangOpt } from '@/api/types'
import { toast, useApp } from '@/state/app'
import { useEditor } from '@/state/editor'
import { useJobs } from '@/state/jobs'
import { duration } from '@/lib/time'
import { reelDuration } from '@/lib/reel'
import { Button, Empty, IconButton, LangBadge, Progress, Segmented, SkeletonRows } from '../ui'

export async function importSermon(language: LangOpt): Promise<void> {
  const files = (await window.viku?.dialog.openFile({ title: 'Choose a sermon video', filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'm4v', 'webm', 'avi'] }] })) ?? []
  const path = files[0]
  if (!path) return
  const name = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? 'Sermon'
  try {
    const p = await api().createProject({ name, video_path: path, language })
    await useEditor.getState().loadProjects()
    await useEditor.getState().openProject(p.id, null)
    const ref = await api().analyze(p.id)
    useJobs.getState().track(ref, `Analyze · ${name}`, {
      onDone: () => {
        toast('success', `${name} analysed — transcript ready`)
        void useEditor.getState().openProject(p.id, null)
        useApp.getState().set({ browserTab: 'transcript' })
      }
    })
  } catch (e) {
    toast('error', `Import failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function MediaTab() {
  const projects = useEditor((s) => s.projects)
  const loading = useEditor((s) => s.projectsLoading)
  const current = useEditor((s) => s.project)
  const reelId = useEditor((s) => s.reelId)
  const openProject = useEditor((s) => s.openProject)
  const openReel = useEditor((s) => s.openReel)
  const jobs = useJobs((s) => s.jobs)
  const settings = useApp((s) => s.settings)
  const [lang, setLang] = useState<LangOpt>(settings?.default_language ?? 'auto')

  const analyzing = Object.values(jobs).find((j) => j.kind === 'analyze' && (j.state === 'running' || j.state === 'queued'))

  return (
    <div className="media-tab">
      <div className="ptool">
        <Segmented
          size="sm"
          ariaLabel="Language for new import"
          value={lang}
          onChange={setLang}
          options={[
            { id: 'or', label: 'ଓଡ଼ିଆ' },
            { id: 'hi', label: 'हिन्दी' },
            { id: 'en', label: 'EN' },
            { id: 'auto', label: 'Auto' }
          ]}
        />
        <span className="grow" />
        <IconButton icon={RefreshCw} label="Refresh" onClick={() => void useEditor.getState().loadProjects()} />
        <Button size="sm" variant="primary" icon={FilePlus2} onClick={() => void importSermon(lang)}>
          Import
        </Button>
      </div>

      {analyzing && (
        <div className="analyze-card">
          <div className="row">
            <Loader2 size={13} className="spin" aria-hidden />
            <span className="grow ellipsis">{analyzing.message || 'Analyzing…'}</span>
            <span className="num muted">{Math.round(analyzing.progress * 100)}%</span>
          </div>
          <Progress value={analyzing.progress} />
        </div>
      )}

      <div className="plist" role="list">
        {!projects.length && loading && <SkeletonRows rows={3} avatar label="Loading projects" />}
        {!projects.length && !loading && (
          <Empty
            icon={Film}
            title="No sermons yet"
            action={
              <Button size="sm" variant="primary" icon={FilePlus2} onClick={() => void importSermon(lang)}>
                Import a sermon
              </Button>
            }
          >
            Import a sermon video to start. Viku makes a proxy, transcribes it and finds reel-worthy moments.
          </Empty>
        )}
        {projects.map((p) => {
          const open = current?.id === p.id
          return (
            <div key={p.id} role="listitem" className={`pcard${open ? ' open' : ''}`}>
              <button type="button" className="pcard-main" onClick={() => void openProject(p.id)}>
                <span className="pcard-thumb" aria-hidden>
                  <Film size={16} />
                  <span className="pcard-dur num">{duration(p.duration)}</span>
                </span>
                <span className="pcard-info">
                  <span className={`pcard-name lang-${p.language}`}>{p.name}</span>
                  <span className="pcard-meta">
                    <LangBadge lang={p.language} />
                    <span>{p.reel_count} reels</span>
                    {!p.analyzed && <span className="warn-text">not analysed</span>}
                  </span>
                </span>
              </button>
              {open && current && (
                <div className="pcard-reels">
                  {current.reels.map((r) => (
                    <button key={r.id} type="button" className={`reel-row${r.id === reelId ? ' on' : ''}`} onClick={() => openReel(r.id)}>
                      <Play size={11} aria-hidden />
                      <span className={`grow ellipsis lang-${r.language}`}>{r.title || 'Untitled reel'}</span>
                      <span className={`status-pill st-${r.status}`}>{r.status}</span>
                      <span className="num muted">{duration(reelDuration(r))}</span>
                    </button>
                  ))}
                  {!current.reels.length && <div className="muted small pad">No reels yet — select lines in Transcript or keep a Suggestion.</div>}
                  {!p.analyzed && (
                    <Button
                      size="sm"
                      icon={ScanSearch}
                      onClick={async () => {
                        const ref = await api().analyze(p.id)
                        useJobs.getState().track(ref, `Analyze · ${p.name}`, { onDone: () => void openProject(p.id) })
                      }}
                    >
                      Analyze
                    </Button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
