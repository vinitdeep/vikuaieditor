import { Crosshair, ImageDown } from 'lucide-react'
import { api } from '@/api'
import type { Reel } from '@/api/types'
import { toast } from '@/state/app'
import { useEditor } from '@/state/editor'
import { useJobs } from '@/state/jobs'
import { usePlayback } from '@/state/playback'
import { reelDuration } from '@/lib/reel'
import { Button, Field, Section, Segmented, TextInput } from '../ui'
import { ThumbPreview } from '../ThumbPreview'
import { Row, TimeField } from './common'

export function ThumbnailPanel({ reel }: { reel: Reel }) {
  const edit = useEditor((s) => s.edit)
  const th = reel.thumbnail
  const generate = async (): Promise<void> => {
    try {
      const ref = await api().thumbnail(reel.id)
      useJobs.getState().track(ref, `Thumbnail · ${reel.title}`, { onDone: () => toast('success', 'Thumbnail rendered to exports') })
    } catch (e) {
      toast('error', `Thumbnail failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return (
    <>
      <Section title="Preview">
        <div className="thumb-stage">
          <ThumbPreview reel={reel} width={168} />
        </div>
        <Row label="Style">
          <Segmented
            size="sm"
            ariaLabel="Thumbnail style"
            value={th.style}
            onChange={(v) => edit('Thumbnail style', (r) => void (r.thumbnail.style = v))}
            options={[
              { id: 'bold-gold', label: 'Bold gold' },
              { id: 'clean-white', label: 'Clean' },
              { id: 'verse-card', label: 'Verse' }
            ]}
          />
        </Row>
      </Section>
      <Section title="Content">
        <Field label="Title">
          <TextInput lang={reel.language} value={th.title} onCommit={(v) => edit('Thumbnail title', (r) => void (r.thumbnail.title = v))} aria-label="Thumbnail title" />
        </Field>
        <Field label="Sub">
          <TextInput lang={reel.language} value={th.sub} onCommit={(v) => edit('Thumbnail sub', (r) => void (r.thumbnail.sub = v))} aria-label="Thumbnail sub" />
        </Field>
        <Field label="Verse">
          <TextInput lang={reel.language} value={th.verse} placeholder="Optional reference" onCommit={(v) => edit('Thumbnail verse', (r) => void (r.thumbnail.verse = v))} aria-label="Thumbnail verse" />
        </Field>
        <Row label="Pose frame">
          <span className="row gap">
            <TimeField label="Pose time" value={th.pose_t} max={reelDuration(reel)} onChange={(v) => edit('Pose time', (r) => void (r.thumbnail.pose_t = v), 'pose')} />
            <Button size="sm" variant="ghost" icon={Crosshair} title="Use the playhead frame" onClick={() => edit('Pose time', (r) => void (r.thumbnail.pose_t = Math.round(usePlayback.getState().t * 100) / 100))}>
              Playhead
            </Button>
          </span>
        </Row>
        <Button variant="primary" icon={ImageDown} onClick={() => void generate()}>
          Render thumbnail
        </Button>
      </Section>
    </>
  )
}
