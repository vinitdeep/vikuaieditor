import { useEffect, useRef, useState } from 'react'
import { Check, Pencil, Plus, ScanFace, Trash2, UserRoundX } from 'lucide-react'
import { addFace, addFaceFromFile, faceThumb, useFaces } from '@/lib/faces'
import { IconButton, Thumb } from './ui'

/**
 * "Same face" picker: round face photos as a radio group (plus "No face" and "Add"). The chosen face is sent with
 * every new AI picture, so the same person appears in each one. `fromImage` offers "Use this picture's person".
 */
export function FacePicker({ fromImage, compact }: { fromImage?: string; compact?: boolean }) {
  const { faces, selected, init } = useFaces()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => init(), [init])
  useEffect(() => setEditing(false), [selected])
  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  if (!window.viku?.faces) return null
  const cur = faces.find((f) => f.id === selected)
  const choose = (id: string): void => void window.viku?.faces.select(id)
  const save = (): void => {
    if (cur && name.trim()) void window.viku?.faces.rename(cur.id, name)
    setEditing(false)
  }
  // arrow keys move through the faces, like any radio group
  const onKey = (e: React.KeyboardEvent): void => {
    const ids = ['', ...faces.map((f) => f.id)]
    const at = ids.indexOf(selected)
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    e.stopPropagation()
    const next = ids[(at + step + ids.length) % ids.length]
    choose(next)
    requestAnimationFrame(() => (e.currentTarget.querySelector(`[data-face="${next}"]`) as HTMLElement | null)?.focus())
  }

  return (
    <div className={`faces${compact ? ' compact' : ''}`}>
      <div className="faces-head small">
        <ScanFace size={13} aria-hidden />
        <span className="grow">Same face</span>
        {cur && !editing && <span className="faces-on">On</span>}
      </div>
      <div className="faces-row" role="radiogroup" aria-label="Same face in every picture" onKeyDown={onKey}>
        <button type="button" role="radio" aria-checked={!cur} tabIndex={!cur ? 0 : -1} data-face="" className="face-opt none" title="No face — each picture shows new people" onClick={() => choose('')}>
          <UserRoundX size={16} aria-hidden />
          <span className="sr-only">No face</span>
        </button>
        {faces.map((f, i) => (
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={f.id === selected}
            tabIndex={f.id === selected ? 0 : -1}
            data-face={f.id}
            className="face-opt"
            title={f.name}
            onClick={() => choose(f.id)}
          >
            <Thumb src={faceThumb(f.file, 96)} alt={f.name} seed={i} />
            {f.id === selected && (
              <span className="face-tick" aria-hidden>
                <Check size={10} strokeWidth={3} />
              </span>
            )}
          </button>
        ))}
        <button type="button" className="face-opt add" title="Add a face photo" aria-label="Add a face photo" onClick={() => void addFaceFromFile()}>
          <Plus size={16} aria-hidden />
        </button>
      </div>
      {cur ? (
        editing ? (
          <form
            className="faces-name"
            onSubmit={(e) => {
              e.preventDefault()
              save()
            }}
          >
            <input
              ref={input}
              className="input sm"
              value={name}
              maxLength={40}
              aria-label="Face name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') setEditing(false)
              }}
              onBlur={save}
            />
          </form>
        ) : (
          <div className="faces-name">
            <span className="small grow ellipsis">
              <b>{cur.name}</b> <span className="muted">is in every new picture</span>
            </span>
            <IconButton
              icon={Pencil}
              size={13}
              label={`Rename ${cur.name}`}
              onClick={() => {
                setName(cur.name)
                setEditing(true)
              }}
            />
            <IconButton icon={Trash2} size={13} label={`Remove ${cur.name}`} onClick={() => void window.viku?.faces.remove(cur.id)} />
          </div>
        )
      ) : (
        <p className="small muted faces-hint">
          {faces.length ? 'Pick a face to keep the same person in every picture.' : 'Add a clear photo of one face — it is sent with every picture, so the same person appears each time.'}
        </p>
      )}
      {fromImage && (
        <button type="button" className="faces-from link small" onClick={() => void addFace(fromImage)}>
          <ScanFace size={12} aria-hidden /> Use the person in this picture
        </button>
      )}
    </div>
  )
}
