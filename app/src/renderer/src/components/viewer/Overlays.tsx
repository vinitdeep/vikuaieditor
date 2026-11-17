// HTML preview of the house style, drawn in a 1080×1920 coordinate space (scaled by the stage).
import type { Reel } from '@/api/types'
import { api } from '@/api'
import { scriptFont } from '@/lib/lang'
import { Sparkles } from 'lucide-react'
import { Thumb } from '../ui'
import { cutawayName } from '@/lib/cutaways'

export const TRANS = 0.7 // cross-zoom dissolve seconds

const ease = (x: number): number => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3)

/** How much the base video should push in/blur because a cutaway is entering/leaving. */
export function cutawayInfluence(reel: Reel, t: number): { push: number } {
  let push = 0
  for (const c of reel.cutaways) {
    if (!c.img) continue
    if (t >= c.t0 && t < c.t0 + TRANS) push = Math.max(push, ease((t - c.t0) / TRANS))
    if (t >= c.t1 - TRANS && t < c.t1) push = Math.max(push, 1 - ease((t - (c.t1 - TRANS)) / TRANS))
    if (t >= c.t0 + TRANS && t < c.t1 - TRANS) push = 1
  }
  return { push }
}

export function CutawayLayer({ reel, t }: { reel: Reel; t: number }) {
  return (
    <>
      {reel.cutaways.map((c, i) => {
        if (t < c.t0 || t >= c.t1) return null
        if (!c.img) {
          return (
            <div key={i} className="ov-need">
              <Sparkles size={64} aria-hidden />
              <b>Needs image</b>
              {cutawayName(c) && <span>{cutawayName(c)}</span>}
            </div>
          )
        }
        const len = Math.max(0.01, c.t1 - c.t0)
        const p = (t - c.t0) / len
        const z = c.z0 + (c.z1 - c.z0) * p
        const inP = ease((t - c.t0) / TRANS)
        const outP = t > c.t1 - TRANS ? ease((t - (c.t1 - TRANS)) / TRANS) : 0
        const scale = z * (1 + 0.08 * (1 - inP)) * (1 + 0.1 * outP)
        const blur = 10 * (1 - inP) + 10 * outP
        const opacity = Math.min(inP, 1 - outP)
        // the engine stores pan in output pixels (e.g. [50, -60]); older UI data used 0..1 fractions
        const px = Math.abs(c.pan[0]) > 1 || Math.abs(c.pan[1]) > 1
        const tx = (px ? c.pan[0] : c.pan[0] * 1080) * p
        const ty = (px ? c.pan[1] : c.pan[1] * 1920) * p
        return (
          <div
            key={i}
            className="ov-cutaway"
            style={{ opacity, filter: blur > 0.2 ? `blur(${blur.toFixed(1)}px)` : undefined, transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
          >
            <Thumb src={api().mediaUrl(c.img)} alt="" seed={i + 3} />
          </div>
        )
      })}
    </>
  )
}

export function TitleHook({ reel, t }: { reel: Reel; t: number }) {
  if (t < 0.2 || t > 4.2 || !reel.title) return null
  const a = Math.min(ease((t - 0.2) / 0.35), 1 - ease((t - 3.85) / 0.35))
  const style = reel.style.title_style
  return (
    <div className={`ov-title ts-${style}`} style={{ opacity: a, transform: `translateY(${(1 - a) * -24}px)`, fontFamily: scriptFont(reel.language) }}>
      <div className="ov-title-main">{reel.title}</div>
      {reel.sub && <div className="ov-title-sub">{reel.sub}</div>}
    </div>
  )
}

export function CaptionLayer({ reel, t, selected }: { reel: Reel; t: number; selected?: number }) {
  const i = reel.captions.findIndex((c) => t >= c.t0 && t < c.t1)
  if (i < 0) return null
  const c = reel.captions[i]
  return (
    <div className={`ov-caption${selected === i ? ' sel' : ''}`} style={{ fontFamily: scriptFont(reel.language), fontSize: reel.style.caption_size }}>
      <span>{c.text}</span>
    </div>
  )
}

export function VerseLayer({ reel, t }: { reel: Reel; t: number }) {
  return (
    <>
      {reel.verses.map((v, i) => {
        if (t < v.t0 || t >= v.t1) return null
        const a = Math.min(ease((t - v.t0) / 0.35), 1 - ease((t - (v.t1 - 0.35)) / 0.35))
        return (
          <div key={i} className="ov-verse" style={{ top: v.top_y, opacity: a, transform: `translateY(${(1 - a) * 18}px)` }}>
            <div className="ov-verse-text" style={{ fontFamily: scriptFont(reel.language) }}>
              {v.text}
            </div>
            <div className="ov-verse-ref" style={{ fontFamily: scriptFont(reel.language) }}>
              {v.ref}
            </div>
          </div>
        )
      })}
    </>
  )
}

export function CreditLine({ text }: { text: string }) {
  if (!text) return null
  return <div className="ov-credit">{text}</div>
}

export function SafeZones() {
  return (
    <div className="ov-safe" aria-hidden>
      <div className="sz sz-top">
        <span>Top UI · 220</span>
      </div>
      <div className="sz sz-bottom">
        <span>Caption / description zone</span>
      </div>
      <div className="sz sz-right">
        <span>Actions</span>
      </div>
      <div className="sz-line" style={{ top: 1920 - 400 }} />
      <div className="sz-center-v" />
      <div className="sz-center-h" />
    </div>
  )
}
