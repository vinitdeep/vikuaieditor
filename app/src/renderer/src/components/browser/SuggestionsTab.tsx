import { Brain, Check, Loader2, Play, Sparkles, ThumbsDown } from 'lucide-react'
import { api } from '@/api'
import type { Candidate } from '@/api/types'
import { toast } from '@/state/app'
import { useEditor } from '@/state/editor'
import { useJobs } from '@/state/jobs'
import { usePlayback } from '@/state/playback'
import { clock, duration } from '@/lib/time'
import { Button, Empty, IconButton, LangBadge, Progress } from '../ui'

export function SuggestionsTab() {
  const project = useEditor((s) => s.project)
  const cands = useEditor((s) => s.candidates)
  const rejected = useEditor((s) => s.rejected)
  const kept = useEditor((s) => s.kept)
  const jobs = useJobs((s) => s.jobs)
  const running = Object.values(jobs).find((j) => j.kind === 'suggest' && (j.state === 'running' || j.state === 'queued'))

  if (!project) return <Empty icon={Sparkles} title="No project open">Open a sermon from Media.</Empty>

  const find = async (): Promise<void> => {
    try {
      const ref = await api().suggest(project.id)
      useJobs.getState().track(ref, 'Find clips (Viku Brain)', {
        onDone: async () => {
          const c = await api().candidates(project.id)
          useEditor.getState().setCandidates(c)
          toast('success', `Viku Brain found ${c.length} candidate reels`)
        }
      })
    } catch (e) {
      toast('error', `Clip finder failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const learn = async (): Promise<void> => {
    const ref = await api().learn()
    useJobs.getState().track(ref, 'Learn from feedback', { onDone: () => toast('success', 'Viku Brain updated from your keeps and rejects') })
  }

  const ordered = [...cands].sort((a, b) => Number(rejected.includes(a.id)) - Number(rejected.includes(b.id)) || b.score - a.score)

  return (
    <div className="sugg-tab">
      <div className="ptool">
        <Button size="sm" variant="primary" icon={Sparkles} onClick={() => void find()} disabled={Boolean(running)}>
          {cands.length ? 'Find again' : 'Find clips'}
        </Button>
        <span className="grow" />
        <Button size="sm" variant="ghost" icon={Brain} onClick={() => void learn()} title="Retrain the ranker from your feedback">
          Learn
        </Button>
      </div>
      {running && (
        <div className="analyze-card">
          <div className="row">
            <Loader2 size={13} className="spin" aria-hidden />
            <span className="grow ellipsis">{running.message}</span>
            <span className="num muted">{Math.round(running.progress * 100)}%</span>
          </div>
          <Progress value={running.progress} />
        </div>
      )}
      <div className="clist">
        {!cands.length && !running && (
          <Empty icon={Sparkles} title="No suggestions yet">
            Viku Brain ranks every 20–60 s window by energy, direct address, encouragement and scripture — and learns from what you keep.
          </Empty>
        )}
        {ordered.map((c, i) => (
          <CandidateCard key={c.id} c={c} rank={i + 1} rejected={rejected.includes(c.id)} kept={kept.includes(c.id)} />
        ))}
      </div>
    </div>
  )
}

function CandidateCard({ c, rank, rejected, kept }: { c: Candidate; rank: number; rejected: boolean; kept: boolean }) {
  const total = c.segments.reduce((a, [s, e]) => a + e - s, 0)
  const pct = Math.round(c.score * 100)

  const keep = async (): Promise<void> => {
    const reel = await useEditor.getState().createReel(c.segments, c.title, '')
    if (!reel) return
    useEditor.getState().markCandidate(c.id, 'keep')
    void api().feedback({ reel_id: reel.id, kind: 'keep', before: { candidate: c.id, score: c.score, segments: c.segments }, after: null })
    toast('success', 'Kept — reel added to the timeline')
  }
  const reject = (): void => {
    useEditor.getState().markCandidate(c.id, 'reject')
    void api().feedback({ reel_id: c.id, kind: 'reject', before: { candidate: c.id, score: c.score, segments: c.segments, reasons: c.reasons }, after: null })
  }
  const preview = (): void => {
    usePlayback.setState({ viewer: 'source', preview: c.segments, srcT: c.segments[0]?.[0] ?? 0, playing: true, rate: 1 })
  }

  return (
    <article className={`ccard${rejected ? ' rejected' : ''}${kept ? ' kept' : ''}`}>
      <header>
        <span className="ccard-rank num">#{rank}</span>
        <span className={`ccard-title lang-${c.language}`}>{c.title}</span>
        <LangBadge lang={c.language} />
      </header>
      <div className="score">
        <span className="score-bar" aria-label={`Score ${pct}`}>
          <span style={{ width: `${pct}%` }} className={pct >= 80 ? 'hi' : pct >= 60 ? 'mid' : 'lo'} />
        </span>
        <span className="num score-val">{pct}</span>
      </div>
      <div className="ccard-meta num">
        {duration(total)} · {c.segments.length} cut{c.segments.length > 1 ? 's' : ''} · starts {clock(c.segments[0]?.[0] ?? 0)}
      </div>
      <div className="reasons">
        {c.reasons.map((r) => (
          <span key={r} className={`reason${/low content|crowd/.test(r) ? ' neg' : ''}`}>
            {r}
          </span>
        ))}
      </div>
      <footer>
        <IconButton icon={Play} label="Preview in source viewer" onClick={preview} />
        <span className="grow" />
        {kept ? (
          <span className="kept-label">
            <Check size={12} aria-hidden /> Kept
          </span>
        ) : (
          <>
            <Button size="sm" variant="ghost" icon={ThumbsDown} onClick={reject} disabled={rejected}>
              {rejected ? 'Rejected' : 'Reject'}
            </Button>
            <Button size="sm" icon={Check} onClick={() => void keep()}>
              Keep
            </Button>
          </>
        )}
      </footer>
    </article>
  )
}
