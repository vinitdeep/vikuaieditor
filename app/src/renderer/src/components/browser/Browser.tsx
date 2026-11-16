import { BookOpen, FolderOpen, Images, ScrollText, Sparkles } from 'lucide-react'
import { useApp, type BrowserTab } from '@/state/app'
import { useEditor } from '@/state/editor'
import { Tabs } from '../ui'
import { MediaTab } from './MediaTab'
import { TranscriptTab } from './TranscriptTab'
import { SuggestionsTab } from './SuggestionsTab'
import { LibraryTab } from './LibraryTab'
import { BibleTab } from './BibleTab'

export function Browser() {
  const tab = useApp((s) => s.browserTab)
  const set = useApp((s) => s.set)
  const nCands = useEditor((s) => s.candidates.filter((c) => !s.rejected.includes(c.id)).length)
  const tabs: { id: BrowserTab; label: string; icon: typeof FolderOpen; badge?: React.ReactNode }[] = [
    { id: 'media', label: 'Media', icon: FolderOpen },
    { id: 'transcript', label: 'Transcript', icon: ScrollText },
    { id: 'suggestions', label: 'Suggestions', icon: Sparkles, badge: nCands ? <span className="tab-badge num">{nCands}</span> : undefined },
    { id: 'library', label: 'Library', icon: Images },
    { id: 'bible', label: 'Bible', icon: BookOpen }
  ]
  return (
    <div className="panel browser">
      <Tabs className="panel-tabs" value={tab} tabs={tabs} onChange={(v) => set({ browserTab: v })} />
      <div className="panel-body">
        {tab === 'media' && <MediaTab />}
        {tab === 'transcript' && <TranscriptTab />}
        {tab === 'suggestions' && <SuggestionsTab />}
        {tab === 'library' && <LibraryTab />}
        {tab === 'bible' && <BibleTab />}
      </div>
    </div>
  )
}
