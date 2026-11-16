import { AudioLines, BookOpen, Captions, Clapperboard, Film, Image as ImageIcon, LayoutTemplate } from 'lucide-react'
import { useApp, type InspectorTab } from '@/state/app'
import { useReel } from '@/state/editor'
import { Empty } from '../ui'
import { ReelPanel } from './ReelPanel'
import { ClipPanel } from './ClipPanel'
import { CaptionPanel } from './CaptionPanel'
import { VersePanel, CutawayPanel } from './OverlayPanels'
import { AudioPanel } from './AudioPanel'
import { ThumbnailPanel } from './ThumbnailPanel'

const TABS: { id: InspectorTab; label: string; icon: typeof Film }[] = [
  { id: 'reel', label: 'Reel', icon: Clapperboard },
  { id: 'clip', label: 'Clip', icon: Film },
  { id: 'caption', label: 'Caption', icon: Captions },
  { id: 'verse', label: 'Verse', icon: BookOpen },
  { id: 'cutaway', label: 'Cutaway', icon: ImageIcon },
  { id: 'audio', label: 'Audio', icon: AudioLines },
  { id: 'thumbnail', label: 'Thumbnail', icon: LayoutTemplate }
]

export function Inspector() {
  const tab = useApp((s) => s.inspectorTab)
  const set = useApp((s) => s.set)
  const reel = useReel()
  const current = TABS.find((t) => t.id === tab) ?? TABS[0]
  return (
    <div className="panel inspector">
      <div className="insp-tabs" role="tablist" aria-label="Inspector">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === tab} className={t.id === tab ? 'on' : ''} title={t.label} onClick={() => set({ inspectorTab: t.id })}>
            <t.icon size={14} strokeWidth={1.9} aria-hidden />
          </button>
        ))}
      </div>
      <div className="insp-title">
        <current.icon size={13} aria-hidden />
        <span>{current.label}</span>
      </div>
      <div className="panel-body insp-body">
        {!reel ? (
          <Empty icon={Clapperboard} title="Nothing selected">
            Open a reel to inspect it.
          </Empty>
        ) : (
          <>
            {tab === 'reel' && <ReelPanel reel={reel} />}
            {tab === 'clip' && <ClipPanel reel={reel} />}
            {tab === 'caption' && <CaptionPanel reel={reel} />}
            {tab === 'verse' && <VersePanel reel={reel} />}
            {tab === 'cutaway' && <CutawayPanel reel={reel} />}
            {tab === 'audio' && <AudioPanel reel={reel} />}
            {tab === 'thumbnail' && <ThumbnailPanel reel={reel} />}
          </>
        )}
      </div>
    </div>
  )
}
