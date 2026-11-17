import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import { Loader2, Sparkles } from 'lucide-react'
import type { Reel } from '@/api/types'
import { useApp } from '@/state/app'
import { useEditor, type Selection } from '@/state/editor'
import { usePlayback } from '@/state/playback'
import { bladeAt, cropFor, layout, moveSegment, splitCaption, trimSegment } from '@/lib/reel'
import { clock } from '@/lib/time'
import { dragging, readDrop, type DragPayload } from '@/lib/dnd'
import { insertVerse } from '../browser/BibleTab'
import { Thumb } from '../ui'
import { cutawayAt, cutawayName, setCutawayImage, useLibraryIndex } from '@/lib/cutaways'
import { generateForCutaway, genKey, useGen } from '@/lib/gemini'
import type { Geo } from './Timeline'

let dragSeq = 0

const EDGE = 6

type TimedKind = 'caption' | 'verse' | 'cutaway'

function isSel(sel: Selection | null, kind: Selection['kind'], index: number): boolean {
  return Boolean(sel && sel.kind === kind && 'index' in sel && sel.index === index)
}

/** Pointer helper: calls move(dx) until release. */
function track(e: React.PointerEvent, move: (dx: number, ev: PointerEvent) => void, up?: (dx: number) => void): void {
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const x0 = e.clientX
  const onMove = (ev: PointerEvent): void => move(ev.clientX - x0, ev)
  const onUp = (ev: PointerEvent): void => {
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerup', onUp)
    up?.(ev.clientX - x0)
  }
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', onUp)
}

function laneTime(e: { clientX: number; currentTarget: EventTarget }, geo: Geo): number {
  const lane = (e.currentTarget as HTMLElement).closest('.tl-lanes') as HTMLElement
  const rect = lane.getBoundingClientRect()
  return Math.max(0, Math.min(geo.dur, geo.t(e.clientX - rect.left)))
}

/** Drop-target behaviour for a lane. */
function useDrop(accept: DragPayload['kind'][], onDrop: (p: DragPayload, t: number) => void, geo: Geo) {
  const [over, setOver] = useState(false)
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        const p = dragging()
        if (!p || !accept.includes(p.kind)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (!over) setOver(true)
        usePlayback.setState({ skim: laneTime(e, geo) })
      },
      onDragLeave: () => {
        setOver(false)
        usePlayback.setState({ skim: null })
      },
      onDrop: (e: React.DragEvent) => {
        setOver(false)
        usePlayback.setState({ skim: null })
        const p = readDrop(e)
        if (!p || !accept.includes(p.kind)) return
        e.preventDefault()
        onDrop(p, geo.snap(laneTime(e, geo)))
      }
    }
  }
}

/** Move / resize behaviour shared by captions, verses and cutaways. */
function timedPointer(kind: TimedKind, index: number, item: { t0: number; t1: number }, geo: Geo) {
  return (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    const ed = useEditor.getState()
    const tool = useApp.getState().tool
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const local = e.clientX - rect.left
    const t = item.t0 + local / geo.zoom
    if (tool === 'blade') {
      if (kind === 'caption') {
        ed.edit('Blade caption', (r) => {
          const parts = splitCaption(r.captions[index], t)
          if (parts) r.captions.splice(index, 1, parts[0], parts[1])
        })
      } else {
        ed.edit(`Blade ${kind}`, (r) => {
          const list = kind === 'verse' ? r.verses : r.cutaways
          const it = list[index]
          if (t - it.t0 < 0.3 || it.t1 - t < 0.3) return
          const second = { ...it, t0: t }
          it.t1 = t
          ;(list as { t0: number; t1: number }[]).splice(index + 1, 0, second)
        })
      }
      return
    }
    ed.select({ kind, index })
    const mode: 'move' | 'l' | 'r' = local < EDGE ? 'l' : local > rect.width - EDGE ? 'r' : 'move'
    const key = `drag:${kind}-${++dragSeq}`
    const { t0, t1 } = item
    const len = t1 - t0
    track(
      e,
      (dx) => {
        const d = dx / geo.zoom
        let n0 = t0
        let n1 = t1
        if (mode === 'move') {
          n0 = geo.snap(t0 + d, [t0, t1])
          const s1 = geo.snap(t0 + d + len, [t0, t1])
          if (Math.abs(s1 - (t0 + d + len)) < Math.abs(n0 - (t0 + d))) n0 = s1 - len
          n0 = Math.max(0, Math.min(geo.dur - len, n0))
          n1 = n0 + len
        } else if (mode === 'l') n0 = Math.max(0, Math.min(t1 - 0.2, geo.snap(t0 + d, [t0])))
        else n1 = Math.min(geo.dur, Math.max(t0 + 0.2, geo.snap(t1 + d, [t1])))
        ed.edit(
          mode === 'move' ? `Move ${kind}` : `Trim ${kind}`,
          (r) => {
            const list = kind === 'caption' ? r.captions : kind === 'verse' ? r.verses : r.cutaways
            list[index].t0 = Math.round(n0 * 1000) / 1000
            list[index].t1 = Math.round(n1 * 1000) / 1000
          },
          key
        )
      },
      () => {
        ed.edit(
          `Move ${kind}`,
          (r) => {
            const list = kind === 'caption' ? r.captions : kind === 'verse' ? r.verses : r.cutaways
            ;(list as { t0: number }[]).sort((a, b) => a.t0 - b.t0)
          },
          key
        )
      }
    )
  }
}

// ---------------- lanes ----------------

export function VerseLane({ reel, geo, h }: { reel: Reel; geo: Geo; h: number }) {
  const sel = useEditor((s) => s.selection)
  const drop = useDrop(['verse'], (p, t) => p.kind === 'verse' && insertVerse(p, t), geo)
  return (
    <div className={`lane lane-verse${drop.over ? ' drop' : ''}`} style={{ height: h }} {...drop.props}>
      {reel.verses.map((v, i) => (
        <div
          key={i}
          className={`clip clip-verse${isSel(sel, 'verse', i) ? ' sel' : ''}`}
          style={{ left: geo.x(v.t0), width: Math.max(4, (v.t1 - v.t0) * geo.zoom) }}
          onPointerDown={timedPointer('verse', i, v, geo)}
          title={`${v.ref}\n${v.text}`}
        >
          <span className={`clip-label lang-${reel.language}`}>{v.ref}</span>
        </div>
      ))}
    </div>
  )
}

export function CutawayLane({ reel, geo, h }: { reel: Reel; geo: Geo; h: number }) {
  const sel = useEditor((s) => s.selection)
  const queued = useGen((s) => s.queued)
  const byPath = useLibraryIndex((s) => s.byPath)
  const byId = useLibraryIndex((s) => s.byId)
  const lib = { byPath, byId, loaded: true, loading: false, load: async () => undefined }
  useEffect(() => {
    void useLibraryIndex.getState().load()
  }, [])
  const drop = useDrop(
    ['image'],
    (p, t) => {
      if (p.kind !== 'image') return
      // dropped onto an existing cutaway: swap its picture (timing and motion stay)
      const hit = cutawayAt(reel.cutaways, t)
      if (hit >= 0) {
        const lib = useLibraryIndex.getState().byPath[p.path.toLowerCase()]
        useEditor.getState().edit('Swap cutaway image', (r) => setCutawayImage(r.cutaways[hit], p.path, lib ?? { name: p.name }))
        useEditor.getState().select({ kind: 'cutaway', index: hit })
        return
      }
      useEditor.getState().edit('Add cutaway', (r) => {
        const t0 = Math.max(0, Math.min(t, geo.dur - 1))
        r.cutaways.push({ t0, t1: Math.min(geo.dur, t0 + 4), img: p.path, z0: 1, z1: 1.1, pan: [0, 0] })
        r.cutaways.sort((a, b) => a.t0 - b.t0)
      })
    },
    geo
  )
  return (
    <div className={`lane lane-cutaway${drop.over ? ' drop' : ''}`} style={{ height: h }} {...drop.props}>
      {reel.cutaways.map((c, i) => {
        const w = Math.max(4, (c.t1 - c.t0) * geo.zoom)
        const name = cutawayName(c, lib)
        const key = genKey(reel.id, c.t0)
        const isQueued = Boolean(queued[key])
        if (!c.img) {
          return (
            <div
              key={i}
              className={`clip clip-cutaway needs${isSel(sel, 'cutaway', i) ? ' sel' : ''}${isQueued ? ' queued' : ''}`}
              style={{ left: geo.x(c.t0), width: w }}
              onPointerDown={timedPointer('cutaway', i, c, geo)}
              title={`Needs image${name ? ` — ${name}` : ''}${c.need?.prompt ? `

${c.need.prompt}` : ''}`}
            >
              <span className="need-icon" aria-hidden>
                {isQueued ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />}
              </span>
              {w > 70 && (
                <span className="need-text">
                  <b>{isQueued ? 'In AI Studio queue' : 'Needs image'}</b>
                  {name && w > 120 && <span className="ellipsis">{name}</span>}
                </span>
              )}
              {!isQueued && w > 46 && (
                <button
                  type="button"
                  className="need-gen"
                  title="Generate in AI Studio — the prompt is queued in the Sign-in window and the image attaches itself"
                  aria-label={`Generate cutaway ${i + 1} in AI Studio`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => void generateForCutaway(reel.id, i)}
                >
                  <Sparkles size={11} aria-hidden />
                  {w > 210 && <span>Generate</span>}
                </button>
              )}
            </div>
          )
        }
        const thumb = api().thumbUrl(c.img, 160)
        return (
          <div
            key={i}
            className={`clip clip-cutaway${isSel(sel, 'cutaway', i) ? ' sel' : ''}`}
            style={{ left: geo.x(c.t0), width: w }}
            onPointerDown={timedPointer('cutaway', i, c, geo)}
            title={`${name}
${c.img}`}
          >
            <span className="cut-bg" aria-hidden>
              <Thumb src={thumb} alt="" seed={i + 3} />
            </span>
            {w >= 120 && (
              <span className="cut-thumb">
                <Thumb src={thumb} alt="" seed={i + 3} />
              </span>
            )}
            {w > 30 && <span className="cut-name ellipsis">{name}</span>}
            <span className="xfade l" />
            <span className="xfade r" />
          </div>
        )
      })}
    </div>
  )
}

export function CaptionLane({ reel, geo, h }: { reel: Reel; geo: Geo; h: number }) {
  const sel = useEditor((s) => s.selection)
  return (
    <div className="lane lane-caption" style={{ height: h }}>
      {reel.captions.map((c, i) => (
        <div
          key={i}
          className={`clip clip-caption${isSel(sel, 'caption', i) ? ' sel' : ''}${c.flags.length ? ' flagged' : ''}`}
          style={{ left: geo.x(c.t0), width: Math.max(3, (c.t1 - c.t0) * geo.zoom) }}
          onPointerDown={timedPointer('caption', i, c, geo)}
          onDoubleClick={() => useApp.getState().set({ inspectorTab: 'caption' })}
          title={c.text}
        >
          <span className={`clip-label lang-${reel.language}`}>{c.text}</span>
        </div>
      ))}
    </div>
  )
}

export function VideoLane({ reel, geo, h }: { reel: Reel; geo: Geo; h: number }) {
  const sel = useEditor((s) => s.selection)
  const srcDur = useEditor((s) => s.project?.duration ?? 0)
  const placed = layout(reel.segments)
  const [reorder, setReorder] = useState<{ from: number; to: number; dx: number } | null>(null)

  const onDown = (index: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const ed = useEditor.getState()
    const tool = useApp.getState().tool
    const p = placed[index]
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const local = e.clientX - rect.left
    if (tool === 'blade') {
      const t = p.t0 + local / geo.zoom
      ed.edit('Blade', (r) => void bladeAt(r, t))
      return
    }
    ed.select({ kind: 'segment', index })
    const edge: 'in' | 'out' | null = local < EDGE ? 'in' : local > rect.width - EDGE ? 'out' : tool === 'trim' ? (local < rect.width / 2 ? 'in' : 'out') : null
    const key = `drag:seg-${++dragSeq}`
    if (edge) {
      const s0 = p.src[0]
      track(e, (dx) => {
        const d = dx / geo.zoom
        if (edge === 'out') {
          const tEnd = geo.snap(p.t1 + d, [p.t1])
          ed.edit('Trim out', (r) => trimSegment(r, index, 'out', s0 + (tEnd - p.t0), srcDur), key)
        } else {
          ed.edit('Trim in', (r) => trimSegment(r, index, 'in', s0 + d, srcDur), key)
        }
      })
      return
    }
    // drag to reorder
    track(
      e,
      (dx) => {
        if (Math.abs(dx) < 4 && !reorder) return
        const centre = (p.t0 + p.t1) / 2 + dx / geo.zoom
        let to = placed.findIndex((q) => centre < (q.t0 + q.t1) / 2)
        if (to < 0) to = placed.length
        setReorder({ from: index, to, dx })
      },
      (dx) => {
        setReorder(null)
        if (Math.abs(dx) < 4) {
          usePlayback.setState({ t: p.t0 + local / geo.zoom, playing: false })
          return
        }
        const centre = (p.t0 + p.t1) / 2 + dx / geo.zoom
        let to = placed.findIndex((q) => centre < (q.t0 + q.t1) / 2)
        if (to < 0) to = placed.length
        const target = to > index ? to - 1 : to
        if (target !== index) {
          ed.edit('Reorder segment', (r) => moveSegment(r, index, target))
          ed.select({ kind: 'segment', index: target })
        }
      }
    )
  }

  return (
    <div className="lane lane-video" style={{ height: h }}>
      {placed.map((p) => {
        const crop = cropFor(reel, p.index)
        const w = (p.t1 - p.t0) * geo.zoom
        const moving = reorder?.from === p.index
        return (
          <div
            key={p.index}
            className={`clip clip-video${isSel(sel, 'segment', p.index) ? ' sel' : ''}${moving ? ' moving' : ''}${crop.z > 1.001 ? ' punched' : ''}`}
            style={{ left: geo.x(p.t0) + (moving ? reorder.dx : 0), width: Math.max(3, w - 1) }}
            onPointerDown={onDown(p.index)}
            title={`Segment ${p.index + 1}\nsource ${clock(p.src[0], 1)} → ${clock(p.src[1], 1)}\ncrop cx ${crop.cx.toFixed(3)} · z ${crop.z.toFixed(2)}`}
          >
            <span className="seg-top">
              <span className="seg-num num">{p.index + 1}</span>
              {w > 90 && (
                <span className="seg-src num">
                  {clock(p.src[0], 1)}–{clock(p.src[1], 1)}
                </span>
              )}
              {crop.z > 1.001 && w > 40 && <span className="seg-badge num">×{crop.z.toFixed(2)}</span>}
              {crop.cw > 0.34 && w > 60 && <span className="seg-badge wide">wide</span>}
            </span>
            <span className="seg-film" aria-hidden />
          </div>
        )
      })}
      {placed.slice(1).map((p) => (
        <span key={`jc-${p.index}`} className="jumpcut" style={{ left: geo.x(p.t0) }} title="Jump cut" />
      ))}
      {reorder && reorder.to !== reorder.from && reorder.to !== reorder.from + 1 && (
        <span className="insert-mark" style={{ left: geo.x(reorder.to < placed.length ? placed[reorder.to].t0 : geo.dur) }} />
      )}
    </div>
  )
}

const waveCache = new Map<string, number[]>()

function WaveSeg({ projectId, src, x, w, h }: { projectId: string; src: [number, number]; x: number; w: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const px = Math.max(8, Math.min(4000, Math.round(w / 2)))
  const bucket = Math.round(px / 25) * 25 || 8
  const key = `${projectId}:${src[0].toFixed(2)}:${src[1].toFixed(2)}:${bucket}`
  const [peaks, setPeaks] = useState<number[] | null>(waveCache.get(key) ?? null)

  useEffect(() => {
    const cached = waveCache.get(key)
    if (cached) {
      setPeaks(cached)
      return
    }
    let alive = true
    const t = setTimeout(() => {
      api()
        .waveform(projectId, src[0], src[1], bucket)
        .then((wf) => {
          waveCache.set(key, wf.peaks)
          if (alive) setPeaks(wf.peaks)
        })
        .catch(() => undefined)
    }, 120)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [key, projectId, src, bucket])

  useEffect(() => {
    const cv = ref.current
    if (!cv || !peaks) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.max(1, Math.round(w * dpr))
    cv.height = Math.round(h * dpr)
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)
    const mid = h / 2
    const n = peaks.length
    ctx.fillStyle = 'rgba(122, 230, 170, 0.85)'
    const bw = w / n
    for (let i = 0; i < n; i++) {
      const a = Math.max(0.5, peaks[i] * (mid - 3))
      ctx.fillRect(i * bw, mid - a, Math.max(1, bw - 0.4), a * 2)
    }
  }, [peaks, w, h])

  return <canvas ref={ref} className="wave" style={{ left: x, width: w, height: h }} />
}

export function VoiceLane({ reel, geo, h }: { reel: Reel; geo: Geo; h: number }) {
  const projectId = useEditor((s) => s.project?.id ?? '')
  const sel = useEditor((s) => s.selection)
  const placed = layout(reel.segments)
  return (
    <div className={`lane lane-voice${sel?.kind === 'voice' ? ' sel' : ''}`} style={{ height: h }}>
      {placed.map((p) => (
        <div
          key={p.index}
          className="clip clip-voice"
          style={{ left: geo.x(p.t0), width: Math.max(3, (p.t1 - p.t0) * geo.zoom - 1) }}
          onPointerDown={(e) => {
            if (useApp.getState().tool !== 'select') return
            e.stopPropagation()
            useEditor.getState().select({ kind: 'voice' })
            usePlayback.setState({ t: laneTime(e, geo), playing: false })
          }}
        >
          <WaveSeg projectId={projectId} src={p.src} x={0} w={Math.max(3, (p.t1 - p.t0) * geo.zoom - 1)} h={h - 6} />
        </div>
      ))}
    </div>
  )
}

export function MusicLane({ reel, geo, h }: { reel: Reel; geo: Geo; h: number }) {
  const sel = useEditor((s) => s.selection)
  const drop = useDrop(
    ['music'],
    (p) => {
      if (p.kind !== 'music') return
      useEditor.getState().edit('Set music', (r) => {
        r.music = { path: p.path, gain_db: r.music?.gain_db ?? -19, start: 0, duck_db: r.music?.duck_db ?? -8 }
      })
    },
    geo
  )
  const m = reel.music
  const w = geo.dur * geo.zoom
  // level line: music gain, dipped by the duck amount under speech (captions)
  const toY = (db: number): number => 3 + ((-6 - db) / 30) * (h - 10)
  let path = ''
  if (m) {
    const base = toY(m.gain_db)
    const duck = toY(m.gain_db + (m.duck_db ?? -8))
    // speech spans = captions merged across short gaps; music ducks under them
    const spans: [number, number][] = []
    for (const c of [...reel.captions].sort((a, b) => a.t0 - b.t0)) {
      const last = spans[spans.length - 1]
      if (last && c.t0 - last[1] < 0.8) last[1] = Math.max(last[1], c.t1)
      else spans.push([c.t0, c.t1])
    }
    const pts: [number, number][] = [[0, base]]
    for (const [s, e] of spans) {
      const a = s * geo.zoom
      const b = e * geo.zoom
      pts.push([Math.max(0, a - 8), base], [a, duck], [b, duck], [b + 8, base])
    }
    pts.push([w, base])
    path = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  }
  return (
    <div className={`lane lane-music${drop.over ? ' drop' : ''}`} style={{ height: h }} {...drop.props}>
      {m ? (
        <div
          className={`clip clip-music${sel?.kind === 'music' ? ' sel' : ''}`}
          style={{ left: geo.x(0), width: Math.max(4, w) }}
          onPointerDown={(e) => {
            e.stopPropagation()
            useEditor.getState().select({ kind: 'music' })
          }}
          title={m.path}
        >
          <svg className="level" width={w} height={h - 4} aria-hidden>
            <path d={path} />
          </svg>
          <span className="clip-label">
            {(m.path.split(/[\\/]/).pop() ?? '').replace(/\.[^.]+$/, '')} · {m.gain_db} dB
          </span>
        </div>
      ) : (
        <span className="lane-hint">Drop music here</span>
      )}
    </div>
  )
}

export function SfxLane({ reel, geo, h }: { reel: Reel; geo: Geo; h: number }) {
  const sel = useEditor((s) => s.selection)
  const drop = useDrop(
    ['sfx'],
    (p, t) => {
      if (p.kind !== 'sfx') return
      useEditor.getState().edit('Add SFX', (r) => {
        r.sfx.push({ name: p.name, t, gain_db: -12 })
        r.sfx.sort((a, b) => a.t - b.t)
      })
    },
    geo
  )
  return (
    <div className={`lane lane-sfx${drop.over ? ' drop' : ''}`} style={{ height: h }} {...drop.props}>
      {reel.sfx.map((s, i) => (
        <div
          key={i}
          className={`sfx-mark${isSel(sel, 'sfx', i) ? ' sel' : ''}`}
          style={{ left: geo.x(s.t) }}
          title={`${s.name} · ${s.gain_db} dB`}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            const ed = useEditor.getState()
            ed.select({ kind: 'sfx', index: i })
            const key = `drag:sfx-${++dragSeq}`
            const t0 = s.t
            track(e, (dx) => {
              const nt = Math.max(0, Math.min(geo.dur, geo.snap(t0 + dx / geo.zoom, [t0])))
              ed.edit('Move SFX', (r) => void (r.sfx[i].t = Math.round(nt * 1000) / 1000), key)
            })
          }}
        >
          <span className="diamond" />
          <span className="sfx-label">{s.name.replace(/_/g, ' ')}</span>
        </div>
      ))}
    </div>
  )
}
