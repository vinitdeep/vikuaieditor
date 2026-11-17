import { create } from 'zustand'
import type { JobEvent, JobRef } from '@/api/types'
import { api } from '@/api'
import { toast } from './app'

export interface Job extends JobEvent {
  label: string
  startedAt: number
  updatedAt: number
}

type Handler = (ev: JobEvent) => void

interface JobsState {
  jobs: Record<string, Job>
  order: string[]
  track: (ref: JobRef, label: string, handlers?: { onDone?: Handler; onError?: Handler; onEvent?: Handler; onCancel?: Handler }) => void
  ingest: (ev: JobEvent) => void
  cancel: (id: string) => Promise<void>
  clearFinished: () => void
}

const handlers = new Map<string, { onDone?: Handler; onError?: Handler; onEvent?: Handler; onCancel?: Handler }>()

const LABELS: Record<string, string> = {
  analyze: 'Analyze sermon',
  suggest: 'Find clips (Viku Brain)',
  autobuild: 'Auto-build reel',
  render: 'Render reel',
  thumbnail: 'Thumbnail',
  automate: 'Automate',
  learn: 'Learn from feedback',
  bible_download: 'Download Bibles (eBible)',
  library_import: 'Import illustrations',
  heygen_music: 'HeyGen music',
  heygen_login: 'HeyGen sign-in'
}

export const useJobs = create<JobsState>((set, get) => ({
  jobs: {},
  order: [],
  track: (ref, label, h) => {
    if (h) handlers.set(ref.job, h)
    const now = Date.now()
    const existing = get().jobs[ref.job]
    set({
      jobs: {
        ...get().jobs,
        [ref.job]: existing
          ? { ...existing, label }
          : { job: ref.job, kind: ref.kind, progress: 0, message: 'Queued', state: 'queued', label, startedAt: now, updatedAt: now }
      },
      order: get().order.includes(ref.job) ? get().order : [ref.job, ...get().order]
    })
    // a fast job can finish (or fail) before the caller had its id: replay the terminal event to the handlers
    if (existing && h && (existing.state === 'done' || existing.state === 'error' || existing.state === 'cancelled')) {
      handlers.delete(ref.job)
      if (existing.state === 'done') h.onDone?.(existing)
      else if (existing.state === 'cancelled') h.onCancel?.(existing)
      else if (h.onError) h.onError(existing)
    }
  },
  ingest: (ev) => {
    const prev = get().jobs[ev.job]
    const now = Date.now()
    const job: Job = {
      ...ev,
      label: prev?.label ?? LABELS[ev.kind] ?? ev.kind,
      startedAt: prev?.startedAt ?? now,
      updatedAt: now,
      result: ev.result ?? prev?.result
    }
    set({ jobs: { ...get().jobs, [ev.job]: job }, order: get().order.includes(ev.job) ? get().order : [ev.job, ...get().order] })
    const h = handlers.get(ev.job)
    h?.onEvent?.(ev)
    if (ev.state === 'done') {
      handlers.delete(ev.job)
      h?.onDone?.(ev)
    } else if (ev.state === 'error') {
      handlers.delete(ev.job)
      if (h?.onError) h.onError(ev)
      else toast('error', `${job.label} failed: ${ev.message}`)
    } else if (ev.state === 'cancelled') {
      handlers.delete(ev.job)
      h?.onCancel?.(ev)
    }
  },
  cancel: async (id) => {
    const ok = await api().cancelJob(id)
    if (!ok) toast('warn', 'This job cannot be cancelled')
  },
  clearFinished: () => {
    const keep = get().order.filter((id) => {
      const s = get().jobs[id]?.state
      return s === 'running' || s === 'queued'
    })
    const jobs: Record<string, Job> = {}
    for (const id of keep) jobs[id] = get().jobs[id]
    set({ jobs, order: keep })
  }
}))

// SSE is the primary channel; poll jobs that have been quiet for a while so a dropped stream never strands one.
function currentApi(): ReturnType<typeof api> | null {
  try {
    return api()
  } catch {
    return null
  }
}

setInterval(() => {
  const st = useJobs.getState()
  const a = currentApi()
  if (!a) return
  const now = Date.now()
  for (const id of st.order) {
    const j = st.jobs[id]
    if (!j || (j.state !== 'running' && j.state !== 'queued') || now - j.updatedAt < 4000) continue
    void a.jobStatus(id).then((ev) => {
      if (ev) useJobs.getState().ingest(ev)
    })
  }
}, 2500)

export const runningCount = (s: JobsState): number => s.order.filter((id) => s.jobs[id]?.state === 'running' || s.jobs[id]?.state === 'queued').length
