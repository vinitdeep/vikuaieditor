import { useEffect, useRef, useState } from 'react'
import type { Project, Reel } from '@/api/types'
import { api } from '@/api'
import { scriptFont } from '@/lib/lang'
import { mediaSources, pickSource } from '@/lib/media'
import { cropFor, poseTime, reelToSource } from '@/lib/reel'
import { Thumb } from './ui'

type ThumbReel = Pick<Reel, 'thumbnail' | 'language' | 'cutaways'> & Partial<Pick<Reel, 'segments' | 'crops'>>

/** The speaker at the thumbnail's pose time, framed with that segment's fixed crop. */
function PoseFrame({ project, reel, width, height }: { project: Project; reel: ThumbReel & Pick<Reel, 'segments' | 'crops'>; width: number; height: number }) {
  const { src, index } = reelToSource(reel, poseTime(reel))
  const crop = cropFor(reel, Math.max(0, index))
  const m = pickSource(mediaSources(project), src)
  const ref = useRef<HTMLVideoElement>(null)
  const [vs, setVs] = useState<{ w: number; h: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const offset = m?.offset ?? 0
  useEffect(() => {
    const v = ref.current
    if (v && v.readyState >= 1) v.currentTime = Math.max(0, src - offset)
  }, [src, offset])
  if (!m || failed) return null
  let style: React.CSSProperties = { opacity: 0 }
  if (vs) {
    const s = (width / Math.max(1, crop.cw * vs.w)) * crop.z
    const w = vs.w * s
    const h = vs.h * s
    style = { left: width / 2 - crop.cx * vs.w * s, top: height / 2 - h / 2, width: w, height: h, opacity: 1 }
  }
  return (
    <video
      ref={ref}
      className="thumbp-pose"
      style={style}
      src={m.url}
      muted
      preload="auto"
      playsInline
      onLoadedMetadata={(e) => {
        const v = e.currentTarget
        setVs({ w: v.videoWidth || 1280, h: v.videoHeight || 720 })
        v.currentTime = Math.max(0, src - m.offset)
      }}
      onError={() => setFailed(true)}
    />
  )
}

/** HTML mock of the thumbnail templates (the engine renders the real jpg). */
export function ThumbPreview({ reel, width = 180, image, project }: { reel: ThumbReel; width?: number; image?: string; project?: Project | null }) {
  const th = reel.thumbnail
  const height = (width * 16) / 9
  const img = image ?? reel.cutaways[0]?.img
  const font = scriptFont(reel.language)
  const pose = project && reel.segments && reel.segments.length && reel.crops ? { ...reel, segments: reel.segments, crops: reel.crops } : null
  return (
    <div className={`thumbp tp-${th.style}`} style={{ width, height, fontSize: width / 10 }}>
      {pose && project ? (
        <PoseFrame project={project} reel={pose} width={width} height={height} />
      ) : img ? (
        <Thumb className="thumbp-bg" src={api().mediaUrl(img)} alt="" seed={7} />
      ) : (
        <span className="thumbp-bg thumb-ph" />
      )}
      <span className="thumbp-shade" />
      <span className="thumbp-text" style={{ fontFamily: font }}>
        <span className="thumbp-title">{th.title}</span>
        {th.sub && <span className="thumbp-sub">{th.sub}</span>}
      </span>
      {th.verse && (
        <span className="thumbp-verse" style={{ fontFamily: font }}>
          {th.verse}
        </span>
      )}
    </div>
  )
}
