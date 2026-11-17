import type { VikuApi } from './client'
import * as M from './mockData'
import type {
  AutomateRequest,
  Candidate,
  CaptionFlag,
  JobEvent,
  JobRef,
  Lang,
  Project,
  Reel,
  Seg,
  Settings
} from './types'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const clone = <T,>(x: T): T => structuredClone(x)

interface Step {
  msg: string
  ms: number
}

/** Fully in-memory engine stand-in. Jobs tick through realistic stages and emit SSE-shaped events. */
export class MockApi implements VikuApi {
  readonly kind = 'mock' as const
  private projects: Project[] = M.mockProjects()
  private settings: Settings = clone(M.MOCK_SETTINGS)
  private listeners = new Set<(ev: JobEvent) => void>()
  private timers = new Map<string, boolean>()
  private seq = 1
  private auth = { gemini_web: false, heygen: false, ebible: 'missing' as 'missing' | 'downloaded' }
  private mediaBase: string

  constructor() {
    this.mediaBase = new URL('mock/', document.baseURI).href
  }

  private emit(ev: JobEvent): void {
    for (const l of this.listeners) l(ev)
  }

  private job(kind: string, steps: Step[], result?: () => unknown, fail?: string): JobRef {
    const id = `job-${kind}-${this.seq++}`
    this.timers.set(id, true)
    void (async () => {
      const total = steps.reduce((a, s) => a + s.ms, 0)
      let done = 0
      this.emit({ job: id, kind, progress: 0, message: steps[0]?.msg ?? kind, state: 'running' })
      for (const s of steps) {
        const ticks = Math.max(1, Math.round(s.ms / 250))
        for (let i = 0; i < ticks; i++) {
          await wait(s.ms / ticks)
          if (!this.timers.get(id)) {
            this.emit({ job: id, kind, progress: done / total, message: 'Cancelled', state: 'cancelled' })
            return
          }
          done += s.ms / ticks
          this.emit({ job: id, kind, progress: Math.min(0.999, done / total), message: s.msg, state: 'running' })
        }
      }
      this.timers.delete(id)
      if (fail) this.emit({ job: id, kind, progress: 1, message: fail, state: 'error' })
      else this.emit({ job: id, kind, progress: 1, message: 'Done', state: 'done', result: result?.() })
    })()
    return { job: id, kind }
  }

  private findReel(reelId: string): { p: Project; r: Reel } {
    for (const p of this.projects) {
      const r = p.reels.find((x) => x.id === reelId)
      if (r) return { p, r }
    }
    throw new Error(`reel ${reelId} not found`)
  }

  async health() {
    await wait(60)
    return {
      ok: true,
      version: '0.1.0-mock',
      gpu: 'NVIDIA RTX 3060 (CUDA)',
      data_dir: 'D:\\Viku',
      offline_ready: { asr: true, denoise: true, embed: true, bible: this.auth.ebible === 'downloaded', library: true },
      details: { asr_indic: true, asr_whisper_en: false, denoise_engine: 'deepfilternet3', library_images: M.MOCK_LIBRARY.length, music_tracks: M.MOCK_MUSIC.length, fonts: true, sfx: true }
    }
  }
  async getSettings() {
    return clone(this.settings)
  }
  async saveSettings(s: Settings) {
    this.settings = clone(s)
    return clone(s)
  }

  async listProjects() {
    await wait(80)
    return this.projects.map((p) => ({
      id: p.id,
      name: p.name,
      video_path: p.video_path,
      duration: p.id === 'p-btf' ? 3125 : 2410,
      language: p.language,
      reel_count: p.reels.length,
      analyzed: p.transcript.length > 0,
      updated: p.id === 'p-btf' ? '2026-11-16T19:20:00' : '2026-10-27T10:04:00'
    }))
  }
  async getProject(id: string) {
    await wait(60)
    const p = this.projects.find((x) => x.id === id)
    if (!p) throw new Error(`project ${id} not found`)
    return clone(p)
  }
  async createProject(body: { name: string; video_path: string; language: Lang | 'auto' }) {
    const p: Project = {
      ...clone(this.projects[0]),
      id: `p-${Date.now().toString(36)}`,
      name: body.name,
      video_path: body.video_path,
      language: body.language,
      transcript: [],
      reels: []
    }
    this.projects.unshift(p)
    return clone(p)
  }
  async saveProject(p: Project) {
    const i = this.projects.findIndex((x) => x.id === p.id)
    if (i >= 0) this.projects[i] = clone(p)
    return clone(p)
  }
  async analyze(id: string) {
    const src = M.mockProjects()[0]
    return this.job(
      'analyze',
      [
        { msg: 'Making 540p proxy', ms: 1400 },
        { msg: 'Extracting 16 kHz audio + waveform peaks', ms: 700 },
        { msg: 'Detecting pauses and shot cuts', ms: 700 },
        { msg: 'Transcribing (Odia, IndicConformer)', ms: 2600 }
      ],
      () => {
        const p = this.projects.find((x) => x.id === id)
        if (p) p.transcript = src.transcript
        return { project: id }
      }
    )
  }
  async waveform(_id: string, start: number, end: number, px: number) {
    const n = Math.max(1, Math.round(px))
    const peaks: number[] = []
    for (let i = 0; i < n; i++) {
      const t = start + ((end - start) * i) / n
      peaks.push(speechEnvelope(t))
    }
    return { peaks, start, end }
  }

  async suggest(id: string) {
    return this.job(
      'suggest',
      [
        { msg: 'Scoring 128 windows (energy, address, lexicon)', ms: 900 },
        { msg: 'Semantic similarity to your favourites', ms: 700 },
        { msg: 'Ranking + jump-cut planning', ms: 600 }
      ],
      () => M.mockCandidates(id)
    )
  }
  async candidates(id: string): Promise<Candidate[]> {
    await wait(50)
    return M.mockCandidates(id)
  }
  async createReel(projectId: string, body: { segments: Seg[]; title: string; sub: string }) {
    const p = this.projects.find((x) => x.id === projectId)
    if (!p) throw new Error('project not found')
    const base = p.language === 'hi' ? M.mockReelHi() : M.mockReelA()
    let acc = 0
    const crops = body.segments.map(([s, e], i) => {
      const c = { t0: acc, t1: acc + (e - s), cx: 0.5, cw: 0.316, z: i % 2 ? 1.12 : 1 }
      acc += e - s
      return c
    })
    const lines = p.transcript.filter((l) => body.segments.some(([s, e]) => l.end > s && l.start < e))
    const captions = lines.slice(0, 12).map((l, i, all) => {
      const span = acc / Math.max(1, all.length)
      return { t0: i * span + 0.1, t1: (i + 1) * span - 0.1, text: l.text, flags: [] as CaptionFlag[] }
    })
    const reel: Reel = {
      ...base,
      id: `r-${Date.now().toString(36)}`,
      title: body.title,
      sub: body.sub,
      segments: body.segments,
      crops,
      captions,
      verses: [],
      cutaways: [],
      sfx: [{ name: 'impact_low', t: 0.2, gain_db: -8 }],
      status: 'draft',
      exports: [],
      thumbnail: { ...base.thumbnail, title: body.title, sub: body.sub, pose_t: Math.min(2, acc / 2) }
    }
    p.reels.push(reel)
    return clone(reel)
  }
  async attachCutawayImage(reelId: string, index: number, path: string) {
    await wait(120)
    const { r } = this.findReel(reelId)
    const c = r.cutaways[index]
    if (!c) throw new Error(`cutaway index ${index} out of range`)
    c.img = path
    if (c.need) {
      c.need_done = c.need
      delete c.need
    }
    return clone(c)
  }
  async autobuild(reelId: string) {
    return this.job(
      'autobuild',
      [
        { msg: 'Re-transcribing joined audio for captions', ms: 1200 },
        { msg: 'Detecting verses', ms: 500 },
        { msg: 'Planning cutaways + library picks', ms: 700 },
        { msg: 'Picking music + SFX', ms: 400 }
      ],
      () => {
        const { r } = this.findReel(reelId)
        r.status = 'built'
        if (!r.cutaways.length) r.cutaways = M.mockReelA().cutaways.slice(0, 2)
        return { reel: reelId }
      }
    )
  }
  async render(reelId: string) {
    const { r } = this.findReel(reelId)
    const out = `D:\\Viku\\exports\\${r.id}.mp4`
    return this.job(
      'render',
      [
        { msg: 'Speech enhancement (DeepFilterNet3)', ms: 1200 },
        { msg: 'Compositing 1080×1920 @ 30 fps', ms: 2200 },
        { msg: 'Loudness −14 LUFS / −1.5 dBTP', ms: 600 },
        { msg: 'Encoding H.264 CRF 18 + thumbnail', ms: 900 }
      ],
      () => {
        r.status = 'rendered'
        r.exports = [{ path: out, thumbnail: out.replace(/\.mp4$/, '.jpg') }]
        return { path: out, thumbnail: out.replace(/\.mp4$/, '.jpg') }
      }
    )
  }
  async thumbnail(reelId: string) {
    return this.job('thumbnail', [{ msg: 'Rendering thumbnail', ms: 900 }], () => ({ thumbnail: `D:\\Viku\\exports\\${reelId}.jpg` }))
  }
  async automate(body: AutomateRequest) {
    const n = body.count
    // weights mirror the engine's scopes: analyze 45%, suggest 5%, then per reel build 40% / render 60%
    const lang = body.language === 'auto' ? 'auto-detect → Odia' : body.language === 'hi' ? 'Hindi' : body.language === 'en' ? 'English' : 'Odia'
    const steps: Step[] = [
      { msg: 'making 540p proxy', ms: 1100 },
      { msg: 'waveform + pauses', ms: 600 },
      { msg: 'finding camera cuts', ms: 600 },
      { msg: `transcribing (${lang}, IndicConformer)`, ms: 2200 },
      { msg: 'Viku Brain: ranking 128 windows', ms: 300 },
      { msg: 'planning jump cuts', ms: 200 }
    ]
    const per = 5000 / n
    for (let i = 1; i <= n; i++) {
      steps.push({ msg: `reel ${i}/${n} · captions: re-transcribing the joined clip`, ms: per * 0.25 })
      steps.push({ msg: `reel ${i}/${n} · verse cards, cutaways, music`, ms: per * 0.15 })
      steps.push({ msg: `reel ${i}/${n} · speech enhancement`, ms: per * 0.2 })
      steps.push({ msg: `reel ${i}/${n} · rendering final`, ms: per * 0.4 })
    }
    return this.job('automate', steps, () => {
      const cands = M.mockCandidates('p-btf').slice(0, n)
      // same shape as the engine: {project, reels:[{reel, title, score, path, thumbnail}]}
      const reels = cands.map((c, i) => ({
        reel: i === 0 ? 'r-satan-defeated' : i === 1 ? 'r-before-foundation' : `r-auto-${i}`,
        title: c.title,
        duration: Math.min(body.max_seconds, c.segments.reduce((a, [s, e]) => a + e - s, 0)),
        score: c.score,
        path: `D:\\Viku\\exports\\auto\\${i + 1}.mp4`
      }))
      return { project: 'p-btf', reels }
    })
  }
  async cancelJob(jobId: string) {
    if (!this.timers.has(jobId)) return false
    this.timers.set(jobId, false)
    return true
  }

  async jobStatus() {
    return null
  }

  async captionsFix(text: string) {
    await wait(220)
    const flags: CaptionFlag[] = []
    for (const [wrong, fix] of Object.entries(M.MOCK_FIXES)) {
      let i = text.indexOf(wrong)
      while (i >= 0) {
        flags.push({ start: i, end: i + wrong.length, reason: fix.reason, suggest: fix.right })
        i = text.indexOf(wrong, i + wrong.length)
      }
    }
    return { text, flags: flags.sort((a, b) => a.start - b.start) }
  }
  async feedback() {
    await wait(80)
  }
  async learn() {
    return this.job('learn', [
      { msg: 'Embedding labelled windows', ms: 900 },
      { msg: 'Retraining ranker (logistic regression)', ms: 700 },
      { msg: 'Updating correction memory', ms: 300 }
    ])
  }

  async bibleSearch(q: string, lang: Lang) {
    await wait(120)
    const needle = q.trim().toLowerCase()
    return M.MOCK_BIBLE.filter((v) => v.lang === lang && (!needle || v.text.toLowerCase().includes(needle) || v.ref.toLowerCase().includes(needle)))
  }
  async bibleVerse(ref: string, lang: Lang) {
    await wait(100)
    const n = ref.trim().toLowerCase()
    return M.MOCK_BIBLE.find((v) => v.lang === lang && v.ref.toLowerCase().startsWith(n)) ?? M.MOCK_BIBLE.find((v) => v.ref.toLowerCase().startsWith(n)) ?? null
  }
  async bibleDownload() {
    return this.job(
      'bible_download',
      [
        { msg: 'Downloading ory (IRV Odia) USFM', ms: 1100 },
        { msg: 'Downloading hin2017 (IRV Hindi) USFM', ms: 1100 },
        { msg: 'Downloading eng-web USFM', ms: 900 },
        { msg: 'Indexing verses into SQLite', ms: 800 }
      ],
      () => {
        this.auth.ebible = 'downloaded'
        return { ok: true }
      }
    )
  }

  async librarySearch(q: string, _limit?: number) {
    await wait(90)
    const n = q.trim().toLowerCase()
    return M.MOCK_LIBRARY.filter((i) => !n || i.name.includes(n) || i.tags.some((t) => t.includes(n)))
  }
  async libraryImport() {
    return this.job('library_import', [{ msg: 'Tagging + embedding images', ms: 1200 }])
  }
  async listMusic() {
    return clone(M.MOCK_MUSIC)
  }
  async heygenMusic(intent: string) {
    return this.job('heygen_music', [{ msg: `HeyGen: generating "${intent}"`, ms: 2500 }], undefined, this.auth.heygen ? undefined : 'HeyGen is not signed in — open Sign-in → HeyGen')
  }
  async listSfx() {
    return clone(M.MOCK_SFX)
  }

  async authStatus() {
    return { ...this.auth }
  }
  async heygenLogin() {
    const ref = this.job('heygen_login', [{ msg: 'Waiting for you to approve the device code…', ms: 6000 }], () => {
      this.auth.heygen = true
      return { ok: true }
    })
    // the real engine streams the code in an early event
    setTimeout(() => this.emit({ job: ref.job, kind: 'heygen_login', progress: 0.05, message: 'Enter code WQ7K-M2PD at https://app.heygen.com/device', state: 'running', result: { code: 'WQ7K-M2PD', url: 'https://app.heygen.com/device' } }), 300)
    return ref
  }

  thumbUrl(path: string): string {
    return this.mediaUrl(path)
  }

  mediaUrl(path: string): string {
    const file = path.split(/[\\/]/).pop() ?? path
    const stem = file.replace(/\.[^.]+$/, '')
    if (/\.(mp4|mov|mkv|webm)$/i.test(file)) return this.mediaBase + 'sermon_proxy.mp4'
    if (/\.(png|jpe?g|webp)$/i.test(file)) return this.mediaBase + 'illus/' + encodeURIComponent(stem) + '.jpg'
    if (/\.(mp3|wav|m4a|ogg)$/i.test(file)) return this.mediaBase + 'audio/' + encodeURIComponent(stem.split(' - ')[0].trim().toLowerCase().replace(/\s+/g, '-')) + '.mp3'
    return this.mediaBase + encodeURIComponent(file)
  }

  subscribe(cb: (ev: JobEvent) => void) {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }
}

/** Deterministic speech-like envelope: syllables, words, phrase pauses. */
function speechEnvelope(t: number): number {
  const phrase = Math.sin(t * 0.55) * 0.5 + 0.5
  const pause = (t % 7.3) > 6.6 ? 0.08 : 1
  const syll = Math.abs(Math.sin(t * 9.1) * Math.sin(t * 3.7 + 1.3))
  const grain = (Math.sin(t * 131.7) * 43758.5453) % 1
  return Math.max(0.03, Math.min(1, pause * (0.25 + 0.55 * syll * (0.6 + 0.4 * phrase) + Math.abs(grain) * 0.18)))
}
