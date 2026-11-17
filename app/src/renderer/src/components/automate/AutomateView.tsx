import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import {
  AudioWaveform,
  Check,
  CircleAlert,
  Clapperboard,
  Download,
  FileVideo,
  FolderOpen,
  Hammer,
  Images,
  Loader2,
  Music2,
  Play,
  RefreshCw,
  ScanSearch,
  Sparkles,
  Square,
  Wand2,
  X
} from 'lucide-react'
import { api } from '@/api'
import type { AutomateRequest, AutomateResultReel, LangOpt, Project, Reel } from '@/api/types'
import { isRec, num, str } from '@/api/normalize'
import { toast, useApp } from '@/state/app'
import { useEditor } from '@/state/editor'
import { useJobs } from '@/state/jobs'
import { duration } from '@/lib/time'
import { reelDuration } from '@/lib/reel'
import { Button, IconButton, LangBadge, Progress, Segmented, Toggle } from '../ui'
import { ThumbPreview } from '../ThumbPreview'
import { resultPath } from '../inspector/ReelPanel'

interface AutoState {
  form: AutomateRequest
  jobId: string | null
  results: AutomateResultReel[]
  reels: Record<string, Reel>
  projects: Record<string, Project>
  setForm: (p: Partial<AutomateRequest>) => void
  set: (p: Partial<AutoState>) => void
}

export const useAuto = create<AutoState>((set, get) => ({
  form: { video_path: '', language: 'auto', count: 3, max_seconds: 60, illustrations: 'library', music: 'library', thumbnails: true },
  jobId: null,
  results: [],
  reels: {},
  projects: {},
  setForm: (p) => set({ form: { ...get().form, ...p } }),
  set: (p) => set(p)
}))

// The engine's /automate job scopes progress: analyze 0–0.45, suggest 0.45–0.5, then per reel build (40%) + render (60%).
const STAGES = [
  { id: 'analyze', label: 'Analyze', detail: 'Proxy · 16 kHz audio · pauses · shots · transcription', icon: ScanSearch, range: [0, 0.45] },
  { id: 'suggest', label: 'Find clips', detail: 'Viku Brain ranks windows, plans jump cuts', icon: Sparkles, range: [0.45, 0.5] },
  { id: 'build', label: 'Build reels', detail: 'Captions · verse cards · cutaways · music · SFX', icon: Clapperboard, range: [0.5, 1] },
  { id: 'render', label: 'Render & thumbnails', detail: 'Enhance speech · composite · −14 LUFS · H.264', icon: Hammer, range: [0.5, 1] }
] as const

const RENDER_RE = /render|encod|composit|thumbnail|loud|mix|enhanc|final/i

function stageOf(message: string, progress: number): number {
  if (progress < 0.45) return 0
  if (progress < 0.5) return 1
  return RENDER_RE.test(message) ? 3 : 2
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

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

function took(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`
}

function scorePct(s: number | undefined): number | null {
  if (s === undefined || !Number.isFinite(s)) return null
  return Math.round(Math.max(0, Math.min(1, s > 1 ? s / 100 : s)) * 100)
}

function ResultCard({ r, index, reel, project, playing, onPlay }: { r: AutomateResultReel; index: number; reel?: Reel; project: Project | null; playing: boolean; onPlay: (on: boolean) => void }) {
  const [mediaRef, width] = useWidth<HTMLDivElement>()
  const apiKind = useApp((s) => s.apiKind)
  const [rendering, setRendering] = useState<string | null>(null)
  const job = useJobs((s) => (rendering ? s.jobs[rendering] : undefined))
  const [out, setOut] = useState<{ output?: string; thumbnail?: string }>({ output: r.output, thumbnail: r.thumbnail })
  const [thumbFailed, setThumbFailed] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const lang = reel?.language ?? 'or'
  const title = reel?.title || r.title || `Reel ${index + 1}`
  const pct = scorePct(r.score)
  const busy = job && (job.state === 'running' || job.state === 'queued')
  const useJpg = apiKind === 'live' && out.thumbnail && !thumbFailed

  const rerender = async (): Promise<void> => {
    if (!reel) return
    try {
      const ref = await api().render(reel.id)
      setRendering(ref.job)
      useJobs.getState().track(ref, `Re-render · ${title}`, {
        onDone: (ev) => {
          const o = resultPath(ev.result)
          const th = isRec(ev.result) && typeof ev.result.thumbnail === 'string' ? ev.result.thumbnail : undefined
          setOut((x) => ({ output: o ?? x.output, thumbnail: th ?? x.thumbnail }))
          setThumbFailed(false)
          toast('success', `Re-rendered ${title}`)
        }
      })
    } catch (e) {
      toast('error', `Re-render failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const openManual = async (): Promise<void> => {
    await useEditor.getState().openProject(r.project_id, r.reel_id)
    useApp.getState().set({ mode: 'manual' })
  }

  const exportReel = async (): Promise<void> => {
    await useEditor.getState().openProject(r.project_id, r.reel_id)
    useApp.getState().set({ exportOpen: true })
  }

  return (
    <article className={`rcard${playing ? ' is-playing' : ''}`}>
      <div className="rcard-media" ref={mediaRef}>
        {playing && out.output ? (
          <video
            ref={videoRef}
            className="rcard-video"
            src={api().mediaUrl(out.output)}
            autoPlay
            playsInline
            controls
            onEnded={() => onPlay(false)}
            onError={() => {
              toast('warn', 'Could not play this file — reveal it in Explorer instead')
              onPlay(false)
            }}
          />
        ) : (
          <>
            {useJpg ? (
              <img className="rcard-jpg" src={api().thumbUrl(out.thumbnail as string, 480)} alt="" onError={() => setThumbFailed(true)} draggable={false} />
            ) : width > 0 ? (
              <ThumbPreview
                width={width}
                project={project}
                reel={reel ?? { language: 'or', cutaways: [], thumbnail: { style: index % 2 ? 'verse-card' : 'bold-gold', pose_t: 0, title: r.title, sub: '', verse: '' } }}
              />
            ) : null}
            <span className="rcard-shade" aria-hidden />
            <span className="rcard-badges">
              <LangBadge lang={lang} />
              {pct !== null && (
                <span className={`rcard-score ${pct >= 80 ? 'hi' : pct >= 60 ? 'mid' : 'lo'}`} title="Viku Brain score">
                  <Sparkles size={10} aria-hidden />
                  {pct}
                </span>
              )}
            </span>
            {out.output && !busy && (
              <button type="button" className="rcard-play" aria-label={`Play ${title}`} onClick={() => onPlay(true)}>
                <Play size={20} fill="currentColor" aria-hidden />
              </button>
            )}
            <span className="rcard-dur num">{duration(r.duration || (reel ? reelDuration(reel) : 0))}</span>
            {busy && job && (
              <span className="rcard-busy">
                <Loader2 size={16} className="spin" aria-hidden />
                <span className="small">{job.message || 'Rendering…'}</span>
                <Progress value={job.progress} />
              </span>
            )}
          </>
        )}
      </div>
      <div className="rcard-body">
        <div className={`rcard-title lang-${lang}`} title={title}>
          {title}
        </div>
        <div className="rcard-meta small">
          <span>{duration(r.duration || (reel ? reelDuration(reel) : 0))}</span>
          {reel && <span>· {reel.cutaways.length} cutaways</span>}
          {reel && reel.cutaways.some((c) => !c.img) && (
            <span className="rcard-needs" title="Some cutaways still need an image">
              · {reel.cutaways.filter((c) => !c.img).length} need images
            </span>
          )}
        </div>
        <div className="rcard-actions">
          <Button size="sm" variant="primary" icon={Clapperboard} onClick={() => void openManual()} className="grow">
            Open in Manual
          </Button>
          <IconButton icon={playing ? Square : Play} label={playing ? 'Stop preview' : 'Play preview'} onClick={() => onPlay(!playing)} disabled={!out.output} />
          <IconButton icon={RefreshCw} label="Re-render" onClick={() => void rerender()} disabled={!reel || Boolean(busy)} />
          <IconButton icon={Download} label="Export…" onClick={() => void exportReel()} />
          <IconButton icon={FolderOpen} label="Reveal file in Explorer" onClick={() => out.output && void window.viku?.shell.reveal(out.output)} disabled={!out.output} />
        </div>
      </div>
    </article>
  )
}

export function AutomateView() {
  const { form, setForm, jobId, results, reels, projects: autoProjects, set } = useAuto()
  const job = useJobs((s) => (jobId ? s.jobs[jobId] : undefined))
  const projects = useEditor((s) => s.projects)
  const settings = useApp((s) => s.settings)
  const running = job && (job.state === 'running' || job.state === 'queued')
  const stage = job ? stageOf(job.message, job.progress) : -1
  const [playing, setPlaying] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [setupOpen, setSetupOpen] = useState(false)
  const shown = results.length
  // a finished run collapses the setup into a summary so the reels sit at the top
  const collapsed = shown > 0 && !running && !setupOpen
  useEffect(() => {
    if (shown) {
      setSetupOpen(false)
      scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [shown])

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
          const pmap: Record<string, Project> = {}
          for (const pid of pids) {
            try {
              const p = await api().getProject(pid)
              pmap[pid] = p
              for (const r of p.reels) map[r.id] = r
            } catch {
              /* thumbnails fall back to titles */
            }
          }
          set({ reels: map, projects: pmap })
          void useEditor.getState().loadProjects()
          toast('success', `${res.length} reels ready`)
        }
      })
    } catch (e) {
      toast('error', `Automate failed to start: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const fileName = form.video_path ? form.video_path.split(/[\\/]/).pop() : ''

  return (
    <div className="automate" ref={scrollRef}>
      <div className="auto-inner">
        <header className="auto-head">
          <span className="auto-mark" aria-hidden>
            <Wand2 size={18} />
          </span>
          <div>
            <h1>Automate</h1>
            <p>One sermon in, finished vertical reels out — captions, verse cards, illustrations, music and thumbnails.</p>
          </div>
        </header>

        {collapsed && (
          <section className="auto-summary" aria-label="Last run">
            <span className="as-check">
              <Check size={16} aria-hidden />
            </span>
            <div className="as-text">
              <b>
                {results.length} reel{results.length === 1 ? '' : 's'} ready
              </b>
              <span className="small muted ellipsis">
                {fileName || 'Last run'} · {form.language === 'auto' ? 'auto language' : form.language.toUpperCase()} · ≤ {form.max_seconds} s
                {job ? ` · finished in ${took(job.updatedAt - job.startedAt)}` : ''}
              </span>
            </div>
            <Button variant="ghost" icon={Wand2} onClick={() => setSetupOpen(true)}>
              New run
            </Button>
          </section>
        )}

        <div className="auto-grid" hidden={collapsed}>
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
                // build and render interleave per reel, so build stays active while reels render
                const current = i === stage || (i === 2 && stage === 3)
                const st = !job ? 'idle' : job.state === 'done' ? 'done' : current ? (job.state === 'error' ? 'error' : job.state === 'cancelled' ? 'idle' : 'active') : i < stage ? 'done' : 'idle'
                const local = st === 'active' && job ? Math.max(0, Math.min(1, (job.progress - s.range[0]) / (s.range[1] - s.range[0]))) : st === 'done' ? 1 : 0
                return (
                  <li key={s.id} className={`pstage st-${st}`}>
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
              <div>
                <h2>Your reels</h2>
                <span className="muted small">
                  {results.length} reel{results.length === 1 ? '' : 's'} · rendered at 1080×1920 · press play to preview
                </span>
              </div>
              {results[0]?.output && (
                <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => void window.viku?.shell.reveal(results[0].output as string)}>
                  Open exports folder
                </Button>
              )}
            </div>
            <div className="rgrid">
              {results.map((r, i) => (
                <ResultCard
                  key={r.reel_id || i}
                  r={r}
                  index={i}
                  reel={reels[r.reel_id]}
                  project={autoProjects[r.project_id] ?? null}
                  playing={playing === (r.reel_id || String(i))}
                  onPlay={(on) => setPlaying(on ? r.reel_id || String(i) : null)}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
