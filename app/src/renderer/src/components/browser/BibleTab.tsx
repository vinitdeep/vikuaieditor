import { useEffect, useState } from 'react'
import { BookOpen, CircleAlert, Download, Plus, Search, X } from 'lucide-react'
import { api } from '@/api'
import type { BibleVerse, Lang } from '@/api/types'
import { toast, useApp } from '@/state/app'
import { currentReel, useEditor, useReel } from '@/state/editor'
import { useJobs } from '@/state/jobs'
import { usePlayback } from '@/state/playback'
import { endDrag, startDrag } from '@/lib/dnd'
import { activeAt } from '@/lib/reel'
import { Button, Empty, IconButton, Segmented, SkeletonRows } from '../ui'

export function insertVerse(v: { ref: string; text: string }, at?: number): void {
  const reel = currentReel()
  if (!reel) return toast('warn', 'Open a reel first')
  const t = at ?? usePlayback.getState().t
  // verse cards live on cutaways: snap to the cutaway under the playhead when there is one
  const cut = activeAt(reel.cutaways, t)
  const t0 = cut ? cut.item.t0 + 0.4 : t
  const t1 = cut ? cut.item.t1 - 0.4 : t + 6
  useEditor.getState().edit('Insert verse', (r) => {
    r.verses.push({ t0, t1, ref: v.ref, text: v.text, top_y: 300 })
    r.verses.sort((a, b) => a.t0 - b.t0)
  })
  if (!cut) toast('info', 'Verse cards show on cutaways — add an illustration under it')
  useEditor.getState().select({ kind: 'verse', index: Math.max(0, currentReel()?.verses.findIndex((x) => x.ref === v.ref && Math.abs(x.t0 - t0) < 0.01) ?? 0) })
}

export function BibleTab() {
  const reel = useReel()
  const auth = useApp((s) => s.auth)
  const [lang, setLang] = useState<Lang>(reel?.language ?? 'or')
  const [q, setQ] = useState('')
  const [res, setRes] = useState<BibleVerse[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (reel) setLang(reel.language)
  }, [reel?.language]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true
    setLoading(true)
    const t = setTimeout(() => {
      api()
        .bibleSearch(q, lang)
        .then((r) => {
          if (!alive) return
          setRes(r)
          setError(null)
        })
        .catch((e: unknown) => {
          if (!alive) return
          setRes([])
          setError(e instanceof Error ? e.message : String(e))
        })
        .finally(() => alive && setLoading(false))
    }, 180)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q, lang])

  const download = async (): Promise<void> => {
    const ref = await api().bibleDownload()
    useJobs.getState().track(ref, 'Download Bibles (eBible)', {
      onDone: () => {
        toast('success', 'Bibles downloaded — verse lookup works offline')
        void api().authStatus().then((a) => useApp.getState().set({ auth: a }))
      }
    })
  }

  return (
    <div className="bible-tab">
      <div className="ptool">
        <Segmented
          size="sm"
          ariaLabel="Bible language"
          value={lang}
          onChange={setLang}
          options={[
            { id: 'or', label: 'ଓଡ଼ିଆ IRV' },
            { id: 'hi', label: 'हिन्दी IRV' },
            { id: 'en', label: 'WEB' }
          ]}
        />
      </div>
      <div className="ptool sub">
        <span className="search">
          <Search size={13} aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={lang === 'or' ? 'ଖୋଜନ୍ତୁ… or a reference' : lang === 'hi' ? 'खोजें… या संदर्भ' : 'Search words or a reference'}
            className={`lang-${lang}`}
            spellCheck={false}
            onKeyDown={(e) => e.stopPropagation()}
            aria-label="Search the Bible"
          />
          {q && <IconButton icon={X} label="Clear" size={12} onClick={() => setQ('')} />}
        </span>
      </div>
      {auth?.ebible === 'missing' && (
        <div className="notice">
          <span className="grow small">Bibles are not downloaded yet — lookups use the built-in sample.</span>
          <Button size="sm" icon={Download} onClick={() => void download()}>
            Download
          </Button>
        </div>
      )}
      <div className="vlist">
        {loading && !res.length && <SkeletonRows rows={5} label="Searching the Bible" />}
        {!loading && error && (
          <Empty icon={CircleAlert} title="Bible search failed">
            {error}
          </Empty>
        )}
        {!loading && !error && !res.length && (
          <Empty icon={BookOpen} title={q ? 'No verses found' : 'Search the Bible'}>
            {q ? `Nothing for “${q}”. Try one word, or a reference like “John 3:16”.` : 'Try a word like “ଶାନ୍ତି”, “संग” or “hope”, or a reference.'}
          </Empty>
        )}
        {res.map((v) => (
          <div
            key={v.ref}
            className={`vrow${sel === v.ref ? ' on' : ''}`}
            onClick={() => setSel(v.ref)}
            onDoubleClick={() => insertVerse(v)}
            draggable
            onDragStart={(e) => startDrag(e, { kind: 'verse', ref: v.ref, text: v.text })}
            onDragEnd={endDrag}
          >
            <div className="vrow-head">
              <span className={`vref lang-${v.lang}`}>{v.ref}</span>
              <span className="grow" />
              <Button size="sm" variant="ghost" icon={Plus} onClick={() => insertVerse(v)}>
                Insert
              </Button>
            </div>
            <div className={`vtext lang-${v.lang}`}>{v.text}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
