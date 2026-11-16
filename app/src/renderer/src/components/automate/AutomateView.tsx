import { useEffect } from 'react'
import { create } from 'zustand'
import {
  AudioWaveform,
  Check,
  CircleAlert,
  Clapperboard,
  FileVideo,
  FolderOpen,
  Hammer,
  Images,
  Loader2,
  Music2,
  RefreshCw,
  ScanSearch,
  Sparkles,
  Square,
  Wand2,
  X
} from 'lucide-react'
import { api } from '@/api'
import type { AutomateRequest, AutomateResultReel, LangOpt, Reel } from '@/api/types'
import { isRec, num, str } from '@/api/normalize'
import { toast, useApp } from '@/state/app'
import { useEditor } from '@/state/editor'
import { useJobs } from '@/state/jobs'
import { duration } from '@/lib/time'
import { Button, Progress, Segmented, Toggle } from '../ui'
import { ThumbPreview } from '../ThumbPreview'
import { renderReel } from '../inspector/ReelPanel'

interface AutoState {
  form: AutomateRequest
  jobId: string | null
  results: AutomateResultReel[]
  reels: Record<string, Reel>
  setForm: (p: Partial<AutomateRequest>) => void
  set: (p: Partial<AutoState>) => void
}

const useAuto = create<AutoState>((set, get) => ({
  form: { video_path: '', language: 'auto', count: 3, max_seconds: 60, illustrations: 'library', music: 'library', thumbnails: true },
  jobId: null,
  results: [],
  reels: {},
  setForm: (p) => set({ form: { ...get().form, ...p } }),
  set: (p) => set(p)
}))

const STAGES = [
  { id: 'analyze', label: 'Analyze', detail: 'Proxy · 16 kHz audio · pauses · shots · transcription', icon: ScanSearch, re: /analy|proxy|transcri|audio|pause|shot/i, range: [0, 0.45] },
  { id: 'suggest', label: 'Find clips', detail: 'Viku Brain ranks windows, plans jump cuts', icon: Sparkles, re: /suggest|rank|clip|jump/i, range: [0.45, 0.6] },
  { id: 'build', label: 'Build reels', detail: 'Captions · verse cards · cutaways · music · SFX', icon: Clapperboard, re: /build|caption|verse|cutaway|music|sfx/i, range: [0.6, 0.78] },
  { id: 'render', label: 'Render & thumbnails', detail: 'Enhance speech · composite · −14 LUFS · H.264', icon: Hammer, re: /render|encod|composit|thumbnail|loud/i, range: [0.78, 1] }
] as const

function stageOf(message: string, progress: number): number {
  const prefix = message.split(':')[0]
  const byMsg = STAGES.findIndex((s) => s.re.test(prefix))
  if (byMsg >= 0) return byMsg
  const byAny = STAGES.findIndex((s) => s.re.test(message))
  if (byAny >= 0) return byAny
  return Math.max(0, STAGES.findIndex((s) => progress >= s.range[0] && progress < s.range[1]))
}

function parseResults(result: unknown): AutomateResultReel[] {
  const list = isRec(result) && Array.isArray(result.reels) ? result.reels : Array.isArray(result) ? result : []
  // engine: {project, reels:[{reel, title, score, path, thumbnail, duration}]}
  const pid = isRec(result) ? str(result.project_id ?? result.project) : ''
  return list.map((x) => {
    const r = isRec(x) ? x : {}
    return {
      project_id: str(r.project_id ?? r.project, pid),
      reel_id: str(r.reel_id ?? r.reel ?? r.id),
      title: str(r.title),
      duration: num(r.duration),
      score: r.score === undefined ? undefined : num(r.score),
      output: r.output !== undefined ? str(r.output) : r.path !== undefined ? str(r.path) : undefined,
      thumbnail: r.thumbnail === undefined ? undefined : str(r.thumbnail)
    }
  })
}

export function AutomateView() {
  const { form, setForm, jobId, results, reels, set } = useAuto()
  const job = useJobs((s) => (jobId ? s.jobs[jobId] : undefined))
  const projects = useEditor((s) => s.projects)
  const settings = useApp((s) => s.settings)
  const running = job && (job.state === 'running' || job.state === 'queued')
  const stage = job ? stageOf(job.message, job.progress) : -1

  useEffect(() => {
    if (settings && form.language === 'auto' && settings.default_language !== 'auto') setForm({ language: settings.default_language })
  }, [settings]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (): Promise<void> => {
    const files = (await window.viku?.dialog.openFile({ title: 'Choose a sermon video', filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'm4v', 'webm'] }] })) ?? []
    if (files[0]) setForm({ video_path: files[0] })
  }

  const run = async (): Promise<void> => {
    if (!form.video_path) return toast('warn', 'Choose a sermon video first')
    try {
      const ref = await api().automate(form)
      set({ jobId: ref.job, results: [], reels: {} })
      useJobs.getState().track(ref, `Automate · ${form.video_path.split(/[\\/]/).pop()}`, {
        onDone: async (ev) => {
          const res = parseResults(ev.result)
          set({ results: res })
          const pids = [...new Set(res.map((r) => r.project_id).filter(Boolean))]
          const map: Record<string, Reel> = {}
          for (const pid of pids) {
            try {
              const p = await api().getProject(pid)
              for (const r of p.reels) map[r.id] = r
            } catch {
              /* thumbnails fall back to titles */
            }
          }
          set({ reels: map })
          void useEditor.getState().loadProjects()
          toast('success', `${res.length} reels ready`)
        }
      })
    } catch (e) {
      toast('error', `Automate failed to start: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const openInManual = async (r: AutomateResultReel): Promise<void> => {
    await useEditor.getState().openProject(r.project_id, r.reel_id)
    useApp.getState().set({ mode: 'manual' })
  }

  const fileName = form.video_path ? form.video_path.split(/[\\/]/).pop() : ''

  return (
    <div className="automate">
      <div className="auto-inner">
        <header className="auto-head">
          <div>
            <h1>Automate</h1>
            <p>One sermon in, finished vertical reels out — captions, verse cards, illustrations, music and thumbnails.</p>
          </div>
        </header>

        <div className="auto-grid">
          <section className="auto-card setup" aria-label="Setup">
            <div className="step">
              <span className="step-n">1</span>
              <div className="step-body">
                <h3>Sermon video</h3>
                <button type="button" className={`dropzone${form.video_path ? ' has' : ''}`} onClick={() => void pick()}>
                  <FileVideo size={20} aria-hidden />
                  {form.video_path ? (
                    <span className="dz-file">
                      <b className="ellipsis">{fileName}</b>
                      <span className="muted small ellipsis">{form.video_path}</span>
                    </span>
                  ) : (
                    <span>
                      <b>Choose a video…</b>
                      <span className="muted small"> MP4, MOV, MKV — any length</span>
                    </span>
                  )}
                </button>
                {projects.length > 0 && (
                  <div className="recent">
                    <span className="muted small">Recent:</span>
                    {projects.slice(0, 3).map((p) => (
                      <button key={p.id} type="button" className={`recent-chip lang-${p.language}`} onClick={() => setForm({ video_path: p.video_path })} title={p.video_path}>
                        {p.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="step">
              <span className="step-n">2</span>
              <div className="step-body">
                <h3>Language</h3>
                <Segmented
                  ariaLabel="Language"
                  value={form.language}
                  onChange={(v: LangOpt) => setForm({ language: v })}
                  options={[
                    { id: 'or', label: 'ଓଡ଼ିଆ Odia' },
                    { id: 'hi', label: 'हिन्दी Hindi' },
                    { id: 'en', label: 'English' },
                    { id: 'auto', label: 'Auto' }
                  ]}
                />
              </div>
            </div>

            <div className="step">
              <span className="step-n">3</span>
              <div className="step-body">
                <h3>Reels</h3>
                <div className="auto-row">
                  <span className="muted">How many</span>
                  <span className="stepper">
                    <button type="button" aria-label="Fewer reels" onClick={() => setForm({ count: Math.max(1, form.count - 1) })}>
                      −
                    </button>
                    <span className="num">{form.count}</span>
                    <button type="button" aria-label="More reels" onClick={() => setForm({ count: Math.min(12, form.count + 1) })}>
                      +
                    </button>
                  </span>
                </div>
                <div className="auto-row">
                  <span className="muted">Length cap</span>
                  <input
                    type="range"
                    min={15}
                    max={60}
                    step={5}
                    value={form.max_seconds}
                    aria-label="Maximum length"
                    className="range-plain"
                    onChange={(e) => setForm({ max_seconds: Number(e.target.value) })}
                  />
                  <span className="num cap-val">≤ {form.max_seconds} s</span>
                </div>
              </div>
            </div>

            <div className="step">
              <span className="step-n">4</span>
              <div className="step-body">
                <h3>Options</h3>
                <div className="auto-row">
                  <span className="opt-label">
                    <Images size={13} aria-hidden /> Illustrations
                  </span>
                  <Segmented
                    size="sm"
                    ariaLabel="Illustrations"
                    value={form.illustrations}
                    onChange={(v) => setForm({ illustrations: v })}
                    options={[
                      { id: 'library', label: 'Library' },
                      { id: 'gemini', label: 'Gemini' },
                      { id: 'none', label: 'None' }
                    ]}
                  />
                </div>
                <div className="auto-row">
                  <span className="opt-label">
                    <Music2 size={13} aria-hidden /> Music
                  </span>
                  <Segmented
                    size="sm"
                    ariaLabel="Music source"
                    value={form.music}
                    onChange={(v) => setForm({ music: v })}
                    options={[
                      { id: 'library', label: 'Library' },
                      { id: 'heygen', label: 'HeyGen' },
                      { id: 'none', label: 'None' }
                    ]}
                  />
                </div>
                <div className="auto-row">
                  <Toggle checked={form.thumbnails} onChange={(v) => setForm({ thumbnails: v })} label="Thumbnails for every reel" />
                </div>
                <div className="auto-row">
                  <Toggle checked disabled onChange={() => undefined} label="Speech enhancement (always on)" />
                </div>
              </div>
            </div>

            <div className="run-row">
              {running ? (
                <Button variant="danger" icon={Square} onClick={() => jobId && void useJobs.getState().cancel(jobId)}>
                  Cancel
                </Button>
              ) : (
                <Button variant="primary" className="run-btn" icon={Wand2} onClick={() => void run()} disabled={!form.video_path}>
                  Make {form.count} reel{form.count > 1 ? 's' : ''}
                </Button>
              )}
            </div>
          </section>

          <section className="auto-card pipeline" aria-label="Progress">
            <div className="pipe-head">
              <h3>Pipeline</h3>
              {job && (
                <span className={`pipe-state ps-${job.state}`}>
                  {job.state === 'running' && <Loader2 size={12} className="spin" aria-hidden />}
                  {job.state === 'done' && <Check size={12} aria-hidden />}
                  {job.state === 'error' && <CircleAlert size={12} aria-hidden />}
                  {job.state === 'cancelled' && <X size={12} aria-hidden />}
                  {job.state}
                </span>
              )}
            </div>
            <ol className="stages">
              {STAGES.map((s, i) => {
                const st = !job ? 'idle' : job.state === 'done' ? 'done' : i < stage ? 'done' : i === stage ? (job.state === 'error' ? 'error' : job.state === 'cancelled' ? 'idle' : 'active') : 'idle'
                const local = st === 'active' && job ? Math.max(0, Math.min(1, (job.progress - s.range[0]) / (s.range[1] - s.range[0]))) : st === 'done' ? 1 : 0
                return (
                  <li key={s.id} className={`stage st-${st}`}>
                    <span className="stage-icon">
                      {st === 'done' ? <Check size={14} aria-hidden /> : st === 'active' ? <Loader2 size={14} className="spin" aria-hidden /> : <s.icon size={14} aria-hidden />}
                    </span>
                    <div className="stage-body">
                      <div className="stage-title">
                        <span>{s.label}</span>
                        {st === 'active' && <span className="num muted">{Math.round(local * 100)}%</span>}
                      </div>
                      <div className="stage-detail small">{st === 'active' && job ? job.message : s.detail}</div>
                      {(st === 'active' || st === 'done') && <Progress value={local} tone={st === 'done' ? 'green' : 'gold'} />}
                    </div>
                  </li>
                )
              })}
            </ol>
            {job && (
              <div className="overall">
                <span className="small muted">Overall</span>
                <Progress value={job.progress} tone={job.state === 'error' ? 'red' : job.state === 'done' ? 'green' : 'gold'} />
                <span className="num small">{Math.round(job.progress * 100)}%</span>
              </div>
            )}
            {job?.state === 'error' && <div className="err-box">{job.message}</div>}
            {!job && (
              <div className="pipe-idle">
                <AudioWaveform size={18} aria-hidden />
                <span>Every reel ends on an encouraging line, stays under {form.max_seconds} s and follows your house style.</span>
              </div>
            )}
          </section>
        </div>

        {results.length > 0 && (
          <section className="results" aria-label="Results">
            <div className="results-head">
              <h2>Results</h2>
              <span className="muted">{results.length} reels</span>
            </div>
            <div className="rgrid">
              {results.map((r, i) => {
                const reel = reels[r.reel_id]
                return (
                  <article key={r.reel_id || i} className="rcard">
                    <div className="rcard-thumb">
                      <ThumbPreview
                        width={170}
                        reel={reel ?? { language: 'or', cutaways: [], thumbnail: { style: i % 2 ? 'verse-card' : 'bold-gold', pose_t: 0, title: r.title, sub: '', verse: '' } }}
                      />
                      <span className="rcard-dur num">{duration(r.duration)}</span>
                    </div>
                    <div className="rcard-body">
                      <div className={`rcard-title lang-${reel?.language ?? 'or'}`}>{reel?.title ?? r.title}</div>
                      {r.score !== undefined && (
                        <div className="score small">
                          <span className="score-bar">
                            <span style={{ width: `${Math.round(r.score * 100)}%` }} className={r.score >= 0.8 ? 'hi' : r.score >= 0.6 ? 'mid' : 'lo'} />
                          </span>
                          <span className="num">{Math.round(r.score * 100)}</span>
                        </div>
                      )}
                      <div className="rcard-actions">
                        <Button size="sm" variant="primary" icon={Clapperboard} onClick={() => void openInManual(r)}>
                          Open in Manual
                        </Button>
                        <Button size="sm" icon={RefreshCw} onClick={() => reel && void renderReel(reel)} disabled={!reel}>
                          Re-render
                        </Button>
                        <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => r.output && void window.viku?.shell.reveal(r.output)} disabled={!r.output}>
                          Export
                        </Button>
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
