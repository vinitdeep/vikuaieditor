import { AudioLines, Mic, Music2, Trash2, X } from 'lucide-react'
import type { Reel } from '@/api/types'
import { useApp } from '@/state/app'
import { useEditor } from '@/state/editor'
import { Button, IconButton, Section, Slider } from '../ui'
import { Row, TimeField } from './common'

const db = (v: number): string => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`

export function AudioPanel({ reel }: { reel: Reel }) {
  const edit = useEditor((s) => s.edit)
  const selection = useEditor((s) => s.selection)
  const sel = selection?.kind === 'sfx' ? selection.index : -1
  return (
    <>
      <Section title="Voice">
        <Row label="Gain">
          <Slider value={reel.style.voice_gain_db ?? 0} min={-12} max={12} step={0.5} reset={0} format={db} onChange={(v) => edit('Voice gain', (r) => void (r.style.voice_gain_db = v), 'voice-gain')} ariaLabel="Voice gain" />
        </Row>
        <p className="rule-note small">
          <Mic size={11} aria-hidden /> Speech enhancement (DeepFilterNet3) runs on every reel. Final mix: −14 LUFS, −1.5 dBTP.
        </p>
      </Section>
      <Section title="Music" right={reel.music ? <IconButton icon={X} label="Remove music" onClick={() => edit('Remove music', (r) => void (r.music = null))} /> : undefined}>
        {reel.music ? (
          <>
            <div className="music-name">
              <Music2 size={13} aria-hidden />
              <span className="ellipsis">{reel.music.path.split(/[\\/]/).pop()}</span>
            </div>
            <Row label="Level">
              <Slider value={reel.music.gain_db} min={-36} max={-6} step={0.5} reset={-19} format={db} onChange={(v) => edit('Music level', (r) => void (r.music && (r.music.gain_db = v)), 'music-gain')} ariaLabel="Music level" />
            </Row>
            <Row label="Ducking">
              <Slider value={reel.music.duck_db ?? -8} min={-20} max={0} step={0.5} reset={-8} format={db} onChange={(v) => edit('Music ducking', (r) => void (r.music && (r.music.duck_db = v)), 'music-duck')} ariaLabel="Ducking under voice" />
            </Row>
            <Row label="Start at">
              <TimeField label="Music start offset" value={reel.music.start} onChange={(v) => edit('Music start', (r) => void (r.music && (r.music.start = v)), 'music-start')} />
            </Row>
          </>
        ) : (
          <div className="row gap">
            <span className="muted small grow">No music bed.</span>
            <Button size="sm" icon={Music2} onClick={() => useApp.getState().set({ browserTab: 'library', libraryTab: 'music' })}>
              Choose music
            </Button>
          </div>
        )}
      </Section>
      <Section title={`Sound effects (${reel.sfx.length})`}>
        {reel.sfx.map((s, i) => (
          <div key={i} className={`sfx-row${i === sel ? ' on' : ''}`}>
            <AudioLines size={12} aria-hidden />
            <span className="sfx-name ellipsis">{s.name.replace(/_/g, ' ')}</span>
            <TimeField label="SFX time" value={s.t} onChange={(v) => edit('SFX time', (r) => void (r.sfx[i].t = v), `sfx-t-${i}`)} />
            <IconButton icon={Trash2} label="Remove SFX" onClick={() => edit('Remove SFX', (r) => void r.sfx.splice(i, 1))} />
            <div className="sfx-gain">
              <Slider value={s.gain_db} min={-30} max={0} step={0.5} reset={-10} format={db} onChange={(v) => edit('SFX level', (r) => void (r.sfx[i].gain_db = v), `sfx-g-${i}`)} ariaLabel="SFX level" />
            </div>
          </div>
        ))}
        {!reel.sfx.length && <span className="muted small">Drag SFX from Library onto the SFX track.</span>}
      </Section>
    </>
  )
}
