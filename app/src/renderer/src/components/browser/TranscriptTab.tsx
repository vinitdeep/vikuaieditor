import { useEffect, useMemo, useRef, useState } from 'react'
import { Clapperboard, Eye, ScrollText, Search, X } from 'lucide-react'
import type { Seg } from '@/api/types'
import { useApp } from '@/state/app'
import { useEditor, useReel } from '@/state/editor'
import { usePlayback } from '@/state/playback'
import { clock, duration } from '@/lib/time'
import { Button, Empty, IconButton, LangBadge } from '../ui'
import { normalizeRanges, useTranscriptSel, type Range } from '@/state/transcriptSel'

const normalize = normalizeRanges

export function TranscriptTab() {
  const project = useEditor((s) => s.project)
  const reel = useReel()
  const createReel = useEditor((s) => s.createReel)
  const srcT = usePlayback((s) => s.srcT)
  const viewer = usePlayback((s) => s.viewer)
  const [q, setQ] = useState('')
  const ranges = useTranscriptSel((s) => s.ranges)
  const setRanges = useTranscriptSel((s) => s.setRanges)
  const markIn = useTranscriptSel((s) => s.markIn)
  const [drag, setDrag] = useState<{ anchor: number; cur: number; add: boolean; x: number; y: number; moved: boolean } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const lines = useMemo(() => project?.transcript ?? [], [project])
  const needle = q.trim().toLowerCase()
  const visible = useMemo(() => lines.map((l, i) => ({ l, i })).filter(({ l }) => !needle || l.text.toLowerCase().includes(needle)), [lines, needle])

  const live: Range[] = drag && drag.moved ? normalize([...(drag.add ? ranges : []), [drag.anchor, drag.cur]]) : ranges
  const inSel = (i: number): boolean => live.some(([a, b]) => i >= a && i <= b)
  const segs: Seg[] = live.map(([a, b]) => [Math.max(0, lines[a].start - 0.12), lines[b].end + 0.2])
  const total = segs.reduce((acc, [s, e]) => acc + e - s, 0)

  const usedInReel = (start: number, end: number): boolean => Boolean(reel?.segments.some(([s, e]) => end > s + 0.05 && start < e - 0.05))
  const activeIdx = viewer === 'source' ? lines.findIndex((l) => srcT >= l.start && srcT < l.end) : -1

  useEffect(() => {
    if (!drag) return
    const up = (): void => {
      if (drag.moved) setRanges(normalize([...(drag.add ? ranges : []), [drag.anchor, drag.cur]]))
      else {
        // plain click = seek the source viewer to this line
        const l = lines[drag.anchor]
        if (l) {
          usePlayback.setState({ viewer: 'source', srcT: l.start, playing: false, preview: null })
        }
        if (!drag.add) setRanges([])
      }
      setDrag(null)
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [drag, ranges, lines, setRanges])

  useEffect(() => {
    if (activeIdx < 0 || !listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  if (!project) {
    return <Empty icon={ScrollText} title="No project open">Open a sermon from Media.</Empty>
  }
  if (!lines.length) {
    return <Empty icon={ScrollText} title="No transcript yet">Analyze the sermon to transcribe it (Odia / Hindi / English).</Empty>
  }

  const makeReel = async (): Promise<void> => {
    if (!segs.length) return
    const first = lines[live[0][0]]
    const title = first.text.length > 40 ? first.text.slice(0, 38) + '…' : first.text
    const r = await createReel(segs, title, '')
    if (r) {
      setRanges([])
      useApp.getState().toast('success', `Reel created from ${segs.length} range${segs.length > 1 ? 's' : ''} (${duration(total)})`)
    }
  }

  return (
    <div className="transcript-tab">
      <div className="ptool">
        <span className="search">
          <Search size={13} aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search transcript…" spellCheck={false} onKeyDown={(e) => e.stopPropagation()} aria-label="Search transcript" />
          {q && <IconButton icon={X} label="Clear search" size={12} onClick={() => setQ('')} />}
        </span>
      </div>
      <div className="tlist" ref={listRef} role="listbox" aria-multiselectable>
        {visible.map(({ l, i }) => {
          const sel = inSel(i)
          const used = usedInReel(l.start, l.end)
          return (
            <div
              key={i}
              data-idx={i}
              role="option"
              aria-selected={sel}
              className={`tline${sel ? ' sel' : ''}${i === activeIdx ? ' active' : ''}${used ? ' used' : ''}${i === markIn ? ' mark-in' : ''}`}
              onMouseDown={(e) => {
                if (e.button !== 0) return
                e.preventDefault()
                if (e.shiftKey && ranges.length) {
                  const last = ranges[ranges.length - 1]
                  setRanges(normalize([...ranges.slice(0, -1), [last[0], i]]))
                  return
                }
                setDrag({ anchor: i, cur: i, add: e.ctrlKey || e.metaKey, x: e.clientX, y: e.clientY, moved: false })
              }}
              onMouseEnter={(e) => {
                if (drag && e.buttons === 1) setDrag({ ...drag, cur: i, moved: drag.moved || i !== drag.anchor })
              }}
              onMouseMove={(e) => {
                if (drag && !drag.moved && e.buttons === 1 && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) setDrag({ ...drag, moved: true })
              }}
            >
              <span className="tl-time num">{clock(l.start)}</span>
              <span className={`tl-text lang-${l.lang}`}>{needle ? highlight(l.text, needle) : l.text}</span>
              <span className="tl-meta">
                <LangBadge lang={l.lang} />
                {l.conf < 0.75 && <span className="conf-dot" title={`Low ASR confidence (${Math.round(l.conf * 100)}%)`} />}
              </span>
            </div>
          )
        })}
        {!visible.length && <div className="muted small pad">No lines match “{q}”.</div>}
      </div>
      <div className={`sel-bar${live.length ? ' show' : ''}`}>
        {live.length ? (
          <>
            <span className="num">
              <b>{live.length}</b> range{live.length > 1 ? 's' : ''} · <b className={total > 60 ? 'over' : ''}>{duration(total)}</b>
              {total > 60 && <span className="over"> · over 60 s</span>}
            </span>
            <span className="grow" />
            <IconButton
              icon={Eye}
              label="Preview ranges in the source viewer"
              onClick={() => usePlayback.setState({ viewer: 'source', preview: segs, srcT: segs[0][0], playing: true, rate: 1 })}
            />
            <IconButton icon={X} label="Clear selection" onClick={() => setRanges([])} />
            <Button size="sm" variant="primary" icon={Clapperboard} onClick={() => void makeReel()}>
              Make reel
            </Button>
          </>
        ) : (
          <span className="muted small">
            {markIn !== null ? (
              <>
                In-point set — click the last line and press <kbd className="kbd">O</kbd>
              </>
            ) : (
              <>
                Click a line to seek · drag to select · <kbd className="kbd">I</kbd> / <kbd className="kbd">O</kbd> mark in / out
              </>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

function highlight(text: string, needle: string): React.ReactNode {
  const i = text.toLowerCase().indexOf(needle)
  if (i < 0) return text
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + needle.length)}</mark>
      {text.slice(i + needle.length)}
    </>
  )
}
