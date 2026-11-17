import { ScanFace } from 'lucide-react'
import { api } from '@/api'
import type { Framing, Reel } from '@/api/types'
import { toast } from '@/state/app'
import { saveNow, useEditor } from '@/state/editor'
import { useJobs } from '@/state/jobs'
import { setFraming } from '@/lib/reel'
import { Button, Segmented } from '../ui'
import { Row } from './common'

/** reel id -> its running "track the speaker" job */
const trackJobs = new Map<string, string>()

/** Track the speaker for auto framing only; captions, cutaways and music are left alone. */
export async function trackSpeaker(reel: Reel): Promise<void> {
  try {
    await saveNow() // the engine reads the saved project
    const ref = await api().trackFraming(reel.id)
    trackJobs.set(reel.id, ref.job)
    useJobs.getState().track(ref, `Auto framing · ${reel.title}`, {
      onDone: () => {
        void useEditor.getState().refresh()
        toast('success', 'Auto framing on — the crop now follows the speaker')
      }
    })
  } catch (e) {
    toast('error', `Auto framing failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Reel-wide framing mode: auto framing (crop follows the speaker) or one still crop per shot. */
export function FramingSwitch({ reel }: { reel: Reel }) {
  const edit = useEditor((s) => s.edit)
  const jobId = trackJobs.get(reel.id)
  const job = useJobs((s) => (jobId ? s.jobs[jobId] : undefined))
  const tracking = job && (job.state === 'running' || job.state === 'queued')
  const noPaths = reel.framing === 'follow' && reel.follow.length === 0
  return (
    <>
      <Row label="Auto framing">
        <Segmented
          size="sm"
          ariaLabel="Framing mode"
          value={reel.framing}
          onChange={(v: Framing) => edit(v === 'follow' ? 'Auto framing on' : 'Auto framing off', (r) => setFraming(r, v))}
          options={[
            { id: 'follow', label: 'Follow speaker' },
            { id: 'fixed', label: 'Fixed' }
          ]}
        />
      </Row>
      {(noPaths || tracking) && (
        <div className="framing-note">
          <span className="small muted">
            {tracking ? `${Math.round((job?.progress ?? 0) * 100)}% · ${job?.message || 'finding the speaker'}` : 'This reel was made before auto framing. Track the speaker once to turn it on — captions and pictures stay as they are.'}
          </span>
          {!tracking && (
            <Button size="sm" icon={ScanFace} onClick={() => void trackSpeaker(reel)}>
              Track speaker
            </Button>
          )}
        </div>
      )}
    </>
  )
}
