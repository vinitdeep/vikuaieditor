import { useEffect, useState } from 'react'
import { Activity, Check, CircleAlert, FolderOpen, Loader2, Trash2, X, Info, TriangleAlert, CircleCheck, Hammer, Download } from 'lucide-react'
import { useApp } from '@/state/app'
import { useJobs, type Job } from '@/state/jobs'
import { useEditor, useReel } from '@/state/editor'
import { reelDuration } from '@/lib/reel'
import { Button, IconButton, Progress, Select } from '../ui'
import { renderReel, resultPath } from '../inspector/ReelPanel'
import { ThumbPreview } from '../ThumbPreview'

/** Drag handle between panes; `axis` x resizes widths, y resizes heights. */
export function Splitter({ axis, value, min, max, invert, onChange }: { axis: 'x' | 'y'; value: number; min: number; max: number; invert?: boolean; onChange: (v: number) => void }) {
  const [active, setActive] = useState(false)
  return (
    <div
      className={`splitter sp-${axis}${active ? ' active' : ''}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      onPointerDown={(e) => {
        e.preventDefault()
        const el = e.currentTarget
        el.setPointerCapture(e.pointerId)
        setActive(true)
        const start = axis === 'x' ? e.clientX : e.clientY
        const v0 = value
        const move = (ev: PointerEvent): void => {
          const d = (axis === 'x' ? ev.clientX : ev.clientY) - start
          onChange(Math.max(min, Math.min(max, v0 + (invert ? -d : d))))
        }
        const up = (): void => {
          setActive(false)
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', up)
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
      }}
    />
  )
}

function elapsed(j: Job): string {
  const s = Math.max(0, Math.round((j.updatedAt - j.startedAt) / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}


export function ActivityDrawer() {
  const open = useApp((s) => s.activityOpen)
  const set = useApp((s) => s.set)
  const order = useJobs((s) => s.order)
  const jobs = useJobs((s) => s.jobs)
  const cancel = useJobs((s) => s.cancel)
  const clear = useJobs((s) => s.clearFinished)
  return (
    <aside className={`drawer${open ? ' open' : ''}`} aria-hidden={!open} aria-label="Activity">
      <header>
        <Activity size={14} aria-hidden />
        <span className="grow">Activity</span>
        <IconButton icon={Trash2} label="Clear finished" onClick={clear} />
        <IconButton icon={X} label="Close" onClick={() => set({ activityOpen: false })} />
      </header>
      <div className="drawer-body">
        {!order.length && <div className="muted small pad">No jobs yet. Analyze, render and Automate runs show up here.</div>}
        {order.map((id) => {
          const j = jobs[id]
          if (!j) return null
          const live = j.state === 'running' || j.state === 'queued'
          const out = resultPath(j.result)
          return (
            <div key={id} className={`job js-${j.state}`}>
              <div className="job-head">
                <span className="job-icon">
                  {live ? <Loader2 size={13} className="spin" /> : j.state === 'done' ? <Check size={13} /> : j.state === 'error' ? <CircleAlert size={13} /> : <X size={13} />}
                </span>
                <span className="job-label ellipsis grow">{j.label}</span>
                <span className="num muted small">{elapsed(j)}</span>
                {live && <IconButton icon={X} label="Cancel job" onClick={() => void cancel(id)} />}
              </div>
              <div className={`job-msg small ${j.state === 'error' ? 'err' : 'muted'}`}>{j.message}</div>
              {live && <Progress value={j.progress} />}
              {j.state === 'done' && out && (
                <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => void window.viku?.shell.reveal(out)}>
                  Show in Explorer
                </Button>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismiss)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = t.kind === 'success' ? CircleCheck : t.kind === 'warn' ? TriangleAlert : t.kind === 'error' ? CircleAlert : Info
        return (
          <div key={t.id} className={`toast t-${t.kind}`}>
            <Icon size={14} aria-hidden />
            <span className="grow">{t.text}</span>
            {t.action && (
              <button
                type="button"
                className="toast-act"
                onClick={() => {
                  t.action?.run()
                  dismiss(t.id)
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <X size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export function Modal({ title, onClose, children, width = 560, footer }: { title: string; onClose: () => void; children: React.ReactNode; width?: number; footer?: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal aria-label={title} style={{ width }}>
        <header>
          <span className="grow">{title}</span>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  )
}

export function ExportDialog() {
  const open = useApp((s) => s.exportOpen)
  const set = useApp((s) => s.set)
  const presets = useApp((s) => s.settings?.export_presets ?? [])
  const reel = useReel()
  const project = useEditor((s) => s.project)
  const [preset, setPreset] = useState('')
  const [all, setAll] = useState(false)
  useEffect(() => {
    if (open && !preset && presets[0]) setPreset(presets[0].id)
  }, [open, preset, presets])
  if (!open) return null
  const close = (): void => set({ exportOpen: false })
  const targets = all ? (project?.reels ?? []) : reel ? [reel] : []
  return (
    <Modal
      title="Export"
      onClose={close}
      width={600}
      footer={
        <>
          <span className="grow small muted">{targets.length} reel{targets.length === 1 ? '' : 's'} → exports folder</span>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            icon={Hammer}
            disabled={!targets.length}
            onClick={() => {
              for (const r of targets) void renderReel(r, preset)
              close()
              set({ activityOpen: true })
            }}
          >
            Render {targets.length > 1 ? `${targets.length} reels` : ''}
          </Button>
        </>
      }
    >
      <div className="export-grid">
        {reel && (
          <div className="export-thumb">
            <ThumbPreview reel={reel} width={130} />
          </div>
        )}
        <div className="export-form">
          <div className="irow">
            <span className="irow-label">Preset</span>
            <span className="irow-ctl">
              <Select ariaLabel="Export preset" value={preset} onChange={setPreset} options={presets.map((p) => ({ id: p.id, label: p.name }))} />
            </span>
          </div>
          <div className="irow">
            <span className="irow-label">Reels</span>
            <span className="irow-ctl">
              <label className="radio">
                <input type="radio" checked={!all} onChange={() => setAll(false)} /> This reel
              </label>
              <label className="radio">
                <input type="radio" checked={all} onChange={() => setAll(true)} /> All reels in project ({project?.reels.length ?? 0})
              </label>
            </span>
          </div>
          {reel && (
            <div className="irow">
              <span className="irow-label">Length</span>
              <span className={`irow-ctl num${reelDuration(reel) > 60 ? ' over' : ''}`}>{reelDuration(reel).toFixed(1)} s</span>
            </div>
          )}
          <ul className="spec-list small">
            <li>
              <Download size={11} aria-hidden /> H.264 CRF 18 · AAC 192k · 30 fps
            </li>
            <li>
              <Download size={11} aria-hidden /> Speech enhanced (DeepFilterNet3), −14 LUFS, −1.5 dBTP
            </li>
            <li>
              <Download size={11} aria-hidden /> Thumbnail JPG alongside each video
            </li>
          </ul>
        </div>
      </div>
    </Modal>
  )
}
