import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AudioLines,
  BookOpen,
  Captions,
  Film,
  Image as ImageIcon,
  Magnet,
  Maximize2,
  Mic,
  MousePointer2,
  Music2,
  Redo2,
  Scissors,
  ScanLine,
  Undo2,
  ZoomIn,
  ZoomOut,
  MoveHorizontal
} from 'lucide-react'
import type { Reel } from '@/api/types'
import { useApp, type Tool } from '@/state/app'
import { useEditor, useReel } from '@/state/editor'
import { usePlayback } from '@/state/playback'
import { editPoints, reelDuration } from '@/lib/reel'
import { clock } from '@/lib/time'
import { Empty, IconButton } from '../ui'
import { CaptionLane, CutawayLane, MusicLane, SfxLane, VerseLane, VideoLane, VoiceLane } from './Lanes'

export const HEADER_W = 132
export const PAD_L = 16

export interface TrackDef {
  id: 'verse' | 'cutaway' | 'caption' | 'video' | 'voice' | 'music' | 'sfx'
  label: string
  icon: typeof Film
  h: number
}

export const TRACKS: TrackDef[] = [
  { id: 'verse', label: 'Verse', icon: BookOpen, h: 26 },
  { id: 'cutaway', label: 'Cutaways', icon: ImageIcon, h: 40 },
  { id: 'caption', label: 'Captions', icon: Captions, h: 28 },
  { id: 'video', label: 'Video', icon: Film, h: 58 },
  { id: 'voice', label: 'Voice', icon: Mic, h: 44 },
  { id: 'music', label: 'Music', icon: Music2, h: 30 },
  { id: 'sfx', label: 'SFX', icon: AudioLines, h: 26 }
]

/** Shared geometry + snapping for the lanes. */
export interface Geo {
  zoom: number
  dur: number
  x: (t: number) => number
  t: (x: number) => number
  snap: (t: number, exclude?: number[]) => number
}

function niceStep(zoom: number): { major: number; minor: number } {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120]
  const major = steps.find((s) => s * zoom >= 64) ?? 120
  const minor = major >= 10 ? major / 5 : major / (major === 0.5 ? 5 : major === 2 ? 4 : 5)
  return { major, minor }
}

export function Timeline() {
  const reel = useReel()
  const tool = useApp((s) => s.tool)
  const snapping = useApp((s) => s.snapping)
  const skimming = useApp((s) => s.skimming)
  const zoom = useApp((s) => s.zoom)
  const setApp = useApp((s) => s.set)
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewW, setViewW] = useState(800)
  const reelId = reel?.id

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewW(el.clientWidth))
    ro.observe(el)
    setViewW(el.clientWidth)
    return () => ro.disconnect()
  }, [reelId])

  const dur = reel ? reelDuration(reel) : 0
  const fit = useCallback(() => {
    if (!dur) return
    setApp({ zoom: Math.max(4, Math.min(400, (viewW - PAD_L - 40) / dur)) })
  }, [dur, viewW, setApp])

  // fit when a different reel opens
  useEffect(() => {
    if (reelId) fit()
  }, [reelId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl+wheel zoom around the pointer
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const z = useApp.getState().zoom
      const nz = Math.max(4, Math.min(400, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
      const rect = el.getBoundingClientRect()
      const px = e.clientX - rect.left + el.scrollLeft - HEADER_W - PAD_L
      const tAt = px / z
      setApp({ zoom: nz })
      requestAnimationFrame(() => {
        el.scrollLeft = tAt * nz - (e.clientX - rect.left - HEADER_W - PAD_L)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setApp, reelId])

  const geo: Geo | null = useMemo(() => {
    if (!reel) return null
    const pts = editPoints(reel)
    const itemEdges = [...reel.captions.flatMap((c) => [c.t0, c.t1]), ...reel.cutaways.flatMap((c) => [c.t0, c.t1]), ...reel.verses.flatMap((v) => [v.t0, v.t1]), ...reel.sfx.map((s) => s.t)]
    return {
      zoom,
      dur,
      x: (t: number) => PAD_L + t * zoom,
      t: (x: number) => (x - PAD_L) / zoom,
      snap: (t: number, exclude: number[] = []) => {
        if (!useApp.getState().snapping) return t
        const th = 8 / zoom
        const targets = [...pts, ...itemEdges, usePlayback.getState().t, dur].filter((p) => !exclude.some((e) => Math.abs(e - p) < 1e-4))
        let best = t
        let bestD = th
        for (const p of targets) {
          const d = Math.abs(p - t)
          if (d < bestD) {
            bestD = d
            best = p
          }
        }
        return best
      }
    }
  }, [reel, zoom, dur])

  const tools: { id: Tool; label: string; icon: typeof Film; kbd: string }[] = [
    { id: 'select', label: 'Select', icon: MousePointer2, kbd: 'A' },
    { id: 'blade', label: 'Blade', icon: Scissors, kbd: 'B' },
    { id: 'trim', label: 'Trim', icon: MoveHorizontal, kbd: 'T' }
  ]

  return (
    <div className="panel timeline">
      <div className="tl-toolbar">
        <div className="tool-group" role="radiogroup" aria-label="Tools">
          {tools.map((t) => (
            <IconButton key={t.id} icon={t.icon} label={t.label} kbd={t.kbd} active={tool === t.id} onClick={() => setApp({ tool: t.id })} />
          ))}
        </div>
        <span className="tb-div" />
        <IconButton icon={Undo2} label="Undo" kbd="Ctrl+Z" disabled={!canUndo} onClick={() => useEditor.getState().undo()} />
        <IconButton icon={Redo2} label="Redo" kbd="Ctrl+Y" disabled={!canRedo} onClick={() => useEditor.getState().redo()} />
        <span className="tb-div" />
        <IconButton icon={Magnet} label="Snapping" kbd="N" active={snapping} onClick={() => setApp({ snapping: !snapping })} />
        <IconButton icon={ScanLine} label="Skimming" kbd="S" active={skimming} onClick={() => setApp({ skimming: !skimming })} />
        <span className="grow" />
        {reel && <ReelSummary reel={reel} />}
        <span className="grow" />
        <IconButton icon={ZoomOut} label="Zoom out" kbd="Ctrl+−" onClick={() => setApp({ zoom: Math.max(4, zoom / 1.25) })} />
        <input
          className="zoom-slider"
          type="range"
          min={Math.log(4)}
          max={Math.log(400)}
          step={0.01}
          value={Math.log(zoom)}
          aria-label="Timeline zoom"
          onChange={(e) => setApp({ zoom: Math.exp(Number(e.target.value)) })}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <IconButton icon={ZoomIn} label="Zoom in" kbd="Ctrl+=" onClick={() => setApp({ zoom: Math.min(400, zoom * 1.25) })} />
        <IconButton icon={Maximize2} label="Zoom to fit" kbd="Shift+Z" onClick={fit} />
      </div>
      {!reel || !geo ? (
        <div className="tl-empty">
          <Empty icon={Film} title="Timeline is empty">
            Select transcript lines and press <b>Make reel</b>, or keep a suggestion.
          </Empty>
        </div>
      ) : (
        <div className={`tl-scroll tool-${tool}`} ref={scrollRef}>
          <TimelineBody reel={reel} geo={geo} viewW={viewW} />
        </div>
      )}
    </div>
  )
}

function ReelSummary({ reel }: { reel: Reel }) {
  const dur = reelDuration(reel)
  return (
    <span className="tl-summary num">
      <span className={`lang-${reel.language} ellipsis`} style={{ maxWidth: 220 }}>
        {reel.title}
      </span>
      <span className={dur > 60 ? 'over' : 'muted'}>{dur.toFixed(1)} s</span>
      <span className="muted">· {reel.segments.length} seg · {reel.captions.length} cap · {reel.cutaways.length} cut</span>
    </span>
  )
}

function TimelineBody({ reel, geo, viewW }: { reel: Reel; geo: Geo; viewW: number }) {
  const contentW = Math.max(viewW - HEADER_W, geo.x(geo.dur) + 160)
  const skimming = useApp((s) => s.skimming)
  const tool = useApp((s) => s.tool)
  const lanesRef = useRef<HTMLDivElement>(null)

  const timeFromEvent = (e: { clientX: number }): number => {
    const el = lanesRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return Math.max(0, Math.min(geo.dur, geo.t(e.clientX - rect.left)))
  }

  const scrub = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    usePlayback.setState({ playing: false, viewer: 'reel', t: timeFromEvent(e) })
    const move = (ev: PointerEvent): void => usePlayback.setState({ t: geo.snap(timeFromEvent(ev)) })
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <div className="tl-body" style={{ width: HEADER_W + contentW }}>
      <div className="tl-ruler-row">
        <div className="tl-corner">
          <CornerClock />
        </div>
        <Ruler geo={geo} width={contentW} onPointerDown={scrub} />
      </div>
      <div className="tl-rows">
        <div className="tl-headers">
          {TRACKS.map((t) => (
            <div key={t.id} className={`tl-head th-${t.id}`} style={{ height: t.h }}>
              <t.icon size={12} aria-hidden />
              <span>{t.label}</span>
            </div>
          ))}
        </div>
        <div
          className="tl-lanes"
          ref={lanesRef}
          style={{ width: contentW }}
          onPointerMove={(e) => {
            if (skimming && e.buttons === 0) usePlayback.setState({ skim: timeFromEvent(e) })
          }}
          onPointerLeave={() => usePlayback.setState({ skim: null })}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('lane')) {
              if (tool === 'select') useEditor.getState().select(null)
              scrub(e)
            }
          }}
        >
          <VerseLane reel={reel} geo={geo} h={TRACKS[0].h} />
          <CutawayLane reel={reel} geo={geo} h={TRACKS[1].h} />
          <CaptionLane reel={reel} geo={geo} h={TRACKS[2].h} />
          <VideoLane reel={reel} geo={geo} h={TRACKS[3].h} />
          <VoiceLane reel={reel} geo={geo} h={TRACKS[4].h} />
          <MusicLane reel={reel} geo={geo} h={TRACKS[5].h} />
          <SfxLane reel={reel} geo={geo} h={TRACKS[6].h} />
          <div className="tl-end" style={{ left: geo.x(geo.dur) }} />
          <Playhead geo={geo} />
        </div>
      </div>
    </div>
  )
}

function Ruler({ geo, width, onPointerDown }: { geo: Geo; width: number; onPointerDown: (e: React.PointerEvent) => void }) {
  const { major, minor } = niceStep(geo.zoom)
  const ticks: React.ReactNode[] = []
  const maxT = geo.t(width)
  for (let t = 0; t <= maxT + 1e-6; t += minor) {
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6
    ticks.push(
      <span key={t.toFixed(3)} className={`tick${isMajor ? ' major' : ''}`} style={{ left: geo.x(t) }}>
        {isMajor && <span className="tick-label num">{clock(t, major < 1 ? 1 : 0)}</span>}
      </span>
    )
  }
  const marks = [60]
  return (
    <div className="tl-ruler" style={{ width }} onPointerDown={onPointerDown}>
      {ticks}
      {marks.map((m) => (
        <span key={m} className="limit-mark" style={{ left: geo.x(m) }} title="60 s limit" />
      ))}
      <RulerHead geo={geo} />
    </div>
  )
}

function CornerClock() {
  const t = usePlayback((s) => s.skim ?? s.t)
  return <span className="num">{clock(t, 2)}</span>
}

function RulerHead({ geo }: { geo: Geo }) {
  const t = usePlayback((s) => s.t)
  return <span className="ruler-head" style={{ left: geo.x(t) }} />
}

function Playhead({ geo }: { geo: Geo }) {
  const t = usePlayback((s) => s.t)
  const skim = usePlayback((s) => s.skim)
  const playing = usePlayback((s) => s.playing)
  const ref = useRef<HTMLDivElement>(null)
  // keep the playhead in view while playing
  useEffect(() => {
    if (!playing) return
    const el = ref.current?.closest('.tl-scroll') as HTMLElement | null
    if (!el) return
    const x = geo.x(t) + HEADER_W
    if (x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - HEADER_W - 60
  }, [t, playing, geo])
  return (
    <>
      {skim !== null && <div className="skimline" style={{ left: geo.x(skim) }} />}
      <div ref={ref} className="playhead" style={{ left: geo.x(t) }} />
    </>
  )
}
