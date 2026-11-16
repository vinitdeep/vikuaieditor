import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Layers,
  MonitorPlay,
  Pause,
  Play,
  Rewind,
  FastForward,
  ScanLine,
  SkipBack,
  SkipForward,
  Smartphone
} from 'lucide-react'
import { api } from '@/api'
import type { Project, Reel } from '@/api/types'
import { useApp } from '@/state/app'
import { useEditor, useReel } from '@/state/editor'
import { usePlayback } from '@/state/playback'
import { cropAt, cropFor, cropRect, layout, placedAt, reelDuration, reelToSource } from '@/lib/reel'
import { clamp, timecode } from '@/lib/time'
import { Empty, IconButton, Segmented, Select } from '../ui'
import { CaptionLayer, CreditLine, CutawayLayer, SafeZones, TitleHook, VerseLayer, cutawayInfluence } from './Overlays'

const FPS = 30
type Zoom = 'fit' | '25' | '33' | '50'

interface MediaSrc {
  url: string
  /** source second at file time 0 */
  offset: number
  start: number
  end: number
}

/** Engine proxies only analysed ranges: pick the proxy covering a source time, else the original video. */
function mediaSources(project: Project | null): MediaSrc[] {
  if (!project) return []
  const out: MediaSrc[] = project.proxies.map((p) => ({ url: api().mediaUrl(p.path), offset: p.start, start: p.start, end: p.end }))
  if (!out.length && project.proxy) {
    const off = project.proxy_offset || 0
    out.push({ url: api().mediaUrl(project.proxy), offset: off, start: off, end: off > 0 ? Infinity : project.duration || Infinity })
  }
  if (project.video_path) out.push({ url: api().mediaUrl(project.video_path), offset: 0, start: 0, end: Infinity })
  return out
}

export interface MediaCtl {
  video: React.RefObject<HTMLVideoElement | null>
  /** current source time from the decoder, null while loading/switching */
  now: () => number | null
  seek: (srcT: number) => void
  onLoaded: () => void
  onError: () => void
}

function useMedia(project: Project | null): { ctl: MediaCtl; active: MediaSrc | null; hasVideo: boolean } {
  const key = project ? `${project.id}|${project.proxy}|${project.proxies.map((p) => p.path).join(',')}|${project.video_path}` : ''
  const sources = useMemo(() => mediaSources(project), [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const [active, setActive] = useState<MediaSrc | null>(null)
  const [failedAll, setFailedAll] = useState(false)
  const activeRef = useRef<MediaSrc | null>(null)
  const pending = useRef<number | null>(null)
  const bad = useRef(new Set<string>())
  const video = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    bad.current.clear()
    setFailedAll(false)
    const first = sources[0] ?? null
    activeRef.current = first
    setActive(first)
  }, [sources])

  const ctl = useMemo<MediaCtl>(() => {
    const pick = (t: number): MediaSrc | null => {
      const ok = sources.filter((s) => !bad.current.has(s.url))
      return ok.find((s) => t >= s.start - 0.01 && t < s.end - 0.01) ?? ok[ok.length - 1] ?? null
    }
    return {
      video,
      now: () => {
        const v = video.current
        const a = activeRef.current
        if (!v || !a || pending.current !== null || v.readyState < 2) return null
        return v.currentTime + a.offset
      },
      seek: (t) => {
        const want = pick(t)
        if (!want) return
        if (want.url !== activeRef.current?.url) {
          activeRef.current = want
          pending.current = t
          setActive(want)
          return
        }
        const v = video.current
        if (!v || v.readyState < 1) {
          pending.current = t
          return
        }
        v.currentTime = Math.max(0, t - want.offset)
      },
      onLoaded: () => {
        const v = video.current
        const a = activeRef.current
        if (v && a && pending.current !== null) {
          v.currentTime = Math.max(0, pending.current - a.offset)
          pending.current = null
        }
      },
      onError: () => {
        const a = activeRef.current
        if (a) bad.current.add(a.url)
        const t = pending.current ?? (a ? a.start : 0)
        const next = pick(t)
        if (!next) {
          setFailedAll(true)
          return
        }
        activeRef.current = next
        pending.current = t
        setActive(next)
      }
    }
  }, [sources])

  return { ctl, active, hasVideo: Boolean(active) && !failedAll }
}

/** Playback clock for both viewer modes; the decoder drives time at 1x, a manual clock otherwise. */
function usePlaybackEngine(ctl: MediaCtl, reel: Reel | null, project: Project | null, hasVideo: boolean) {
  const raf = useRef(0)
  const last = useRef(0)

  useEffect(() => {
    const half = 0.5 / FPS
    const tick = (now: number): void => {
      const dt = last.current ? Math.min(0.1, (now - last.current) / 1000) : 0
      last.current = now
      const pb = usePlayback.getState()
      const v = ctl.video.current
      if (pb.playing) {
        if (pb.viewer === 'reel' && reel) {
          const dur = reelDuration(reel)
          const placed = layout(reel.segments)
          const p = placedAt(placed, pb.t)
          const src = hasVideo ? ctl.now() : null
          if (pb.rate === 1 && hasVideo && v && p) {
            if (src !== null) {
              if (v.paused) void v.play().catch(() => undefined)
              if (src >= p.src[1] - half) {
                // jump cut: hop to the next segment
                const next = placed[p.index + 1]
                if (next) {
                  ctl.seek(next.src[0])
                  pb.set({ t: next.t0 })
                } else {
                  v.pause()
                  pb.set({ playing: false, t: dur })
                }
              } else if (src < p.src[0] - 0.25 || src > p.src[1] + 0.25) {
                ctl.seek(p.src[0] + (pb.t - p.t0))
              } else {
                pb.set({ t: clamp(p.t0 + (src - p.src[0]), 0, dur) })
              }
            }
          } else {
            if (v && !v.paused) v.pause()
            const nt = pb.t + dt * pb.rate
            if (nt >= dur || nt <= 0) pb.set({ t: clamp(nt, 0, dur), playing: false, rate: 1 })
            else pb.set({ t: nt })
            if (hasVideo && v && !v.seeking) {
              const target = reelToSource(reel, usePlayback.getState().t).src
              if (src === null || Math.abs(src - target) > 0.05) ctl.seek(target)
            }
          }
        } else if (pb.viewer === 'source' && project) {
          const ranges = pb.preview
          const src = hasVideo ? ctl.now() : null
          if (pb.rate === 1 && hasVideo && v) {
            if (src !== null) {
              if (v.paused) void v.play().catch(() => undefined)
              let cur = src
              if (ranges && ranges.length && !ranges.some(([s, e]) => cur >= s - 0.3 && cur < e)) {
                const next = ranges.find(([s]) => s > cur)
                if (next) {
                  ctl.seek(next[0])
                  cur = next[0]
                } else {
                  v.pause()
                  pb.set({ playing: false, preview: null })
                }
              }
              pb.set({ srcT: cur })
            }
          } else {
            if (v && !v.paused) v.pause()
            let nt = clamp(pb.srcT + dt * pb.rate, 0, project.duration || 1e9)
            if (ranges && ranges.length && pb.rate > 0 && !ranges.some(([s, e]) => nt >= s && nt < e)) {
              const next = ranges.find(([s]) => s > nt)
              if (next) nt = next[0]
              else pb.set({ playing: false, preview: null })
            }
            pb.set({ srcT: nt })
            if (hasVideo && v && !v.seeking && (src === null || Math.abs(src - nt) > 0.05)) ctl.seek(nt)
          }
        }
      } else if (v && !v.paused) {
        v.pause()
      }
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [reel, project, hasVideo, ctl])

  // when paused (or skimming), follow scrubs
  const t = usePlayback((s) => s.t)
  const skim = usePlayback((s) => s.skim)
  const srcT = usePlayback((s) => s.srcT)
  const viewer = usePlayback((s) => s.viewer)
  const playing = usePlayback((s) => s.playing)
  useEffect(() => {
    if (!hasVideo || (playing && skim === null)) return
    const target = viewer === 'reel' ? (reel ? reelToSource(reel, skim ?? t).src : 0) : srcT
    const cur = ctl.now()
    if (cur === null || Math.abs(cur - target) > 0.5 / FPS) ctl.seek(target)
  }, [t, skim, srcT, viewer, playing, reel, hasVideo, ctl])
}

export function Viewer() {
  const reel = useReel()
  const project = useEditor((s) => s.project)
  const viewer = usePlayback((s) => s.viewer)
  const safeZone = usePlayback((s) => s.safeZone)
  const showOverlays = usePlayback((s) => s.showOverlays)
  const set = usePlayback((s) => s.set)
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [box, setBox] = useState({ w: 400, h: 600 })
  const [vsize, setVsize] = useState({ w: 960, h: 540 })
  const areaRef = useRef<HTMLDivElement>(null)
  const { ctl, active, hasVideo } = useMedia(project)
  const src = active?.url ?? ''

  usePlaybackEngine(ctl, reel, project, hasVideo)

  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const isReel = viewer === 'reel'
  const aspect = isReel ? 9 / 16 : 16 / 9
  const pad = 28
  let fh = Math.max(50, box.h - pad)
  let fw = fh * aspect
  if (fw > box.w - pad) {
    fw = Math.max(50, box.w - pad)
    fh = fw / aspect
  }
  if (zoom !== 'fit' && isReel) {
    fh = (1920 * Number(zoom)) / 100
    fw = (1080 * Number(zoom)) / 100
  }

  return (
    <div className="panel viewer">
      <div className="viewer-head">
        <Segmented
          size="sm"
          ariaLabel="Viewer"
          value={viewer}
          onChange={(v) => set({ viewer: v, playing: false, preview: null })}
          options={[
            { id: 'reel', label: 'Reel 9:16', icon: Smartphone },
            { id: 'source', label: 'Source 16:9', icon: MonitorPlay }
          ]}
        />
        <span className="grow" />
        {usePlayback.getState().preview && viewer === 'source' && <span className="chip chip-gold">Previewing ranges</span>}
        <IconButton icon={ScanLine} label="Safe zones" active={safeZone} onClick={() => set({ safeZone: !safeZone })} kbd="Shift+S" />
        <IconButton icon={Layers} label="Show titles / captions / verses" active={showOverlays} onClick={() => set({ showOverlays: !showOverlays })} />
        <Select
          ariaLabel="Viewer zoom"
          value={zoom}
          onChange={setZoom}
          options={[
            { id: 'fit', label: 'Fit' },
            { id: '25', label: '25%' },
            { id: '33', label: '33%' },
            { id: '50', label: '50%' }
          ]}
        />
      </div>
      <div className="viewer-area" ref={areaRef} onDoubleClick={() => setZoom('fit')}>
        <div className={`stage ${isReel ? 'stage-reel' : 'stage-src'}`} style={{ width: fw, height: fh }}>
          {isReel && !reel ? (
            <Empty icon={Clapperboard} title="No reel open">
              Make a reel from the Transcript, keep a Suggestion, or run Automate.
            </Empty>
          ) : (
            <StageContent
              reel={reel}
              isReel={isReel}
              scale={isReel ? fh / 1920 : fh / 1080}
              fw={fw}
              fh={fh}
              src={src}
              hasVideo={hasVideo}
              videoRef={ctl.video}
              vsize={vsize}
              onMeta={(w, h) => {
                setVsize({ w, h })
                ctl.onLoaded()
              }}
              onError={ctl.onError}
              safeZone={safeZone}
              showOverlays={showOverlays}
            />
          )}
        </div>
      </div>
      <Transport reel={reel} project={project} />
    </div>
  )
}

function StageContent(props: {
  reel: Reel | null
  isReel: boolean
  scale: number
  fw: number
  fh: number
  src: string
  hasVideo: boolean
  videoRef: React.RefObject<HTMLVideoElement | null>
  vsize: { w: number; h: number }
  onMeta: (w: number, h: number) => void
  onError: () => void
  safeZone: boolean
  showOverlays: boolean
}) {
  const { reel, isReel, scale, src, hasVideo, videoRef, vsize, safeZone, showOverlays } = props
  const t = usePlayback((s) => s.skim ?? s.t)
  const srcT = usePlayback((s) => s.srcT)
  const selection = useEditor((s) => s.selection)
  const credit = useApp((s) => s.settings?.credit_line ?? '')
  const fillRef = useRef<HTMLCanvasElement>(null)

  // reel framing: fixed crop + punch-in, scaled to width over a blurred fill
  let videoStyle: React.CSSProperties = { left: 0, top: 0, width: '100%', height: '100%' }
  let wide = false
  if (isReel && reel) {
    const c = cropAt(reel, t)
    const cropPx = Math.max(1, c.cw * vsize.w)
    const s = (1080 / cropPx) * c.z
    const dispW = vsize.w * s
    const dispH = vsize.h * s
    wide = dispH < 1919
    const push = cutawayInfluence(reel, t).push
    videoStyle = {
      left: 540 - c.cx * vsize.w * s,
      top: 960 - dispH / 2,
      width: dispW,
      height: dispH,
      transform: push > 0 ? `scale(${1 + 0.1 * push})` : undefined,
      transformOrigin: `${c.cx * 100}% 50%`,
      filter: push > 0.02 ? `blur(${(push * 10).toFixed(1)}px)` : undefined
    }
  }

  // blurred fill for wide (walking-speaker) crops
  useEffect(() => {
    if (!wide) return
    let id = 0
    const draw = (): void => {
      const v = videoRef.current
      const cv = fillRef.current
      if (v && cv && v.readyState >= 2) {
        const ctx = cv.getContext('2d')
        if (ctx) {
          const cw = cv.width
          const ch = cv.height
          const s = Math.max(cw / v.videoWidth, ch / v.videoHeight)
          const w = v.videoWidth * s
          const h = v.videoHeight * s
          try {
            ctx.drawImage(v, (cw - w) / 2, (ch - h) / 2, w, h)
          } catch {
            /* not ready */
          }
        }
      }
      id = requestAnimationFrame(draw)
    }
    id = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(id)
  }, [wide, videoRef])

  const inner: React.CSSProperties = isReel
    ? { width: 1080, height: 1920, transform: `scale(${scale})` }
    : { width: 1920, height: 1080, transform: `scale(${scale})` }

  return (
    <div className="stage-inner" style={inner}>
      {isReel && wide && <canvas ref={fillRef} className="fill-blur" width={54} height={96} />}
      {hasVideo ? (
        <video
          ref={videoRef}
          className="stage-video"
          style={videoStyle}
          src={src}
          preload="auto"
          playsInline
          onLoadedMetadata={(e) => props.onMeta(e.currentTarget.videoWidth || 960, e.currentTarget.videoHeight || 540)}
          onError={props.onError}
        />
      ) : (
        <div className="stage-video placeholder-video" style={videoStyle}>
          <div className="ph-speaker" />
          <div className="ph-label">Proxy video unavailable — mock preview</div>
        </div>
      )}
      {isReel && reel && (
        <>
          <CutawayLayer reel={reel} t={t} />
          {showOverlays && (
            <>
              <VerseLayer reel={reel} t={t} />
              <TitleHook reel={reel} t={t} />
              <CaptionLayer reel={reel} t={t} selected={selection?.kind === 'caption' ? selection.index : undefined} />
              <CreditLine text={credit} />
            </>
          )}
          {safeZone && <SafeZones />}
        </>
      )}
      {!isReel && <SourceCrop reel={reel} srcT={srcT} />}
    </div>
  )
}

/** 16:9 source with the fixed crop box of the segment under the source playhead; drag horizontally only. */
function SourceCrop({ reel, srcT }: { reel: Reel | null; srcT: number }) {
  const edit = useEditor((s) => s.edit)
  const selection = useEditor((s) => s.selection)
  const [drag, setDrag] = useState<{ x0: number; cx0: number; idx: number } | null>(null)
  if (!reel || !reel.segments.length) {
    return (
      <div className="src-hint">
        <span>Source viewer — click transcript lines to seek</span>
      </div>
    )
  }
  let idx = reel.segments.findIndex(([s, e]) => srcT >= s && srcT < e)
  if (idx < 0 && selection?.kind === 'segment') idx = selection.index
  if (idx < 0) {
    return (
      <div className="src-hint">
        <span>Not inside a segment of this reel — crop box shows on its segments</span>
      </div>
    )
  }
  const crop = cropFor(reel, idx)
  const r = cropRect(crop.cx, crop.cw)
  const onDown = (e: React.PointerEvent): void => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setDrag({ x0: e.clientX, cx0: crop.cx, idx })
  }
  const onMove = (e: React.PointerEvent): void => {
    if (!drag) return
    const stage = (e.currentTarget as HTMLElement).closest('.stage') as HTMLElement | null
    const w = stage?.clientWidth ?? 1
    const cx = clamp(drag.cx0 + (e.clientX - drag.x0) / w, crop.cw / 2, 1 - crop.cw / 2)
    const placed = layout(reel.segments)[drag.idx]
    edit(
      'Move crop',
      (d) => {
        let c = d.crops.find((c) => Math.abs(c.t0 - placed.t0) < 0.02)
        if (!c) {
          c = { t0: placed.t0, t1: placed.t1, cx, cw: crop.cw, z: crop.z }
          d.crops.push(c)
          d.crops.sort((a, b) => a.t0 - b.t0)
        }
        c.cx = Math.round(cx * 1000) / 1000
      },
      `crop-${drag.idx}`
    )
  }
  return (
    <>
      <div className="crop-shade" style={{ left: 0, width: `${r.x * 100}%` }} />
      <div className="crop-shade" style={{ left: `${(r.x + r.w) * 100}%`, right: 0 }} />
      <div
        className={`crop-box${drag ? ' dragging' : ''}`}
        style={{ left: `${r.x * 100}%`, width: `${r.w * 100}%`, top: `${r.y * 100}%`, height: `${r.h * 100}%` }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => setDrag(null)}
        title="Drag left / right to reframe (fixed crop, no tracking)"
      >
        <span className="crop-label num">
          Segment {idx + 1} · cx {crop.cx.toFixed(3)} · {crop.z > 1 ? `punch ${crop.z.toFixed(2)}` : '1.00'}
        </span>
        <span className="crop-grip l" />
        <span className="crop-grip r" />
      </div>
    </>
  )
}

function Transport({ reel, project }: { reel: Reel | null; project: Project | null }) {
  const viewer = usePlayback((s) => s.viewer)
  const playing = usePlayback((s) => s.playing)
  const rate = usePlayback((s) => s.rate)
  const t = usePlayback((s) => (s.viewer === 'reel' ? (s.skim ?? s.t) : s.srcT))
  const dur = viewer === 'reel' ? (reel ? reelDuration(reel) : 0) : (project?.duration ?? 0)

  const step = useCallback(
    (d: number) => {
      const pb = usePlayback.getState()
      pb.set({ playing: false })
      if (pb.viewer === 'reel') pb.seek(clamp(pb.t + d, 0, dur))
      else pb.seekSource(clamp(pb.srcT + d, 0, dur))
    },
    [dur]
  )
  const go = (to: number): void => {
    const pb = usePlayback.getState()
    pb.set({ playing: false })
    if (pb.viewer === 'reel') pb.seek(to)
    else pb.seekSource(to)
  }

  return (
    <div className="transport">
      <div className="tp-left">
        <IconButton icon={SkipBack} label="Go to start" kbd="Home" onClick={() => go(0)} />
        <IconButton icon={ChevronLeft} label="Previous frame" kbd="←" onClick={() => step(-1 / FPS)} />
        <IconButton icon={Rewind} label="Play reverse" kbd="J" active={playing && rate < 0} onClick={() => usePlayback.setState({ playing: true, rate: rate < 0 ? Math.max(-8, rate * 2) : -1 })} />
        <button
          type="button"
          className="play-btn"
          aria-label={playing ? 'Pause' : 'Play'}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          onClick={() => usePlayback.getState().toggle()}
        >
          {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
        </button>
        <IconButton icon={FastForward} label="Play forward / faster" kbd="L" active={playing && rate > 1} onClick={() => usePlayback.setState({ playing: true, rate: playing && rate > 0 ? Math.min(8, rate * 2) : 1 })} />
        <IconButton icon={ChevronRight} label="Next frame" kbd="→" onClick={() => step(1 / FPS)} />
        <IconButton icon={SkipForward} label="Go to end" kbd="End" onClick={() => go(dur)} />
      </div>
      <div className="tp-time num">
        <span className="tc">{timecode(t, FPS)}</span>
        <span className="tc-dur">/ {timecode(dur, FPS)}</span>
        {playing && rate !== 1 && <span className="rate">{rate > 0 ? `${rate}×` : `◀ ${Math.abs(rate)}×`}</span>}
      </div>
      <div className="tp-right">
        {viewer === 'reel' && reel && (
          <span className={`len-pill num${dur > 60 ? ' over' : ''}`} title="Reels must be 60 s or shorter">
            {dur.toFixed(1)} s {dur > 60 ? '· over 60' : ''}
          </span>
        )}
      </div>
    </div>
  )
}
