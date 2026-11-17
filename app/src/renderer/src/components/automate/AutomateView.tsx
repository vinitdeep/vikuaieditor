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
import type { AutomateRequest, AutomateResultReel, Candidate, LangOpt, Project, Reel, Seg } from '@/api/types'
import { candidates as normCandidates, isRec, num, str } from '@/api/normalize'
import { toast, useApp } from '@/state/app'
import { useEditor } from '@/state/editor'
import { useJobs } from '@/state/jobs'
import { clock, duration, parseTime } from '@/lib/time'
import { reelDuration } from '@/lib/reel'
import { queueEmptyCutaways } from '@/lib/gemini'
import { Button, IconButton, LangBadge, Progress, Segmented, Toggle } from '../ui'
import { ThumbPreview } from '../ThumbPreview'
import { resultPath } from '../inspector/ReelPanel'

/** "Find clips" runs stop after the clip finder and show this many to choose from */
export const PICK_COUNT = 5

interface Picks {
  project_id: string
  items: Candidate[]
}

/** pick = find the best clips and choose which one becomes the reel · make = make N reels straight away */
export type AutoKind = 'pick' | 'make'

interface AutoState {
  kind: AutoKind
  form: AutomateRequest
  jobId: string | null
  /** run = make N reels in one go · pick = finding clips to choose from · build = making the picked clip */
  phase: 'run' | 'pick' | 'build'
  picks: Picks | null
  /** candidate id -> reel id it became */
  built: Record<string, string>
  /** candidate ids being made right now (one job, made one after another) */
  building: string[]
  /** candidate ids the editor ticked to make together */
  marked: string[]
  results: AutomateResultReel[]
  reels: Record<string, Reel>
  projects: Record<string, Project>
  setForm: (p: Partial<AutomateRequest>) => void
  set: (p: Partial<AutoState>) => void
}

export const useAuto = create<AutoState>((set, get) => ({
  kind: 'pick',
  form: { video_path: '', language: 'auto', count: 3, max_seconds: 60, illustrations: 'ai', music: 'library', thumbnails: true, framing: 'follow' },
  jobId: null,
  phase: 'run',
  picks: null,
  built: {},
  building: [],
  marked: [],
  results: [],
  reels: {},
  projects: {},
  setForm: (p) => set({ form: { ...get().form, ...p } }),
  set: (p) => set(p)
}))

const AUTO_TABS = [
  { id: 'pick' as const, label: `Find ${PICK_COUNT} clips to choose from`, detail: 'See the best clips with title + length, preview, then make the one you pick', icon: Sparkles },
  { id: 'make' as const, label: 'Make reels', detail: 'Viku picks the best clips and makes the reels straight away', icon: Wand2 }
]

// The engine's /automate job scopes progress: analyze 0–0.45, suggest 0.45–0.5, then per reel build (40%) + render (60%).
const STAGES = [
  { id: 'analyze', label: 'Analyze', detail: 'Proxy · 16 kHz audio · pauses · shots · transcription', icon: ScanSearch, range: [0, 0.45] },
  { id: 'suggest', label: 'Find clips', detail: 'Viku Brain ranks windows, plans jump cuts', icon: Sparkles, range: [0.45, 0.5] },
  { id: 'build', label: 'Build reels', detail: 'Captions · verse cards · cutaways · music · SFX', icon: Clapperboard, range: [0.5, 1] },
  { id: 'render', label: 'Render & thumbnails', detail: 'Enhance speech · composite · −14 LUFS · H.264', icon: Hammer, range: [0.5, 1] }
] as const

const RENDER_RE = /render|encod|composit|thumbnail|loud|mix|enhanc|final/i

/** reel length label: "45 s", "1 min", "2 min 30 s" */
function capLabel(sec: number): string {
  if (sec < 60) return `${sec} s`
  const m = Math.floor(sec / 60)
  const r = sec % 60
  return r ? `${m} min ${r} s` : `${m} min`
}

function stageOf(message: string, progress: number, phase: AutoState['phase']): number {
  if (phase === 'build') return RENDER_RE.test(message) ? 3 : 2
  if (phase === 'pick') return progress < 0.9 ? 0 : 1
  if (progress < 0.45) return 0
  if (progress < 0.5) return 1
  return RENDER_RE.test(message) ? 3 : 2
}

/** progress range of stage i in the current job (pick: analyse 0–0.9, find 0.9–1; build: build + render 0–1) */
function rangeOf(i: number, phase: AutoState['phase']): readonly [number, number] {
  if (phase === 'pick') return i === 0 ? [0, 0.9] : [0.9, 1]
  if (phase === 'build') return [0, 1]
  return STAGES[i].range
}

/** engine pick result: {project, stage: "pick", suggestions: [...]} */
function parsePicks(result: unknown): Picks | null {
  if (!isRec(result) || result.stage !== 'pick' || !Array.isArray(result.suggestions)) return null
  return { project_id: str(result.project_id ?? result.project), items: normCandidates(result.suggestions) }
}

function segTotal(segs: Seg[]): number {
  return segs.reduce((a, [s, e]) => a + e - s, 0)
}

/** the proxy that holds source second t, with the source second it starts at */
function proxyFor(project: Project | null | undefined, t: number): { path: string; offset: number } | null {
  if (!project) return null
  const pr = project.proxies?.find((x) => x.start <= t + 0.01 && t < x.end)
  if (pr) return { path: pr.path, offset: pr.start }
  return project.proxy ? { path: project.proxy, offset: project.proxy_offset ?? 0 } : null
}

/** plays a clip's jump-cut segments from the 540p proxy, skipping the parts the reel leaves out */
function ClipPreview({ project, segments, onEnd }: { project: Project | null; segments: Seg[]; onEnd: () => void }) {
  const k = useRef(0)
  const src = segments.length ? proxyFor(project, segments[0][0]) : null
  if (!src) return <div className="pick-noprev small muted">Preview needs the analysed proxy</div>
  return (
    <video
      className="pick-video"
      src={api().mediaUrl(src.path)}
      autoPlay
      playsInline
      onLoadedMetadata={(e) => {
        k.current = 0
        e.currentTarget.currentTime = Math.max(0, segments[0][0] - src.offset)
      }}
      onTimeUpdate={(e) => {
        const v = e.currentTarget
        const seg = segments[k.current]
        if (!seg || v.currentTime + src.offset < seg[1] - 0.02) return
        k.current += 1
        if (k.current >= segments.length) {
          v.pause()
          onEnd()
        } else v.currentTime = Math.max(0, segments[k.current][0] - src.offset)
      }}
      onError={() => {
        toast('warn', 'Could not play the preview')
        onEnd()
      }}
    />
  )
}

interface PickCardProps {
  c: Candidate
  rank: number
  project: Project | null
  previewing: boolean
  onPreview: (on: boolean) => void
  building: boolean
  locked: boolean
  made: boolean
  marked: boolean
  onMark: () => void
  onChoose: () => void
  onOpen: () => void
}

function PickCard({ c, rank, project, previewing, onPreview, building, locked, made, marked, onMark, onChoose, onOpen }: PickCardProps) {
  const secs = c.duration ?? segTotal(c.segments)
  const pct = scorePct(c.score) ?? 0
  const start = c.window?.[0] ?? c.segments[0]?.[0] ?? 0
  return (
    <article className={`ccard pick${made ? ' kept' : ''}${building ? ' is-building' : ''}${marked ? ' marked' : ''}`}>
      <header>
        {!made && !building && (
          <button
            type="button"
            role="checkbox"
            aria-checked={marked}
            aria-label={`Select clip ${rank} to make`}
            className={`pick-mark${marked ? ' on' : ''}`}
            onClick={onMark}
            disabled={locked}
            title={marked ? 'Selected for the build — click to unselect' : 'Select this clip to make it with the others'}
          >
            {marked && <Check size={12} strokeWidth={3} aria-hidden />}
          </button>
        )}
        <span className="ccard-rank num">#{rank}</span>
        <span className={`ccard-title lang-${c.language}`} title={c.title}>
          {c.title || `Clip ${rank}`}
        </span>
        <LangBadge lang={c.language} />
      </header>
      <div className="pick-len">
        <span className="pick-dur num">{capLabel(Math.round(secs))}</span>
        <span className="small muted num">
          from {clock(start)} · {c.segments.length} cut{c.segments.length > 1 ? 's' : ''}
        </span>
      </div>
      {c.short_of_target && (
        <div className="pick-short small" title="Not enough speech around this clip to reach the length you chose">
          <CircleAlert size={12} aria-hidden /> Shorter than the {capLabel(c.target_seconds ?? 60)} you asked for
        </div>
      )}
      <div className="score">
        <span className="score-bar" aria-label={`Score ${pct}`}>
          <span style={{ width: `${pct}%` }} className={pct >= 80 ? 'hi' : pct >= 60 ? 'mid' : 'lo'} />
        </span>
        <span className="num score-val">{pct}</span>
      </div>
      {c.reasons.length > 0 && (
        <div className="reasons">
          {c.reasons.slice(0, 3).map((r) => (
            <span key={r} className="reason">
              {r}
            </span>
          ))}
        </div>
      )}
      {previewing && <ClipPreview project={project} segments={c.segments} onEnd={() => onPreview(false)} />}
      <footer>
        <IconButton icon={previewing ? Square : Play} label={previewing ? 'Stop preview' : 'Preview this clip'} onClick={() => onPreview(!previewing)} />
        <span className="grow" />
        {made ? (
          <Button size="sm" variant="ghost" icon={Check} onClick={onOpen}>
            Made · open
          </Button>
        ) : building ? (
          <span className="pick-busy small">
            <Loader2 size={12} className="spin" aria-hidden /> Making…
          </span>
        ) : (
          <Button size="sm" variant="primary" icon={Wand2} onClick={onChoose} disabled={locked}>
            Make this reel
          </Button>
        )}
      </footer>
    </article>
  )
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
  const { kind, form, setForm, jobId, phase, picks, built, building, marked, results, reels, projects: autoProjects, set } = useAuto()
  const job = useJobs((s) => (jobId ? s.jobs[jobId] : undefined))
  const projects = useEditor((s) => s.projects)
  const settings = useApp((s) => s.settings)
  const running = job && (job.state === 'running' || job.state === 'queued')
  const stage = job ? stageOf(job.message, job.progress, phase) : -1
  const [playing, setPlaying] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState<string | null>(null)
  const choosing = kind === 'pick'
  // clips that can still be ticked (not made, not being made), and the ticked ones in rank order
  const pickable = (picks?.items ?? []).filter((c) => !(c.id in built) && !building.includes(c.id))
  const markedItems = pickable.filter((c) => marked.includes(c.id))
  const allMarked = pickable.length > 0 && markedItems.length === pickable.length
  const waitingForPick = phase === 'pick' && job?.state === 'done' && Boolean(picks?.items.length)
  const picksRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (picks?.items.length) picksRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [picks])
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

  // optional "Sermon part": from / to as 2:10:50, 130:50 or seconds
  const [partFrom, setPartFrom] = useState(form.range ? clock(form.range[0]) : '')
  const [partTo, setPartTo] = useState(form.range ? clock(form.range[1]) : '')
  const fromS = partFrom.trim() ? parseTime(partFrom) : null
  const toS = partTo.trim() ? parseTime(partTo) : null
  const partBad = (partFrom.trim() !== '' && fromS === null) || (partTo.trim() !== '' && toS === null) || (fromS !== null && toS !== null && toS - fromS < 20)
  const sameVideo = projects.find((p) => p.video_path && p.video_path === form.video_path)

  const pick = async (): Promise<void> => {
    const files = (await window.viku?.dialog.openFile({ title: 'Choose a sermon video', filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'm4v', 'webm'] }] })) ?? []
    if (files[0]) setForm({ video_path: files[0] })
  }

  /** load the projects (and their reels) behind these ids into the result-card maps, keeping what is there */
  const loadProjects = async (pids: string[]): Promise<void> => {
    const map: Record<string, Reel> = { ...useAuto.getState().reels }
    const pmap: Record<string, Project> = { ...useAuto.getState().projects }
    for (const pid of [...new Set(pids.filter(Boolean))]) {
      try {
        const p = await api().getProject(pid)
        pmap[pid] = p
        for (const r of p.reels) map[r.id] = r
      } catch {
        /* thumbnails fall back to titles, previews say so */
      }
    }
    set({ reels: map, projects: pmap })
  }

  /** Illustrations = New AI: the engine paints the pictures while it builds (Settings -> AI pictures); any cutaway it
   *  could not fill (no service set up, quota, offline) is queued in AI Studio instead. */
  const askForAiImages = async (res: AutomateResultReel[]): Promise<void> => {
    if (useAuto.getState().form.illustrations !== 'ai') return
    const all = useAuto.getState().reels
    const made = res.map((r) => all[r.reel_id]).filter((r): r is Reel => Boolean(r))
    await queueEmptyCutaways(made)
  }

  const run = async (): Promise<void> => {
    if (!form.video_path) return toast('warn', 'Choose a sermon video first')
    if (partBad) return toast('warn', 'Sermon part: use times like 2:10:50 or seconds, at least 20 s apart')
    const body: AutomateRequest = { ...form }
    delete body.range
    delete body.project_id
    delete body.pick
    if (fromS !== null || toS !== null) body.range = [fromS ?? 0, toS ?? 1e9]
    // the same video was analysed before: continue in its project (keeps the transcript and earlier reels)
    if (sameVideo) body.project_id = sameVideo.id
    // "Find clips" tab: find the best clips first and let the editor choose which one becomes the reel
    if (choosing) body.pick = PICK_COUNT
    setForm({ range: body.range })
    try {
      const ref = await api().automate(body)
      set({ jobId: ref.job, phase: choosing ? 'pick' : 'run', picks: null, built: {}, building: [], marked: [], results: [], reels: {} })
      setPreviewing(null)
      useJobs.getState().track(ref, `Automate · ${form.video_path.split(/[\\/]/).pop()}`, {
        onDone: async (ev) => {
          const found = parsePicks(ev.result)
          if (found) {
            set({ picks: found })
            await loadProjects([found.project_id])
            void useEditor.getState().loadProjects()
            if (found.items.length) toast('success', `${found.items.length} clips found — choose the one to make`)
            else toast('warn', 'No clips found in this part — try a longer sermon part')
            return
          }
          const res = parseResults(ev.result)
          set({ results: res })
          await loadProjects(res.map((r) => r.project_id))
          void useEditor.getState().loadProjects()
          toast('success', `${res.length} reel${res.length === 1 ? '' : 's'} ready`)
          await askForAiImages(res)
        }
      })
    } catch (e) {
      toast('error', `Automate failed to start: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** make one clip, or every clip the editor ticked — one engine job, reels made one after another */
  const make = async (list: Candidate[]): Promise<void> => {
    if (!picks || !list.length) return
    setPreviewing(null)
    const ids = list.map((c) => c.id)
    try {
      const ref = await api().automateBuild(picks.project_id, list.length === 1 ? list[0] : list, {
        framing: form.framing ?? 'follow',
        illustrations: form.illustrations
      })
      set({ jobId: ref.job, phase: 'build', building: ids })
      const done = (): void => set({ building: [] })
      const label = list.length === 1 ? list[0].title || 'picked clip' : `${list.length} picked clips`
      useJobs.getState().track(ref, `Automate · ${label}`, {
        onDone: async (ev) => {
          const res = parseResults(ev.result)
          const raw = isRec(ev.result) && Array.isArray(ev.result.reels) ? ev.result.reels : []
          const cur = useAuto.getState()
          const madeNow: Record<string, string> = {}
          res.forEach((r, i) => {
            const it: unknown = raw[i]
            const from = isRec(it) ? str(it.suggestion) : ''
            madeNow[from || ids[i] || r.reel_id] = r.reel_id
          })
          set({
            results: [...res, ...cur.results],
            built: { ...cur.built, ...madeNow },
            building: [],
            marked: cur.marked.filter((m) => !(m in madeNow))
          })
          await loadProjects(res.map((r) => r.project_id))
          void useEditor.getState().loadProjects()
          toast('success', res.length === 1 ? 'Your reel is ready' : `${res.length} reels ready`)
          await askForAiImages(res)
        },
        onError: done,
        onCancel: done
      })
    } catch (e) {
      toast('error', `Could not start this reel: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const openBuilt = async (c: Candidate): Promise<void> => {
    if (!picks) return
    await useEditor.getState().openProject(picks.project_id, built[c.id] || undefined)
    useApp.getState().set({ mode: 'manual' })
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
                {fileName || 'Last run'} · {form.language === 'auto' ? 'auto language' : form.language.toUpperCase()} · ≈ {capLabel(form.max_seconds)} reels
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
            <div className="auto-tabs" role="tablist" aria-label="What Automate makes">
              {AUTO_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={kind === t.id}
                  className={`auto-tab${kind === t.id ? ' on' : ''}`}
                  disabled={Boolean(running)}
                  onClick={() => set({ kind: t.id })}
                >
                  <t.icon size={16} aria-hidden />
                  <span>
                    <b>{t.id === 'make' ? `Make ${form.count} reel${form.count === 1 ? '' : 's'}` : t.label}</b>
                    <span className="small muted">{t.detail}</span>
                  </span>
                </button>
              ))}
            </div>
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
                {!choosing && (
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
                )}
                <div className="auto-row">
                  <span className="muted" title="Each reel lands between 90 % and 100 % of this length (after jump cuts), unless the sermon part is too short">Reel length</span>
                  <input
                    type="range"
                    min={10}
                    max={300}
                    step={form.max_seconds < 60 ? 5 : 15}
                    value={form.max_seconds}
                    aria-label="Reel length"
                    className="range-plain"
                    onChange={(e) => setForm({ max_seconds: Number(e.target.value) })}
                  />
                  <span className="num cap-val">≈ {capLabel(form.max_seconds)}</span>
                </div>
                <div className="auto-row part-row">
                  <span className="muted">Sermon part</span>
                  <input
                    className={`input part-in${partFrom.trim() && fromS === null ? ' bad' : ''}`}
                    value={partFrom}
                    placeholder="from (start)"
                    aria-label="Sermon part from"
                    onChange={(e) => setPartFrom(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    spellCheck={false}
                  />
                  <span className="part-dash" aria-hidden>
                    –
                  </span>
                  <input
                    className={`input part-in${partTo.trim() && toS === null ? ' bad' : ''}`}
                    value={partTo}
                    placeholder="to (end)"
                    aria-label="Sermon part to"
                    onChange={(e) => setPartTo(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    spellCheck={false}
                  />
                </div>
                <div className="part-hint muted small">
                  {partBad
                    ? 'Use times like 2:10:50 (h:mm:ss), 45:30 or seconds — at least 20 s apart.'
                    : fromS !== null || toS !== null
                      ? `Only ${fromS !== null ? clock(fromS) : 'the start'} – ${toS !== null ? clock(toS) : 'the end'} is listened to — faster for long sermons.`
                      : 'Optional: leave empty for the whole sermon.'}
                  {sameVideo && ` Continues in “${sameVideo.name}” (already analysed parts are reused).`}
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
                      { id: 'ai', label: 'New AI' },
                      { id: 'library', label: 'Library' },
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
                  <Toggle
                    checked={(form.framing ?? 'follow') === 'follow'}
                    onChange={(v) => setForm({ framing: v ? 'follow' : 'fixed' })}
                    label="Auto framing — keep the speaker centred"
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
                <Button variant="primary" className="run-btn" icon={choosing ? Sparkles : Wand2} onClick={() => void run()} disabled={!form.video_path}>
                  {choosing ? `Find ${PICK_COUNT} clips to choose from` : `Make ${form.count} reel${form.count === 1 ? '' : 's'}`}
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
                const st = !job
                  ? 'idle'
                  : phase === 'build' && i < 2
                    ? 'done' // the clips were found by the earlier pick run
                    : phase === 'pick' && i >= 2
                      ? 'idle' // nothing is built until the editor picks a clip
                      : job.state === 'done'
                        ? 'done'
                        : current
                          ? job.state === 'error'
                            ? 'error'
                            : job.state === 'cancelled'
                              ? 'idle'
                              : 'active'
                          : i < stage
                            ? 'done'
                            : 'idle'
                const [r0, r1] = rangeOf(i, phase)
                const local = st === 'active' && job ? Math.max(0, Math.min(1, (job.progress - r0) / (r1 - r0))) : st === 'done' ? 1 : 0
                const detail = st === 'active' && job ? job.message : i === 2 && waitingForPick ? 'Waiting for you — choose a clip below' : s.detail
                return (
                  <li key={s.id} className={`pstage st-${st}${i === 2 && waitingForPick ? ' st-waiting' : ''}`}>
                    <span className="stage-icon">
                      {st === 'done' ? <Check size={14} aria-hidden /> : st === 'active' ? <Loader2 size={14} className="spin" aria-hidden /> : <s.icon size={14} aria-hidden />}
                    </span>
                    <div className="stage-body">
                      <div className="stage-title">
                        <span>{s.label}</span>
                        {st === 'active' && <span className="num muted">{Math.round(local * 100)}%</span>}
                      </div>
                      <div className="stage-detail small">{detail}</div>
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
                <span>Every reel ends on an encouraging line, lands at about {capLabel(form.max_seconds)} and follows your house style.</span>
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

        {picks && picks.items.length > 0 && (
          <section className="results picks" aria-label="Choose a clip" ref={picksRef}>
            <div className="results-head">
              <div>
                <h2>{Object.keys(built).length ? 'More clips from this sermon' : 'Choose your reel'}</h2>
                <span className="muted small">
                  The {picks.items.length} best clips at about {capLabel(form.max_seconds)} · press play to hear one · tick the ones you want and make them together
                </span>
              </div>
              <div className="pick-bar">
                {pickable.length > 0 && (
                  <Button size="sm" variant="ghost" disabled={Boolean(running)} onClick={() => set({ marked: allMarked ? [] : pickable.map((c) => c.id) })}>
                    {allMarked ? 'Clear' : 'Select all'}
                  </Button>
                )}
                <Button
                  variant="primary"
                  icon={Wand2}
                  className="pick-make"
                  disabled={Boolean(running) || markedItems.length === 0}
                  onClick={() => void make(markedItems)}
                  title={markedItems.length ? undefined : 'Tick the clips you want, then make them all at once'}
                >
                  {markedItems.length ? `Make ${markedItems.length} selected reel${markedItems.length === 1 ? '' : 's'}` : 'Make selected reels'}
                </Button>
              </div>
            </div>
            <div className="pgrid">
              {picks.items.map((c, i) => (
                <PickCard
                  key={c.id}
                  c={c}
                  rank={i + 1}
                  project={autoProjects[picks.project_id] ?? null}
                  previewing={previewing === c.id}
                  onPreview={(on) => setPreviewing(on ? c.id : null)}
                  building={building.includes(c.id)}
                  locked={Boolean(running)}
                  made={c.id in built}
                  marked={marked.includes(c.id)}
                  onMark={() => set({ marked: marked.includes(c.id) ? marked.filter((m) => m !== c.id) : [...marked, c.id] })}
                  onChoose={() => void make([c])}
                  onOpen={() => void openBuilt(c)}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
