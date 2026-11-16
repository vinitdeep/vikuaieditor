import { useEffect, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import { clamp } from '@/lib/time'

/** Seconds field with frame nudges (used for in/out and item timing). */
export function TimeField({ value, onChange, min = 0, max = 1e9, fps = 30, label }: { value: number; onChange: (v: number) => void; min?: number; max?: number; fps?: number; label: string }) {
  const [txt, setTxt] = useState(value.toFixed(2))
  useEffect(() => setTxt(value.toFixed(2)), [value])
  const commit = (): void => {
    const n = Number(txt)
    if (Number.isFinite(n)) onChange(clamp(n, min, max))
    else setTxt(value.toFixed(2))
  }
  return (
    <span className="timefield">
      <button type="button" aria-label={`${label} minus one frame`} onClick={() => onChange(clamp(value - 1 / fps, min, max))}>
        <Minus size={11} />
      </button>
      <input
        className="num"
        aria-label={label}
        value={txt}
        onChange={(e) => setTxt(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') commit()
          if (e.key === 'ArrowUp') onChange(clamp(value + (e.shiftKey ? 1 : 1 / fps), min, max))
          if (e.key === 'ArrowDown') onChange(clamp(value - (e.shiftKey ? 1 : 1 / fps), min, max))
        }}
      />
      <span className="unit">s</span>
      <button type="button" aria-label={`${label} plus one frame`} onClick={() => onChange(clamp(value + 1 / fps, min, max))}>
        <Plus size={11} />
      </button>
    </span>
  )
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="irow">
      <span className="irow-label">{label}</span>
      <span className="irow-ctl">{children}</span>
    </div>
  )
}
