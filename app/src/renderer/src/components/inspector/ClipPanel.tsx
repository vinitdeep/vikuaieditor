import { Film, MonitorPlay, Scissors, Trash2 } from 'lucide-react'
import type { Reel } from '@/api/types'
import { useEditor } from '@/state/editor'
import { usePlayback } from '@/state/playback'
import { DEFAULT_CW, bladeAt, cropFor, ensureCrops, isFollowing, layout, placedAt, rippleDelete, trimSegment } from '@/lib/reel'
import { duration, timecode } from '@/lib/time'
import { Button, Empty, Section, Segmented, Slider } from '../ui'
import { Row, TimeField } from './common'
import { FramingSwitch } from './FramingSwitch'

export function ClipPanel({ reel }: { reel: Reel }) {
  const selection = useEditor((s) => s.selection)
  const edit = useEditor((s) => s.edit)
  const select = useEditor((s) => s.select)
  const srcDur = useEditor((s) => s.project?.duration ?? 0)
  const t = usePlayback((s) => s.t)
  const placed = layout(reel.segments)
  const idx = selection?.kind === 'segment' ? selection.index : (placedAt(placed, t)?.index ?? -1)
  const p = placed[idx]
  if (!p) return <Empty icon={Film} title="No segment">Click a segment on the Video track.</Empty>
  const crop = cropFor(reel, idx)

  const following = isFollowing(reel)
  const nudge = crop.cx - (crop.ax ?? crop.cx)

  const setCrop = (patch: Partial<{ cx: number; cw: number; z: number }>, key: string): void =>
    edit(
      'Crop',
      (r) => {
        ensureCrops(r)
        Object.assign(r.crops[idx], patch)
        const c = r.crops[idx]
        if (!following) c.cx = Math.min(1 - c.cw / 2, Math.max(c.cw / 2, c.cx))
      },
      `${key}-${idx}`
    )
  /** auto framing: move the whole follow of this segment left / right (cx = ax + nudge) */
  const setNudge = (v: number): void =>
    edit(
      'Nudge framing',
      (r) => {
        ensureCrops(r)
        const c = r.crops[idx]
        if (c.ax === undefined) c.ax = c.cx
        c.cx = Math.round((c.ax + v) * 1000) / 1000
      },
      `nudge-${idx}`
    )

  return (
    <>
      <Section title={`Segment ${idx + 1} of ${placed.length}`}>
        <Row label="Source in">
          <TimeField label="Source in" value={p.src[0]} max={p.src[1] - 0.25} onChange={(v) => edit('Trim in', (r) => trimSegment(r, idx, 'in', v, srcDur), `trim-in-${idx}`)} />
        </Row>
        <Row label="Source out">
          <TimeField label="Source out" value={p.src[1]} min={p.src[0] + 0.25} max={srcDur || 1e9} onChange={(v) => edit('Trim out', (r) => trimSegment(r, idx, 'out', v, srcDur), `trim-out-${idx}`)} />
        </Row>
        <Row label="Duration">
          <span className="num">{duration(p.t1 - p.t0)}</span>
        </Row>
        <Row label="In reel">
          <span className="num muted">
            {timecode(p.t0)} → {timecode(p.t1)}
          </span>
        </Row>
        <div className="row gap wrap">
          <Button size="sm" icon={MonitorPlay} onClick={() => usePlayback.setState({ viewer: 'source', srcT: p.src[0], playing: false, preview: null })}>
            Show in source
          </Button>
          <Button
            size="sm"
            icon={Scissors}
            onClick={() => {
              const at = t > p.t0 + 0.3 && t < p.t1 - 0.3 ? t : (p.t0 + p.t1) / 2
              edit('Blade', (r) => void bladeAt(r, at))
            }}
          >
            Split
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={Trash2}
            onClick={() => {
              edit('Ripple delete', (r) => rippleDelete(r, idx))
              select(null)
            }}
          >
            Delete
          </Button>
        </div>
      </Section>

      <Section title="Framing">
        <FramingSwitch reel={reel} />
        {following ? (
          <Row label="Nudge">
            <Slider value={nudge} min={-0.2} max={0.2} step={0.001} reset={0} format={(v) => (Math.abs(v) < 0.0005 ? 'centred' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}`)} onChange={setNudge} ariaLabel="Framing nudge" />
          </Row>
        ) : (
          <Row label="Centre X">
            <Slider value={crop.cx} min={crop.cw / 2} max={1 - crop.cw / 2} step={0.001} reset={0.5} format={(v) => v.toFixed(3)} onChange={(v) => setCrop({ cx: v }, 'cx')} ariaLabel="Crop centre" />
          </Row>
        )}
        <Row label="Width">
          <Slider value={crop.cw} min={DEFAULT_CW} max={1} step={0.001} reset={DEFAULT_CW} format={(v) => (Math.abs(v - DEFAULT_CW) < 0.002 ? '9:16' : v.toFixed(3))} onChange={(v) => setCrop({ cw: v }, 'cw')} ariaLabel="Crop width" />
        </Row>
        <Row label="Punch-in">
          <Segmented
            size="sm"
            ariaLabel="Punch-in"
            value={crop.z === 1 ? '1' : crop.z === 1.12 ? '1.12' : 'custom'}
            onChange={(v) => v !== 'custom' && setCrop({ z: Number(v) }, 'z-preset')}
            options={[
              { id: '1', label: '1.00' },
              { id: '1.12', label: '1.12' },
              { id: 'custom', label: 'Custom' }
            ]}
          />
        </Row>
        <Row label="Zoom">
          <Slider value={crop.z} min={1} max={1.4} step={0.01} reset={1} format={(v) => `${v.toFixed(2)}×`} onChange={(v) => setCrop({ z: v }, 'z')} ariaLabel="Punch-in zoom" />
        </Row>
        <p className="rule-note small">
          {following
            ? 'Auto framing pans the crop with the speaker so they stay centred; it resets at every cut. Nudge shifts this segment’s framing left / right. Jump cuts alternate 1.00 / 1.12.'
            : 'One still crop per segment. Wider than 9:16 scales to width over a blurred fill. Jump cuts alternate 1.00 / 1.12.'}
        </p>
      </Section>
    </>
  )
}
