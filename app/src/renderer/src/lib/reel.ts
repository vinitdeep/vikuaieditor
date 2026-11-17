// Reel timeline math. Segments are absolute source seconds in play order; everything else is reel seconds.
import type { Caption, Crop, Cutaway, FollowTrack, Framing, Reel, Seg, Sfx, Verse } from '@/api/types'

export interface Placed {
  index: number
  src: Seg
  t0: number
  t1: number
}

export const DEFAULT_CW = 0.316 // 9:16 window of a 16:9 frame
export const MIN_SEG = 0.25
/** samples / s of the engine's auto-framing follow paths (media/framing.py FOLLOW_RATE) */
export const FOLLOW_RATE = 10

export type CropView = Pick<Crop, 'cx' | 'cw' | 'z' | 'ax'>
type Framed = Pick<Reel, 'crops' | 'segments'> & Partial<Pick<Reel, 'framing' | 'follow'>>

export function layout(segments: Seg[]): Placed[] {
  let acc = 0
  return segments.map((s, index) => {
    const len = Math.max(0, s[1] - s[0])
    const p = { index, src: s, t0: acc, t1: acc + len }
    acc += len
    return p
  })
}

export function reelDuration(reel: Pick<Reel, 'segments'>): number {
  return reel.segments.reduce((a, [s, e]) => a + Math.max(0, e - s), 0)
}

export function placedAt(placed: Placed[], t: number): Placed | null {
  if (!placed.length) return null
  for (const p of placed) if (t >= p.t0 && t < p.t1) return p
  return t < 0 ? placed[0] : placed[placed.length - 1]
}

export function reelToSource(reel: Pick<Reel, 'segments'>, t: number): { src: number; index: number } {
  const placed = layout(reel.segments)
  const p = placedAt(placed, t)
  if (!p) return { src: 0, index: -1 }
  const off = Math.min(p.t1 - p.t0, Math.max(0, t - p.t0))
  return { src: p.src[0] + off, index: p.index }
}

const view = (c: Crop): CropView => (c.ax === undefined ? { cx: c.cx, cw: c.cw, z: c.z } : { cx: c.cx, cw: c.cw, z: c.z, ax: c.ax })

export function cropFor(reel: Pick<Reel, 'crops' | 'segments'>, index: number): CropView {
  const placed = layout(reel.segments)
  const p = placed[index]
  const c = p ? reel.crops.find((c) => c.t0 <= p.t0 + 0.01 && c.t1 >= p.t1 - 0.01) ?? reel.crops[index] : reel.crops[index]
  return c ? view(c) : { cx: 0.5, cw: DEFAULT_CW, z: index % 2 ? 1.12 : 1 }
}

/** Auto-framing camera centre (0..1) at a source second, or null where no follow path covers it. */
export function followAt(tracks: FollowTrack[] | undefined, srcT: number): number | null {
  let best: FollowTrack | null = null
  for (const tr of tracks ?? []) {
    if (tr.s - 1e-3 <= srcT && srcT < tr.e + 1e-3 && (!best || tr.s > best.s)) best = tr
  }
  if (!best || !best.x.length) return null
  const u = Math.min(Math.max((srcT - best.s) * FOLLOW_RATE, 0), best.x.length - 1)
  const i = Math.floor(u)
  const j = Math.min(i + 1, best.x.length - 1)
  return best.x[i] + (best.x[j] - best.x[i]) * (u - i)
}

/** The crop centre actually framed at a source second: fixed cx, or with auto framing the follow path + nudge. */
export function framedCx(reel: Partial<Pick<Reel, 'framing' | 'follow'>>, c: CropView, srcT: number): number {
  if (reel.framing !== 'follow') return c.cx
  const f = followAt(reel.follow, srcT)
  if (f === null) return c.cx
  const x = f + (c.cx - (c.ax ?? c.cx))
  return Math.min(1 - c.cw / 2, Math.max(c.cw / 2, x))
}

/** True when the reel follows the speaker and has paths to follow (older reels need an Auto-build first). */
export function isFollowing(reel: Partial<Pick<Reel, 'framing' | 'follow'>>): boolean {
  return reel.framing === 'follow' && (reel.follow?.length ?? 0) > 0
}

export function cropAt(reel: Framed, t: number): CropView {
  const found = reel.crops.find((c) => t >= c.t0 && t < c.t1)
  const { src, index } = reelToSource(reel, t)
  const c = found ? view(found) : cropFor(reel, Math.max(0, index))
  return reel.framing === 'follow' ? { ...c, cx: framedCx(reel, c, src) } : c
}

/**
 * Switch the reel between auto framing and still crops. To 'follow': every crop becomes a tight 9:16 window on its
 * follow anchor (manual nudges are cleared). To 'fixed': crops keep their centre and width.
 */
export function setFraming(reel: Reel, mode: Framing): void {
  reel.framing = mode
  if (mode !== 'follow') return
  for (const c of reel.crops) {
    if (c.ax !== undefined) c.cx = c.ax
    c.cw = DEFAULT_CW
  }
}

export function editPoints(reel: Pick<Reel, 'segments'>): number[] {
  const placed = layout(reel.segments)
  const pts = new Set<number>([0])
  for (const p of placed) {
    pts.add(round(p.t0))
    pts.add(round(p.t1))
  }
  return [...pts].sort((a, b) => a - b)
}

export const round = (n: number): number => Math.round(n * 1000) / 1000

export function activeAt<T extends { t0: number; t1: number }>(items: T[], t: number): { item: T; index: number } | null {
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (t >= it.t0 && t < it.t1) return { item: it, index: i }
  }
  return null
}

// ---------------- structural edits (mutate a draft) ----------------

export interface SegRef {
  old: number
  src: Seg
  crop: CropView
}

interface Anchor {
  old: number
  srcT: number
}

/**
 * Re-lays the reel after any change to the segment list, keeping captions / verses / cutaways / sfx glued
 * to the source moment they cover (magnetic timeline). Items whose segment vanished are dropped.
 */
export function restructure(reel: Reel, fn: (refs: SegRef[]) => SegRef[]): void {
  const placed = layout(reel.segments)
  const anchorOf = (t: number): Anchor | null => {
    const p = placedAt(placed, t)
    return p ? { old: p.index, srcT: p.src[0] + (t - p.t0) } : null
  }
  const refs: SegRef[] = reel.segments.map((s, i) => ({ old: i, src: [s[0], s[1]], crop: cropFor(reel, i) }))
  const span = <T extends { t0: number; t1: number }>(xs: T[]) => xs.map((item) => ({ item, a: anchorOf(item.t0 + 0.0005), d: item.t1 - item.t0 }))
  const caps = span<Caption>(reel.captions)
  const verses = span<Verse>(reel.verses)
  const cuts = span<Cutaway>(reel.cutaways)
  const sfx = reel.sfx.map((item) => ({ item, a: anchorOf(item.t + 0.0005) }))

  const next = fn(refs)
  reel.segments = next.map((r) => [round(r.src[0]), round(r.src[1])] as Seg)
  const np = layout(reel.segments)
  reel.crops = next.map((r, i) => ({ t0: round(np[i].t0), t1: round(np[i].t1), ...r.crop }))

  const relocate = (a: Anchor | null): number | null => {
    if (!a) return null
    const cands = next.map((r, i) => ({ r, i })).filter(({ r }) => r.old === a.old)
    if (!cands.length) return null
    const hit = cands.find(({ r }) => a.srcT >= r.src[0] - 0.001 && a.srcT <= r.src[1] + 0.001)
    if (hit) return np[hit.i].t0 + (a.srcT - hit.r.src[0])
    // trimmed away: clamp to the nearest surviving piece of the same segment
    let best = cands[0]
    let bestD = Infinity
    for (const c of cands) {
      const d = Math.min(Math.abs(a.srcT - c.r.src[0]), Math.abs(a.srcT - c.r.src[1]))
      if (d < bestD) {
        bestD = d
        best = c
      }
    }
    return a.srcT < best.r.src[0] ? np[best.i].t0 : np[best.i].t1 - 0.05
  }
  const total = reelDuration(reel)
  const place = <T extends { t0: number; t1: number }>(xs: { item: T; a: Anchor | null; d: number }[]): T[] =>
    xs
      .map(({ item, a, d }) => {
        const t0 = relocate(a)
        if (t0 === null) return null
        const s = round(Math.max(0, t0))
        return { ...item, t0: s, t1: round(Math.min(total, s + d)) }
      })
      .filter((x): x is T => x !== null && x.t1 - x.t0 > 0.05)
  reel.captions = place(caps)
  reel.verses = place(verses)
  reel.cutaways = place(cuts)
  reel.sfx = sfx
    .map(({ item, a }) => {
      const t = relocate(a)
      return t === null ? null : { ...item, t: round(Math.max(0, t)) }
    })
    .filter((x): x is Sfx => x !== null)
}

/** Blade: split the segment under reel time t. */
export function bladeAt(reel: Reel, t: number): boolean {
  const placed = layout(reel.segments)
  const p = placedAt(placed, t)
  if (!p) return false
  const cut = p.src[0] + (t - p.t0)
  if (cut - p.src[0] < MIN_SEG || p.src[1] - cut < MIN_SEG) return false
  restructure(reel, (refs) => {
    const r = refs[p.index]
    const a: SegRef = { old: r.old, src: [r.src[0], cut], crop: { ...r.crop } }
    const b: SegRef = { old: r.old, src: [cut, r.src[1]], crop: { ...r.crop, z: r.crop.z === 1 ? 1.12 : 1 } }
    return [...refs.slice(0, p.index), a, b, ...refs.slice(p.index + 1)]
  })
  return true
}

export function rippleDelete(reel: Reel, index: number): void {
  restructure(reel, (refs) => refs.filter((_, i) => i !== index))
}

export function moveSegment(reel: Reel, from: number, to: number): void {
  if (from === to) return
  restructure(reel, (refs) => {
    const copy = refs.slice()
    const [m] = copy.splice(from, 1)
    copy.splice(to, 0, m)
    return copy
  })
}

export function trimSegment(reel: Reel, index: number, edge: 'in' | 'out', srcT: number, sourceDuration: number): void {
  restructure(reel, (refs) =>
    refs.map((r, i) => {
      if (i !== index) return r
      const [s, e] = r.src
      const src: Seg = edge === 'in' ? [Math.max(0, Math.min(srcT, e - MIN_SEG)), e] : [s, Math.min(sourceDuration || Infinity, Math.max(srcT, s + MIN_SEG))]
      return { ...r, src }
    })
  )
}

/** Blade for a timed item (caption): split text near the proportional character. */
export function splitCaption(c: Caption, t: number): [Caption, Caption] | null {
  if (t <= c.t0 + 0.2 || t >= c.t1 - 0.2) return null
  const frac = (t - c.t0) / (c.t1 - c.t0)
  const words = c.text.split(/\s+/)
  let k = Math.round(words.length * frac)
  k = Math.max(1, Math.min(words.length - 1, k))
  if (words.length < 2) return [{ ...c, t1: t, flags: [] }, { ...c, t0: t, flags: [] }]
  return [
    { t0: c.t0, t1: round(t), text: words.slice(0, k).join(' '), flags: [] },
    { t0: round(t), t1: c.t1, text: words.slice(k).join(' '), flags: [] }
  ]
}

export function snap(t: number, targets: number[], threshold: number): { t: number; snapped: number | null } {
  let best: number | null = null
  let bestD = threshold
  for (const s of targets) {
    const d = Math.abs(s - t)
    if (d < bestD) {
      bestD = d
      best = s
    }
  }
  return best === null ? { t, snapped: null } : { t: best, snapped: best }
}

/** 9:16 crop geometry of the fixed-crop framing in source-normalised units. */
export function cropRect(cx: number, cw: number, srcAspect = 16 / 9): { x: number; w: number; h: number; y: number } {
  const w = Math.min(1, cw)
  // height of the crop as a fraction of source height
  const h = Math.min(1, (w * srcAspect * 16) / 9)
  const x = Math.min(1 - w, Math.max(0, cx - w / 2))
  return { x, w, h, y: (1 - h) / 2 }
}

/** Make crops one-per-segment (aligned with layout) so a segment's crop can be edited by index. */
export function ensureCrops(reel: Reel): void {
  const placed = layout(reel.segments)
  const aligned = reel.crops.length === placed.length && reel.crops.every((c, i) => Math.abs(c.t0 - placed[i].t0) < 0.02 && Math.abs(c.t1 - placed[i].t1) < 0.02)
  if (aligned) return
  const next = placed.map((p, i) => ({ t0: round(p.t0), t1: round(p.t1), ...cropFor(reel, i) }))
  reel.crops = next
}

/** Thumbnail pose time; mirrors the engine default when unset. */
export function poseTime(reel: Pick<Reel, 'segments' | 'thumbnail'>): number {
  const dur = reelDuration(reel)
  if (reel.thumbnail.pose_t !== null) return reel.thumbnail.pose_t
  return Math.max(0, Math.min(Math.max(4.5, dur / 3), dur - 0.1))
}
