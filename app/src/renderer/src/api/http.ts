import type { EngineRequest, EngineResponse, HttpMethod } from '@shared/ipc'
import { ApiError, type VikuApi } from './client'
import * as N from './normalize'
import type { Candidate, JobEvent, Lang, Project, Reel, Settings } from './types'

/** Requests go through the main process (no CORS); falls back to fetch when opened outside Electron. */
async function transport(base: string, req: EngineRequest): Promise<EngineResponse> {
  if (window.viku) return window.viku.engine.request(req)
  try {
    const res = await fetch(base + req.path, {
      method: req.method,
      headers: req.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined
    })
    const text = await res.text()
    let data: unknown = text
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      /* text body */
    }
    return { ok: res.ok, status: res.status, data, error: res.ok ? undefined : `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e instanceof Error ? e.message : String(e) }
  }
}

const q = (params: Record<string, string | number>): string =>
  '?' +
  Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')

export class HttpApi implements VikuApi {
  readonly kind = 'live' as const
  private candidateCache = new Map<string, Candidate[]>()
  private suggestJobs = new Map<string, string>() // job id -> project id
  private listeners = new Set<(ev: JobEvent) => void>()
  private unsub: (() => void) | null = null
  private es: EventSource | null = null
  /** per project: source width, and whether the engine stores crops in source pixels */
  private units = new Map<string, { width: number; px: boolean }>()

  constructor(private base: string) {}

  private async call(method: HttpMethod, path: string, body?: unknown, timeoutMs?: number): Promise<unknown> {
    const res = await transport(this.base, { method, path, body, timeoutMs })
    if (!res.ok) throw new ApiError(res.error ?? `HTTP ${res.status}`, res.status)
    return res.data
  }

  health = async () => N.health(await this.call('GET', '/health', undefined, 4000))
  getSettings = async () => N.settings(await this.call('GET', '/settings'))
  saveSettings = async (s: Settings) => N.settings(await this.call('POST', '/settings', N.settingsPatch(s)))

  listProjects = async () => {
    const d = await this.call('GET', '/projects')
    const list = Array.isArray(d) ? d : N.isRec(d) && Array.isArray(d.projects) ? d.projects : []
    return list.map(N.projectSummary)
  }
  // The engine keeps crop cx/cw in source pixels; the UI works in 0..1 of the source width.
  private cropsToUi(r: Reel, width: number, px: boolean): Reel {
    if (!px || width <= 0) return r
    return { ...r, crops: r.crops.map((c) => ({ ...c, cx: c.cx / width, cw: c.cw / width })) }
  }
  private cropsToEngine(r: Reel, width: number, px: boolean): Reel {
    if (!px || width <= 0) return r
    return { ...r, crops: r.crops.map((c) => ({ ...c, cx: Math.round(c.cx * width * 10) / 10, cw: Math.round(c.cw * width * 10) / 10 })) }
  }
  private adopt(p: Project): Project {
    const crops = p.reels.flatMap((r) => r.crops)
    const px = !crops.length || crops.some((c) => c.cx > 1.001 || c.cw > 1.001)
    this.units.set(p.id, { width: p.width, px })
    return { ...p, reels: p.reels.map((r) => this.cropsToUi(r, p.width, px)) }
  }

  getProject = async (id: string) => {
    const raw = await this.call('GET', `/projects/${encodeURIComponent(id)}`)
    const p = this.adopt(N.project(raw))
    if (N.isRec(raw)) {
      const sug = raw.suggestions ?? raw.candidates
      if (sug !== undefined) this.candidateCache.set(p.id, N.candidates(sug))
    }
    return p
  }
  createProject = async (body: { name: string; video_path: string; language: Lang | 'auto' }) => this.adopt(N.project(await this.call('POST', '/projects', body)))
  saveProject = async (p: Project) => {
    const u = this.units.get(p.id) ?? { width: p.width, px: true }
    const body = { ...p, reels: p.reels.map((r) => this.cropsToEngine(r, u.width, u.px)) }
    const d = await this.call('PUT', `/projects/${encodeURIComponent(p.id)}`, body)
    return N.isRec(d) && d.id ? this.adopt(N.project(d)) : p
  }
  analyze = async (id: string) => N.jobRef(await this.call('POST', `/projects/${encodeURIComponent(id)}/analyze`, {}), 'analyze')
  waveform = async (id: string, start: number, end: number, px: number) =>
    N.waveform(await this.call('GET', `/projects/${encodeURIComponent(id)}/waveform${q({ start: start.toFixed(3), end: end.toFixed(3), px: Math.max(1, Math.round(px)) })}`), start, end)

  suggest = async (id: string) => {
    const ref = N.jobRef(await this.call('POST', `/projects/${encodeURIComponent(id)}/suggest`, {}), 'suggest')
    this.suggestJobs.set(ref.job, id)
    return ref
  }
  candidates = async (id: string) => this.candidateCache.get(id) ?? []
  createReel = async (projectId: string, body: { segments: [number, number][]; title: string; sub: string }) => {
    const r = N.reel(await this.call('POST', `/projects/${encodeURIComponent(projectId)}/reels`, body))
    const u = this.units.get(projectId)
    return u ? this.cropsToUi(r, u.width, u.px) : r
  }
  attachCutawayImage = async (reelId: string, index: number, path: string) => {
    try {
      const d = await this.call('POST', `/reels/${encodeURIComponent(reelId)}/cutaways/${index}/image`, { path })
      return N.isRec(d) ? N.cutawayOf(d) : null
    } catch (e) {
      // older engines: no attach route -> the caller sets the image locally
      if (e instanceof ApiError && (e.status === 404 || e.status === 405) && /not found|method/i.test(e.message)) return null
      throw e
    }
  }
  autobuild = async (reelId: string) => N.jobRef(await this.call('POST', `/reels/${encodeURIComponent(reelId)}/autobuild`, {}), 'autobuild')
  render = async (reelId: string, preset?: string) => N.jobRef(await this.call('POST', `/reels/${encodeURIComponent(reelId)}/render`, preset ? { preset } : {}), 'render')
  thumbnail = async (reelId: string) => N.jobRef(await this.call('POST', `/reels/${encodeURIComponent(reelId)}/thumbnail`, {}), 'thumbnail')
  automate = async (body: Parameters<VikuApi['automate']>[0]) => N.jobRef(await this.call('POST', '/automate', body), 'automate')
  cancelJob = async (jobId: string) => {
    try {
      await this.call('POST', `/jobs/${encodeURIComponent(jobId)}/cancel`, {})
      return true
    } catch {
      return false
    }
  }

  jobStatus = async (jobId: string) => {
    try {
      return N.jobEvent(await this.call('GET', `/jobs/${encodeURIComponent(jobId)}`, undefined, 4000))
    } catch {
      return null
    }
  }

  captionsFix = async (text: string, lang: Lang) => N.captionFix(await this.call('POST', '/captions/fix', { text, lang }), text)
  feedback = async (f: Parameters<VikuApi['feedback']>[0]) => {
    await this.call('POST', '/feedback', f)
  }
  learn = async () => N.jobRef(await this.call('POST', '/learn', {}), 'learn')

  bibleSearch = async (query: string, lang: Lang) => N.bibleList(await this.call('GET', `/bible/search${q({ q: query, lang })}`), lang)
  bibleVerse = async (ref: string, lang: Lang) => {
    try {
      const v = N.bibleVerse(await this.call('GET', `/bible/verse${q({ ref, lang })}`), lang)
      return v.text ? v : null
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null
      throw e
    }
  }
  bibleDownload = async () => N.jobRef(await this.call('POST', '/bible/download', {}), 'bible_download')

  librarySearch = async (query: string, limit = 60) => N.libraryImages(await this.call('GET', `/library/search${q({ q: query, limit })}`))
  libraryImport = async (paths: string[], tags: string[]) => {
    const d = await this.call('POST', '/library/import', { paths, tags })
    try {
      return N.jobRef(d, 'library_import')
    } catch {
      return null
    }
  }
  listMusic = async () => N.musicList(await this.call('GET', '/music'))
  heygenMusic = async (intent: string) => N.jobRef(await this.call('POST', '/music/heygen', { intent }), 'heygen_music')
  listSfx = async () => {
    try {
      return N.sfxList(await this.call('GET', '/sfx'))
    } catch {
      return []
    }
  }

  authStatus = async () => N.authStatus(await this.call('GET', '/auth/status'))
  heygenLogin = async () => N.jobRef(await this.call('POST', '/auth/heygen/login', {}), 'heygen_login')

  mediaUrl = (path: string) => `${this.base}/media?path=${encodeURIComponent(path)}`
  // the engine's /media has no resize parameter: Electron's main process makes + caches the small JPEG
  thumbUrl = (path: string, width = 320) =>
    window.viku && /\.(png|jpe?g|webp|gif|bmp)$/i.test(path) ? `viku-thumb://img/?p=${encodeURIComponent(path)}&w=${Math.round(width)}` : this.mediaUrl(path)

  subscribe(cb: (ev: JobEvent) => void): () => void {
    this.listeners.add(cb)
    if (!this.unsub && !this.es) this.connect()
    return () => {
      this.listeners.delete(cb)
    }
  }

  private connect(): void {
    const handle = (raw: unknown): void => {
      const ev = N.jobEvent(raw)
      if (!ev) return
      const pid = this.suggestJobs.get(ev.job)
      if (pid && ev.state === 'done' && ev.result !== undefined) this.candidateCache.set(pid, N.candidates(ev.result))
      for (const l of this.listeners) l(ev)
    }
    if (window.viku) {
      this.unsub = window.viku.engine.onEvent(handle)
    } else {
      this.es = new EventSource(`${this.base}/events`)
      this.es.onmessage = (m) => {
        try {
          handle(JSON.parse(String(m.data)))
        } catch {
          /* ignore */
        }
      }
    }
  }
}
