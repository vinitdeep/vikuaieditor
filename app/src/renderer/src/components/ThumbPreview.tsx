import type { Reel } from '@/api/types'
import { api } from '@/api'
import { scriptFont } from '@/lib/lang'
import { Thumb } from './ui'

/** HTML mock of the thumbnail templates (the engine renders the real jpg). */
export function ThumbPreview({ reel, width = 180, image }: { reel: Pick<Reel, 'thumbnail' | 'language' | 'cutaways'>; width?: number; image?: string }) {
  const th = reel.thumbnail
  const img = image ?? reel.cutaways[0]?.img
  const font = scriptFont(reel.language)
  return (
    <div className={`thumbp tp-${th.style}`} style={{ width, height: (width * 16) / 9, fontSize: width / 10 }}>
      {img ? <Thumb className="thumbp-bg" src={api().mediaUrl(img)} alt="" seed={7} /> : <span className="thumbp-bg thumb-ph" />}
      <span className="thumbp-shade" />
      <span className="thumbp-speaker" aria-hidden />
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
