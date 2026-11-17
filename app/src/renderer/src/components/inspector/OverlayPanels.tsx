import { useEffect, useState } from 'react'
import { BookOpen, FolderOpen, Image as ImageIcon, Images, Plus, Search, Sparkles, Trash2 } from 'lucide-react'
import { api } from '@/api'
import type { Reel } from '@/api/types'
import { toast, useApp } from '@/state/app'
import { useEditor } from '@/state/editor'
import { usePlayback } from '@/state/playback'
import { activeAt, reelDuration } from '@/lib/reel'
import { generateForCutaway, genKey, useGen } from '@/lib/gemini'
import { cutawayName, cutawayPrompt } from '@/lib/cutaways'
import { Button, Empty, IconButton, Section, Slider, TextInput, Thumb } from '../ui'
import { Row, TimeField } from './common'

export function VersePanel({ reel }: { reel: Reel }) {
  const selection = useEditor((s) => s.selection)
  const edit = useEditor((s) => s.edit)
  const t = usePlayback((s) => s.t)
  const idx = selection?.kind === 'verse' ? selection.index : (activeAt(reel.verses, t)?.index ?? -1)
  const v = reel.verses[idx]
  const [ref, setRef] = useState(v?.ref ?? '')
  const [busy, setBusy] = useState(false)
  useEffect(() => setRef(v?.ref ?? ''), [v?.ref])

  const lookup = async (): Promise<void> => {
    setBusy(true)
    try {
      const found = await api().bibleVerse(ref, reel.language)
      if (!found) return toast('warn', `No verse found for “${ref}”`)
      edit('Verse lookup', (r) => {
        r.verses[idx].ref = found.ref
        r.verses[idx].text = found.text
      })
    } catch (e) {
      toast('error', `Lookup failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  if (!v) {
    return (
      <Empty icon={BookOpen} title="No verse card here">
        Verse cards sit in the upper half, on cutaways only. Insert one from the Bible tab.
        <div style={{ marginTop: 10 }}>
          <Button size="sm" icon={BookOpen} onClick={() => useApp.getState().set({ browserTab: 'bible' })}>
            Open Bible
          </Button>
        </div>
      </Empty>
    )
  }
  const onCutaway = reel.cutaways.some((c) => v.t0 >= c.t0 - 0.05 && v.t1 <= c.t1 + 0.05)
  return (
    <>
      <Section title={`Verse ${idx + 1} of ${reel.verses.length}`} right={<IconButton icon={Trash2} label="Delete verse" onClick={() => edit('Delete verse', (r) => void r.verses.splice(idx, 1))} />}>
        <div className="row gap">
          <TextInput lang={reel.language} className="grow" value={ref} onChange={setRef} aria-label="Reference" placeholder="e.g. ଯୋହନ ୩:୧୬ / John 3:16" />
          <Button size="sm" icon={Search} onClick={() => void lookup()} disabled={busy}>
            Look up
          </Button>
        </div>
        <textarea
          className={`input area lang-${reel.language}`}
          rows={4}
          value={v.text}
          aria-label="Verse text"
          onChange={(e) => edit('Verse text', (r) => void (r.verses[idx].text = e.target.value), `verse-text-${idx}`)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <Row label="Card top">
          <Slider value={v.top_y} min={160} max={900} step={2} reset={300} format={(x) => `${Math.round(x)} px`} onChange={(x) => edit('Verse position', (r) => void (r.verses[idx].top_y = x), `verse-y-${idx}`)} ariaLabel="Card top" />
        </Row>
        <Row label="Start">
          <TimeField label="Verse start" value={v.t0} max={v.t1 - 0.2} onChange={(x) => edit('Verse timing', (r) => void (r.verses[idx].t0 = x), `v-t0-${idx}`)} />
        </Row>
        <Row label="End">
          <TimeField label="Verse end" value={v.t1} min={v.t0 + 0.2} onChange={(x) => edit('Verse timing', (r) => void (r.verses[idx].t1 = x), `v-t1-${idx}`)} />
        </Row>
        {!onCutaway && <p className="warn-note small">This card is not over a cutaway — house style shows verse cards on cutaways only.</p>}
      </Section>
    </>
  )
}

export function CutawayPanel({ reel }: { reel: Reel }) {
  const selection = useEditor((s) => s.selection)
  const edit = useEditor((s) => s.edit)
  const t = usePlayback((s) => s.t)
  const idx = selection?.kind === 'cutaway' ? selection.index : (activeAt(reel.cutaways, t)?.index ?? -1)
  const c = reel.cutaways[idx]
  const [prompt, setPrompt] = useState('')
  const queued = useGen((s) => (c ? Boolean(s.queued[genKey(reel.id, c.t0)]) : false))
  const planned = c ? cutawayPrompt(c, reel.captions.filter((x) => x.t1 > c.t0 && x.t0 < c.t1).map((x) => x.text).join(' ')) : ''
  useEffect(() => setPrompt(''), [idx, reel.id])

  const add = (): void => {
    const end = Math.min(reelDuration(reel), t + 4)
    edit('Add cutaway', (r) => {
      r.cutaways.push({ t0: t, t1: end, img: '', z0: 1, z1: 1.1, pan: [0, 0] })
      r.cutaways.sort((a, b) => a.t0 - b.t0)
    })
  }

  if (!c) {
    return (
      <Empty icon={ImageIcon} title="No cutaway here">
        Drag an illustration from Library onto the Cutaways track, or add an empty one and generate it with Gemini.
        <div style={{ marginTop: 10 }}>
          <Button size="sm" icon={Plus} onClick={add}>
            Add cutaway at playhead
          </Button>
        </div>
      </Empty>
    )
  }

  const pick = async (): Promise<void> => {
    const files = (await window.viku?.dialog.openFile({ title: 'Choose an illustration', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })) ?? []
    if (files[0]) edit('Cutaway image', (r) => void (r.cutaways[idx].img = files[0]))
  }

  const gen = (): void => void generateForCutaway(reel.id, idx, prompt.trim() || undefined)
  const panPx = Math.abs(c.pan[0]) > 1 || Math.abs(c.pan[1]) > 1
  const panMax = panPx ? 160 : 0.1

  return (
    <>
      <Section title={`Cutaway ${idx + 1} of ${reel.cutaways.length}`} right={<IconButton icon={Trash2} label="Delete cutaway" onClick={() => edit('Delete cutaway', (r) => void r.cutaways.splice(idx, 1))} />}>
        <div className={`cut-preview${c.img ? '' : ' needs'}`}>
          {c.img ? (
            <Thumb src={api().thumbUrl(c.img, 360)} alt="Cutaway image" seed={idx + 3} />
          ) : (
            <span className="cut-empty">
              <Sparkles size={18} aria-hidden />
              <b>Needs image</b>
              <span className="small">{queued ? 'Queued in AI Studio…' : 'Generate it in AI Studio, or pick one'}</span>
            </span>
          )}
        </div>
        <div className="cut-name ellipsis" title={c.img || undefined}>
          {cutawayName(c) || 'Empty cutaway'}
        </div>
        <div className="row gap">
          <Button size="sm" icon={Images} onClick={() => useApp.getState().set({ browserTab: 'library', libraryTab: 'illustrations' })}>
            Library
          </Button>
          <Button size="sm" icon={FolderOpen} onClick={() => void pick()}>
            File…
          </Button>
        </div>
      </Section>
      <Section title="Generate in AI Studio" defaultOpen={!c.img}>
        <textarea
          className="input area"
          rows={c.need ? 5 : 3}
          placeholder={planned}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label="Image prompt"
        />
        {c.need && !prompt && <p className="small muted">Viku planned this prompt from the captions it covers — type to replace it.</p>}
        <Button size="sm" variant={c.img ? 'default' : 'primary'} icon={Sparkles} onClick={gen} disabled={queued}>
          {queued ? 'Queued — waiting for the image' : c.img ? 'Generate a replacement' : 'Generate in AI Studio'}
        </Button>
        <p className="rule-note small">Runs in your own signed-in AI Studio tab (free). The image is captured automatically and placed here.</p>
      </Section>
      <Section title="Motion">
        <Row label="Zoom from">
          <Slider value={c.z0} min={1} max={1.5} step={0.01} reset={1} format={(v) => `${v.toFixed(2)}×`} onChange={(v) => edit('Cutaway zoom', (r) => void (r.cutaways[idx].z0 = v), `cz0-${idx}`)} ariaLabel="Zoom from" />
        </Row>
        <Row label="Zoom to">
          <Slider value={c.z1} min={1} max={1.5} step={0.01} reset={1.1} format={(v) => `${v.toFixed(2)}×`} onChange={(v) => edit('Cutaway zoom', (r) => void (r.cutaways[idx].z1 = v), `cz1-${idx}`)} ariaLabel="Zoom to" />
        </Row>
        <Row label="Pan X">
          <Slider value={c.pan[0]} min={-panMax} max={panMax} step={panPx ? 1 : 0.002} reset={0} format={(v) => (panPx ? `${Math.round(v)} px` : v.toFixed(3))} onChange={(v) => edit('Cutaway pan', (r) => void (r.cutaways[idx].pan[0] = v), `cpx-${idx}`)} ariaLabel="Pan X" />
        </Row>
        <Row label="Pan Y">
          <Slider value={c.pan[1]} min={-panMax} max={panMax} step={panPx ? 1 : 0.002} reset={0} format={(v) => (panPx ? `${Math.round(v)} px` : v.toFixed(3))} onChange={(v) => edit('Cutaway pan', (r) => void (r.cutaways[idx].pan[1] = v), `cpy-${idx}`)} ariaLabel="Pan Y" />
        </Row>
        <Row label="Start">
          <TimeField label="Cutaway start" value={c.t0} max={c.t1 - 0.5} onChange={(v) => edit('Cutaway timing', (r) => void (r.cutaways[idx].t0 = v), `ct0-${idx}`)} />
        </Row>
        <Row label="End">
          <TimeField label="Cutaway end" value={c.t1} min={c.t0 + 0.5} onChange={(v) => edit('Cutaway timing', (r) => void (r.cutaways[idx].t1 = v), `ct1-${idx}`)} />
        </Row>
        <p className="rule-note small">Cross-zoom dissolve 0.7 s in and out — no slides or pushes.</p>
      </Section>
    </>
  )
}
