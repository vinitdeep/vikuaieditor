import { useState } from 'react'
import { FolderOpen, Hammer, Play, Wand2 } from 'lucide-react'
import { api } from '@/api'
import type { Lang, Reel } from '@/api/types'
import { toast, useApp } from '@/state/app'
import { useEditor } from '@/state/editor'
import { usePlayback } from '@/state/playback'
import { useJobs } from '@/state/jobs'
import { reelDuration } from '@/lib/reel'
import { duration } from '@/lib/time'
import { LANGS } from '@/lib/lang'
import { Button, Field, Progress, Section, Segmented, Select, Slider, TextInput } from '../ui'
import { Row } from './common'

/** engine render result: {path, thumbnail} (older shape: {output}) */
export function resultPath(r: unknown): string | null {
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>
    const p = o.path ?? o.output
    if (typeof p === 'string' && p) return p
  }
  return null
}

/** reel id -> its latest render job (the Reel inspector shows its progress) */
const renderJobs = new Map<string, string>()

export async function renderReel(reel: Reel, preset?: string): Promise<void> {
  try {
    const ref = await api().render(reel.id, preset)
    renderJobs.set(reel.id, ref.job)
    useJobs.getState().track(ref, `Render · ${reel.title}`, {
      onDone: (ev) => {
        const out = resultPath(ev.result) ?? ''
        void useEditor.getState().refresh()
        // a re-render overwrites the same file: reload the rendered viewer
        if (out) usePlayback.getState().set({ rendered: { path: out, v: Date.now() } })
        toast('success', `Rendered ${reel.title}`, out && window.viku ? { label: 'Show file', run: () => void window.viku?.shell.reveal(out) } : undefined)
      }
    })
  } catch (e) {
    toast('error', `Render failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export async function autobuildReel(reel: Reel): Promise<void> {
  try {
    const ref = await api().autobuild(reel.id)
    useJobs.getState().track(ref, `Auto-build · ${reel.title}`, {
      onDone: () => {
        void useEditor.getState().refresh()
        toast('success', 'Captions, verses, cutaways and music added')
      }
    })
  } catch (e) {
    toast('error', `Auto-build failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function ReelPanel({ reel }: { reel: Reel }) {
  const edit = useEditor((s) => s.edit)
  const presets = useApp((s) => s.settings?.export_presets ?? [])
  const [preset, setPreset] = useState(presets[0]?.id ?? 'reels')
  const dur = reelDuration(reel)
  const renderJobId = renderJobs.get(reel.id)
  const renderJob = useJobs((s) => (renderJobId ? s.jobs[renderJobId] : undefined))
  const rendering = renderJob && (renderJob.state === 'running' || renderJob.state === 'queued')

  return (
    <>
      <Section title="Reel">
        <Field label="Title hook">
          <TextInput lang={reel.language} value={reel.title} onCommit={(v) => edit('Edit title', (r) => void (r.title = v))} aria-label="Title" />
        </Field>
        <Field label="Sub line">
          <TextInput lang={reel.language} value={reel.sub} placeholder="Optional second line" onCommit={(v) => edit('Edit sub', (r) => void (r.sub = v))} aria-label="Sub line" />
        </Field>
        <Row label="Language">
          <Segmented
            size="sm"
            ariaLabel="Reel language"
            value={reel.language}
            onChange={(v: Lang) =>
              edit('Language', (r) => {
                r.language = v
                r.style.caption_font = v === 'or' ? 'Noto Sans Oriya' : v === 'hi' ? 'Noto Sans Devanagari' : 'Noto Sans'
              })
            }
            options={LANGS.map((l) => ({ id: l.id, label: l.native }))}
          />
        </Row>
        <Row label="Length">
          <span className={`num${dur > 60 ? ' over' : ''}`}>
            {duration(dur)} · {reel.segments.length} segment{reel.segments.length === 1 ? '' : 's'}
          </span>
        </Row>
        <Row label="Status">
          <span className={`status-pill st-${reel.status}`}>{reel.status}</span>
        </Row>
      </Section>

      <Section title="Style">
        <Row label="Title style">
          <Select
            ariaLabel="Title style"
            value={reel.style.title_style}
            onChange={(v) => edit('Title style', (r) => void (r.style.title_style = v))}
            options={[
              { id: 'gold-bar', label: 'Gold bar' },
              { id: 'outline', label: 'White outline' },
              { id: 'card', label: 'Dark card' }
            ]}
          />
        </Row>
        <Row label="Caption size">
          <Slider value={reel.style.caption_size} min={44} max={96} step={1} reset={66} format={(v) => `${v}px`} onChange={(v) => edit('Caption size', (r) => void (r.style.caption_size = v), 'cap-size')} ariaLabel="Caption size" />
        </Row>
        <Row label="Caption font">
          <span className="muted">{reel.style.caption_font}</span>
        </Row>
      </Section>

      <Section title="Build & export">
        <div className="btn-col">
          <Button icon={Wand2} onClick={() => void autobuildReel(reel)}>
            Auto-build captions, verses, cutaways
          </Button>
          <div className="row">
            <Select ariaLabel="Export preset" className="grow" value={preset} onChange={setPreset} options={presets.map((p) => ({ id: p.id, label: p.name }))} />
            <Button variant="primary" icon={Hammer} onClick={() => void renderReel(reel, preset)} disabled={Boolean(rendering)}>
              {rendering ? 'Rendering…' : 'Render'}
            </Button>
          </div>
          {rendering && renderJob && (
            <div className="render-progress" aria-live="polite">
              <Progress value={renderJob.progress} />
              <span className="small muted">
                {Math.round(renderJob.progress * 100)}% · {renderJob.message}
              </span>
            </div>
          )}
        </div>
        {reel.exports.length > 0 && (
          <div className="exports">
            {reel.exports.map((e) => (
              <div key={e.path} className="export-row">
                <Play size={11} aria-hidden />
                <span className="grow ellipsis" title={e.path}>
                  {e.path.split(/[\\/]/).pop()}
                </span>
                <Button size="sm" variant="ghost" icon={Play} onClick={() => usePlayback.getState().set({ viewer: 'rendered', playing: false, rendered: { path: e.path, v: Date.now() } })}>
                  Play
                </Button>
                <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => void window.viku?.shell.reveal(e.path)}>
                  Show
                </Button>
              </div>
            ))}
          </div>
        )}
        <p className="rule-note small">1080×1920 · 30 fps · H.264 CRF 18 · AAC 192k · −14 LUFS · speech enhanced</p>
      </Section>
    </>
  )
}
