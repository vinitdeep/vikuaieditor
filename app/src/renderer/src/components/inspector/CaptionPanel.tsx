import { useEffect, useRef, useState } from 'react'
import { Captions, Check, Plus, SpellCheck2, Trash2 } from 'lucide-react'
import { api } from '@/api'
import type { CaptionFlag, Reel } from '@/api/types'
import { toast } from '@/state/app'
import { useEditor } from '@/state/editor'
import { usePlayback } from '@/state/playback'
import { activeAt, reelDuration } from '@/lib/reel'
import { clock } from '@/lib/time'
import { Button, Empty, IconButton, Section } from '../ui'
import { Row, TimeField } from './common'

/** Textarea with a backdrop that paints flagged spans from /captions/fix. */
function FlaggedEditor({ text, flags, lang, onChange, onCommit }: { text: string; flags: CaptionFlag[]; lang: string; onChange: (v: string) => void; onCommit: (v: string) => void }) {
  const back = useRef<HTMLDivElement>(null)
  const parts: React.ReactNode[] = []
  let i = 0
  const sorted = [...flags].filter((f) => f.end > f.start && f.end <= text.length).sort((a, b) => a.start - b.start)
  sorted.forEach((f, k) => {
    if (f.start < i) return
    parts.push(text.slice(i, f.start))
    parts.push(
      <mark key={k} title={`${f.reason}${f.suggest ? ` → ${f.suggest}` : ''}`}>
        {text.slice(f.start, f.end)}
      </mark>
    )
    i = f.end
  })
  parts.push(text.slice(i) + '\n')
  return (
    <div className={`hl-editor lang-${lang}`}>
      <div className="hl-back" ref={back} aria-hidden>
        {parts}
      </div>
      <textarea
        value={text}
        spellCheck={false}
        rows={3}
        aria-label="Caption text"
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit(e.target.value)}
        onScroll={(e) => {
          if (back.current) back.current.scrollTop = e.currentTarget.scrollTop
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.target as HTMLTextAreaElement).blur()
        }}
      />
    </div>
  )
}

export function CaptionPanel({ reel }: { reel: Reel }) {
  const selection = useEditor((s) => s.selection)
  const edit = useEditor((s) => s.edit)
  const select = useEditor((s) => s.select)
  const t = usePlayback((s) => s.t)
  const idx = selection?.kind === 'caption' ? selection.index : (activeAt(reel.captions, t)?.index ?? -1)
  const cap = reel.captions[idx]
  const [draft, setDraft] = useState(cap?.text ?? '')
  const [checking, setChecking] = useState(false)
  const original = useRef(cap?.text ?? '')
  useEffect(() => {
    setDraft(cap?.text ?? '')
    original.current = cap?.text ?? ''
  }, [cap?.text, idx])

  const commit = (v: string): void => {
    if (!cap || v === cap.text) return
    const before = cap.text
    edit('Edit caption', (r) => {
      r.captions[idx].text = v
      r.captions[idx].flags = []
    })
    void api().feedback({ reel_id: reel.id, kind: 'caption_edit', before, after: v })
  }

  const check = async (): Promise<void> => {
    if (!cap) return
    setChecking(true)
    try {
      const res = await api().captionsFix(draft, reel.language)
      edit('Check caption', (r) => {
        r.captions[idx].text = res.text
        r.captions[idx].flags = res.flags
      })
      toast(res.flags.length ? 'warn' : 'success', res.flags.length ? `${res.flags.length} word${res.flags.length > 1 ? 's' : ''} flagged` : 'No problems found')
    } catch (e) {
      toast('error', `Caption check failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setChecking(false)
    }
  }

  const apply = (f: CaptionFlag): void => {
    if (!cap || f.suggest === undefined) return
    const before = cap.text
    const after = before.slice(0, f.start) + f.suggest + before.slice(f.end)
    const delta = f.suggest.length - (f.end - f.start)
    edit('Apply suggestion', (r) => {
      const c = r.captions[idx]
      c.text = after
      c.flags = c.flags.filter((x) => x !== f && !(x.start === f.start && x.end === f.end)).map((x) => (x.start > f.start ? { ...x, start: x.start + delta, end: x.end + delta } : x))
    })
    void api().feedback({ reel_id: reel.id, kind: 'caption_edit', before, after })
  }

  const checkAll = async (): Promise<void> => {
    setChecking(true)
    try {
      const results = await Promise.all(reel.captions.map((c) => api().captionsFix(c.text, reel.language)))
      edit('Check all captions', (r) => {
        results.forEach((res, i) => {
          r.captions[i].flags = res.flags
        })
      })
      const n = results.reduce((a, r) => a + r.flags.length, 0)
      toast(n ? 'warn' : 'success', n ? `${n} flagged word${n > 1 ? 's' : ''} across ${reel.captions.length} captions` : 'All captions look good')
    } finally {
      setChecking(false)
    }
  }

  const addAtPlayhead = (): void => {
    const end = Math.min(reelDuration(reel), t + 3)
    edit('Add caption', (r) => {
      r.captions.push({ t0: t, t1: end, text: '…', flags: [] })
      r.captions.sort((a, b) => a.t0 - b.t0)
    })
  }

  return (
    <>
      {cap ? (
        <Section
          title={`Caption ${idx + 1} of ${reel.captions.length}`}
          right={<IconButton icon={Trash2} label="Delete caption" onClick={() => edit('Delete caption', (r) => void r.captions.splice(idx, 1))} />}
        >
          <FlaggedEditor text={draft} flags={draft === cap.text ? cap.flags : []} lang={reel.language} onChange={setDraft} onCommit={commit} />
          <div className="row gap">
            <Button size="sm" icon={SpellCheck2} onClick={() => void check()} disabled={checking}>
              {checking ? 'Checking…' : 'Check'}
            </Button>
            <span className="small muted grow">Ctrl+Enter to commit</span>
          </div>
          {cap.flags.length > 0 && draft === cap.text && (
            <div className="flags">
              {cap.flags.map((f, k) => (
                <div key={k} className="flag-row">
                  <span className={`flag-word lang-${reel.language}`}>{cap.text.slice(f.start, f.end)}</span>
                  {f.suggest !== undefined && (
                    <>
                      <span className="muted">→</span>
                      <span className={`flag-sugg lang-${reel.language}`}>{f.suggest}</span>
                    </>
                  )}
                  <span className="flag-reason small muted grow">{f.reason}</span>
                  {f.suggest !== undefined && (
                    <Button size="sm" variant="ghost" icon={Check} onClick={() => apply(f)}>
                      Fix
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          <Row label="Start">
            <TimeField label="Caption start" value={cap.t0} max={cap.t1 - 0.1} onChange={(v) => edit('Caption timing', (r) => void (r.captions[idx].t0 = v), `cap-t0-${idx}`)} />
          </Row>
          <Row label="End">
            <TimeField label="Caption end" value={cap.t1} min={cap.t0 + 0.1} onChange={(v) => edit('Caption timing', (r) => void (r.captions[idx].t1 = v), `cap-t1-${idx}`)} />
          </Row>
        </Section>
      ) : (
        <Empty icon={Captions} title="No caption here">
          Move the playhead over a caption or click one on the Captions track.
        </Empty>
      )}
      <Section
        title={`All captions (${reel.captions.length})`}
        right={
          <span className="row">
            <IconButton icon={SpellCheck2} label="Check all captions" onClick={() => void checkAll()} />
            <IconButton icon={Plus} label="Add caption at playhead" onClick={addAtPlayhead} />
          </span>
        }
      >
        <div className="cap-list">
          {reel.captions.map((c, i) => (
            <button
              key={i}
              type="button"
              className={`cap-row${i === idx ? ' on' : ''}`}
              onClick={() => {
                select({ kind: 'caption', index: i })
                usePlayback.getState().seek(c.t0 + 0.01)
              }}
            >
              <span className="num muted">{clock(c.t0, 1)}</span>
              <span className={`grow ellipsis lang-${reel.language}`}>{c.text}</span>
              {c.flags.length > 0 && <span className="flag-count num">{c.flags.length}</span>}
            </button>
          ))}
        </div>
      </Section>
    </>
  )
}
