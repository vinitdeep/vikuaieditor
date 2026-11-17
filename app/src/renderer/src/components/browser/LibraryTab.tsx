import { useEffect, useRef, useState } from 'react'
import { AudioLines, CircleAlert, ImagePlus, Images, Music2, Pause, Play, Plus, RefreshCw, Search, Sparkles, Waves, X } from 'lucide-react'
import { api } from '@/api'
import type { LibraryImage, MusicTrack, SfxItem } from '@/api/types'
import { toast, useApp, type LibraryTab as LT } from '@/state/app'
import { currentReel, useEditor } from '@/state/editor'
import { useJobs } from '@/state/jobs'
import { usePlayback } from '@/state/playback'
import { usePreview } from '@/lib/audio'
import { endDrag, startDrag } from '@/lib/dnd'
import { clock } from '@/lib/time'
import { Button, Empty, IconButton, Segmented, Skeleton, SkeletonRows, Thumb, useVirtualGrid } from '../ui'
import { cutawayAt, readableName, setCutawayImage, useLibraryIndex } from '@/lib/cutaways'

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

const GRID = { minCell: 96, gap: 8, aspect: 16 / 9, pad: 8 }

function Illustrations() {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<LibraryImage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const gridRef = useRef<HTMLDivElement>(null)
  const vg = useVirtualGrid(gridRef, items.length, GRID)

  useEffect(() => {
    let alive = true
    setLoading(true)
    const t = setTimeout(() => {
      api()
        .librarySearch(q, q.trim() ? 120 : 2000)
        .then((r) => {
          if (!alive) return
          setItems(r)
          setError(null)
        })
        .catch((e: unknown) => {
          if (!alive) return
          setItems([])
          setError(e instanceof Error ? e.message : String(e))
        })
        .finally(() => alive && setLoading(false))
    }, 160)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q, nonce])

  useEffect(() => {
    gridRef.current?.scrollTo(0, 0)
  }, [q])

  const importImages = async (): Promise<void> => {
    const files = (await window.viku?.dialog.openFile({ title: 'Add illustrations', multi: true, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })) ?? []
    if (!files.length) return
    try {
      const ref = await api().libraryImport(files, [])
      if (ref)
        useJobs.getState().track(ref, `Import ${files.length} illustrations`, {
          onDone: () => {
            setNonce((n) => n + 1)
            void useLibraryIndex.getState().load(true)
          }
        })
    } catch (e) {
      toast('error', `Import failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const addAtPlayhead = (img: LibraryImage): void => {
    const reel = currentReel()
    if (!reel) return toast('warn', 'Open a reel first')
    const t = usePlayback.getState().t
    // a selected cutaway (or the one under the playhead) gets this picture instead of a new clip
    const sel = useEditor.getState().selection
    const target = sel?.kind === 'cutaway' && reel.cutaways[sel.index] ? sel.index : cutawayAt(reel.cutaways, t)
    if (target >= 0) {
      useEditor.getState().edit('Swap cutaway image', (r) => setCutawayImage(r.cutaways[target], img.path, img))
      toast('success', `Cutaway ${target + 1} now shows “${readableName(img.name)}”`)
      return
    }
    useEditor.getState().edit('Add cutaway', (r) => {
      r.cutaways.push({ t0: t, t1: t + 4, img: img.path, z0: 1, z1: 1.1, pan: [0, 0] })
      r.cutaways.sort((a, b) => a.t0 - b.t0)
    })
  }

  const [from, to] = vg.range
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
      {!loading && !error && items.length > 0 && (
        <div className="igrid-meta small muted">
          {items.length} illustration{items.length === 1 ? '' : 's'}
          {q ? ` for “${q}”` : ''} · drag onto Cutaways
        </div>
      )}
      <div className="igrid" ref={gridRef}>
        {loading && !items.length ? (
          <div className="igrid-skel">
            {Array.from({ length: 9 }).map((_, i) => (
              <Skeleton key={i} className="icell-skel" r={6} />
            ))}
          </div>
        ) : error ? (
          <Empty
            icon={CircleAlert}
            title="Library unavailable"
            action={
              <Button size="sm" icon={RefreshCw} onClick={() => setNonce((n) => n + 1)}>
                Try again
              </Button>
            }
          >
            {error}
          </Empty>
        ) : !items.length ? (
          q ? (
            <Empty
              icon={Search}
              title="Nothing matches"
              action={
                <Button size="sm" onClick={() => setQ('')}>
                  Clear search
                </Button>
              }
            >
              No illustration is tagged “{q}”. Try a broader word, or generate one from an empty cutaway.
            </Empty>
          ) : (
            <Empty
              icon={Images}
              title="Your library is empty"
              action={
                <Button size="sm" variant="primary" icon={ImagePlus} onClick={() => void importImages()}>
                  Add illustrations
                </Button>
              }
            >
              Add your own pictures, or generate them in AI Studio — every captured image is filed here.
            </Empty>
          )
        ) : (
          <div className="igrid-space" style={{ height: vg.height }}>
            {vg.ready &&
              items.slice(from, to).map((it, k) => {
                const i = from + k
                const name = readableName(it.name)
                return (
                  <figure
                    key={it.path}
                    className="icell"
                    style={vg.pos(i)}
                    draggable
                    onDragStart={(e) => startDrag(e, { kind: 'image', path: it.path, name: it.name })}
                    onDragEnd={endDrag}
                    onDoubleClick={() => addAtPlayhead(it)}
                    title={`${name}\n${it.tags.join(', ')}\nDrag onto the Cutaways track (onto a cutaway = swap) · double-click puts it on the selected cutaway, or adds one at the playhead`}
                  >
                    <Thumb src={api().thumbUrl(it.path, 320)} alt={name} seed={i} />
                    <figcaption>
                      <span className="ellipsis">{name}</span>
                    </figcaption>
                    <button type="button" className="icell-add" aria-label={`Add ${name} at playhead`} onClick={() => addAtPlayhead(it)}>
                      <Plus size={12} />
                    </button>
                  </figure>
                )
              })}
          </div>
        )}
      </div>
    </>
  )
}

function MusicList() {
  const [items, setItems] = useState<MusicTrack[]>([])
  const [loading, setLoading] = useState(true)
  const [intent, setIntent] = useState('hopeful worship piano, gentle build')
  const playing = usePreview((s) => s.playing)
  const play = usePreview((s) => s.play)
  const reelMusic = useEditor((s) => s.project?.reels.find((r) => r.id === s.reelId)?.music?.path)
  const auth = useApp((s) => s.auth)

  useEffect(() => {
    api()
      .listMusic()
      .then(setItems)
      .catch((e: unknown) => {
        setItems([])
        toast('error', `Could not list music: ${e instanceof Error ? e.message : String(e)}`)
      })
      .finally(() => setLoading(false))
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
        {loading && !items.length && <SkeletonRows rows={6} avatar label="Loading music" />}
        {!loading && !items.length && (
          <Empty icon={Music2} title="No music yet">
            Put tracks in your music folder (Settings → Folders), or generate one with HeyGen below.
          </Empty>
        )}
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
  const [loading, setLoading] = useState(true)
  const playing = usePreview((s) => s.playing)
  const play = usePreview((s) => s.play)
  useEffect(() => {
    api()
      .listSfx()
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
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
      {loading && !items.length && <SkeletonRows rows={4} avatar label="Loading sound effects" />}
      {!loading && !items.length && (
        <Empty icon={AudioLines} title="No sound effects yet">
          The engine installs impacts and air swells on first run — restart it if this stays empty.
        </Empty>
      )}
    </div>
  )
}
