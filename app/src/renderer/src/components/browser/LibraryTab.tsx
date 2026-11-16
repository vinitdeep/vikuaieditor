import { useEffect, useState } from 'react'
import { AudioLines, ImagePlus, Images, Music2, Pause, Play, Plus, Search, Sparkles, Waves, X } from 'lucide-react'
import { api } from '@/api'
import type { LibraryImage, MusicTrack, SfxItem } from '@/api/types'
import { toast, useApp, type LibraryTab as LT } from '@/state/app'
import { currentReel, useEditor } from '@/state/editor'
import { useJobs } from '@/state/jobs'
import { usePlayback } from '@/state/playback'
import { usePreview } from '@/lib/audio'
import { endDrag, startDrag } from '@/lib/dnd'
import { clock } from '@/lib/time'
import { Button, Empty, IconButton, Segmented, Thumb } from '../ui'

export function LibraryTab() {
  const tab = useApp((s) => s.libraryTab)
  const set = useApp((s) => s.set)
  return (
    <div className="library-tab">
      <div className="ptool">
        <Segmented
          size="sm"
          ariaLabel="Library section"
          value={tab}
          onChange={(v: LT) => set({ libraryTab: v })}
          options={[
            { id: 'illustrations', label: 'Illustrations', icon: Images },
            { id: 'music', label: 'Music', icon: Music2 },
            { id: 'sfx', label: 'SFX', icon: AudioLines }
          ]}
        />
      </div>
      {tab === 'illustrations' && <Illustrations />}
      {tab === 'music' && <MusicList />}
      {tab === 'sfx' && <SfxList />}
    </div>
  )
}

function Illustrations() {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<LibraryImage[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let alive = true
    setLoading(true)
    const t = setTimeout(() => {
      api()
        .librarySearch(q)
        .then((r) => alive && setItems(r))
        .catch(() => alive && setItems([]))
        .finally(() => alive && setLoading(false))
    }, 160)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q])

  const importImages = async (): Promise<void> => {
    const files = (await window.viku?.dialog.openFile({ title: 'Add illustrations', multi: true, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })) ?? []
    if (!files.length) return
    const ref = await api().libraryImport(files, [])
    if (ref) useJobs.getState().track(ref, `Import ${files.length} illustrations`, { onDone: () => setQ((x) => x + '') })
  }

  const addAtPlayhead = (img: LibraryImage): void => {
    const reel = currentReel()
    if (!reel) return toast('warn', 'Open a reel first')
    const t = usePlayback.getState().t
    useEditor.getState().edit('Add cutaway', (r) => {
      r.cutaways.push({ t0: t, t1: t + 4, img: img.path, z0: 1, z1: 1.1, pan: [0, 0] })
      r.cutaways.sort((a, b) => a.t0 - b.t0)
    })
  }

  return (
    <>
      <div className="ptool sub">
        <span className="search">
          <Search size={13} aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tags, names…" spellCheck={false} onKeyDown={(e) => e.stopPropagation()} aria-label="Search illustrations" />
          {q && <IconButton icon={X} label="Clear" size={12} onClick={() => setQ('')} />}
        </span>
        <IconButton icon={ImagePlus} label="Add illustrations to library" onClick={() => void importImages()} />
      </div>
      <div className="igrid">
        {!items.length && !loading && <Empty icon={Images} title="Nothing found">Try another tag, or add images.</Empty>}
        {items.map((it, i) => (
          <figure
            key={it.path}
            className="icell"
            draggable
            onDragStart={(e) => startDrag(e, { kind: 'image', path: it.path, name: it.name })}
            onDragEnd={endDrag}
            onDoubleClick={() => addAtPlayhead(it)}
            title={`${it.name}\n${it.tags.join(', ')}\nDrag onto the Cutaways track · double-click adds at playhead`}
          >
            <Thumb src={api().mediaUrl(it.path)} alt={it.name} seed={i} />
            <figcaption>
              <span className="ellipsis">{it.name.replace(/^\d+-/, '').replace(/-/g, ' ')}</span>
            </figcaption>
            <button type="button" className="icell-add" aria-label={`Add ${it.name} at playhead`} onClick={() => addAtPlayhead(it)}>
              <Plus size={12} />
            </button>
          </figure>
        ))}
      </div>
    </>
  )
}

function MusicList() {
  const [items, setItems] = useState<MusicTrack[]>([])
  const [intent, setIntent] = useState('hopeful worship piano, gentle build')
  const playing = usePreview((s) => s.playing)
  const play = usePreview((s) => s.play)
  const reelMusic = useEditor((s) => s.project?.reels.find((r) => r.id === s.reelId)?.music?.path)
  const auth = useApp((s) => s.auth)

  useEffect(() => {
    api()
      .listMusic()
      .then(setItems)
      .catch(() => setItems([]))
  }, [])

  const generate = async (): Promise<void> => {
    try {
      const ref = await api().heygenMusic(intent)
      useJobs.getState().track(ref, 'HeyGen music', {
        onDone: () => {
          toast('success', 'New music track ready')
          void api().listMusic().then(setItems)
        }
      })
    } catch (e) {
      toast('error', `HeyGen music failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const use = (m: MusicTrack): void => {
    if (!currentReel()) return toast('warn', 'Open a reel first')
    useEditor.getState().edit('Set music', (r) => {
      r.music = { path: m.path, gain_db: r.music?.gain_db ?? -19, start: 0, duck_db: r.music?.duck_db ?? -8 }
    })
  }

  return (
    <>
      <div className="mlist">
        {items.map((m) => (
          <div
            key={m.path}
            className={`mrow${reelMusic === m.path ? ' in-use' : ''}`}
            draggable
            onDragStart={(e) => startDrag(e, { kind: 'music', path: m.path, name: m.name, duration: m.duration })}
            onDragEnd={endDrag}
            onDoubleClick={() => use(m)}
          >
            <IconButton icon={playing === m.path ? Pause : Play} label={playing === m.path ? 'Stop preview' : `Preview ${m.name}`} onClick={() => play(m.path, api().mediaUrl(m.path))} />
            <span className="mrow-info">
              <span className="ellipsis">{m.name}</span>
              <span className="muted small">
                {m.mood ?? 'music'}
                {m.bpm ? ` · ${m.bpm} bpm` : ''}
                {m.source === 'heygen' ? ' · HeyGen' : ''}
              </span>
            </span>
            {playing === m.path && <Waves size={13} className="eq" aria-hidden />}
            <span className="num muted">{clock(m.duration)}</span>
            <Button size="sm" variant="ghost" onClick={() => use(m)}>
              {reelMusic === m.path ? 'In use' : 'Use'}
            </Button>
          </div>
        ))}
        {!items.length && <Empty icon={Music2} title="No music yet">Put tracks in your music folder (Settings → Folders).</Empty>}
      </div>
      <div className="heygen-box">
        <div className="small muted">Generate with HeyGen {auth?.heygen ? '' : '(sign in first)'}</div>
        <div className="row">
          <input className="input grow" value={intent} onChange={(e) => setIntent(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Music intent" />
          <Button size="sm" icon={Sparkles} onClick={() => void generate()}>
            Generate
          </Button>
        </div>
      </div>
    </>
  )
}

function SfxList() {
  const [items, setItems] = useState<SfxItem[]>([])
  const playing = usePreview((s) => s.playing)
  const play = usePreview((s) => s.play)
  useEffect(() => {
    api()
      .listSfx()
      .then(setItems)
      .catch(() => setItems([]))
  }, [])
  const add = (s: SfxItem): void => {
    if (!currentReel()) return toast('warn', 'Open a reel first')
    const t = usePlayback.getState().t
    useEditor.getState().edit('Add SFX', (r) => {
      r.sfx.push({ name: s.name, t, gain_db: s.kind === 'impact' ? -8 : -14 })
      r.sfx.sort((a, b) => a.t - b.t)
    })
  }
  return (
    <div className="mlist">
      <div className="rule-note small">House rule: low impacts under titles, soft air swells into cuts — never bells, chimes or shimmer.</div>
      {items.map((s) => (
        <div key={s.name} className="mrow" draggable onDragStart={(e) => startDrag(e, { kind: 'sfx', path: s.path, name: s.name, duration: s.duration })} onDragEnd={endDrag} onDoubleClick={() => add(s)}>
          <IconButton icon={playing === s.path ? Pause : Play} label={`Preview ${s.name}`} onClick={() => play(s.path, api().mediaUrl(s.path))} />
          <span className="mrow-info">
            <span className="ellipsis">{s.name.replace(/_/g, ' ')}</span>
            <span className="muted small">{s.kind}</span>
          </span>
          <span className="num muted">{s.duration.toFixed(1)}s</span>
          <Button size="sm" variant="ghost" onClick={() => add(s)}>
            Add
          </Button>
        </div>
      ))}
      {!items.length && <Empty icon={AudioLines} title="No SFX found" />}
    </div>
  )
}
