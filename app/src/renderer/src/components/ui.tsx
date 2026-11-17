import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type RefObject } from 'react'
import { ChevronDown } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { LangOpt } from '@/api/types'
import { langShort } from '@/lib/lang'

type BtnVariant = 'default' | 'primary' | 'ghost' | 'danger' | 'subtle'

export function Button({
  variant = 'default',
  icon: Icon,
  size = 'md',
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; icon?: LucideIcon; size?: 'sm' | 'md' }) {
  return (
    <button type="button" className={`btn btn-${variant} btn-${size}${className ? ' ' + className : ''}`} {...rest}>
      {Icon && <Icon size={size === 'sm' ? 13 : 14} strokeWidth={2} aria-hidden />}
      {children !== undefined && <span>{children}</span>}
    </button>
  )
}

export function IconButton({
  icon: Icon,
  label,
  active,
  size = 15,
  className,
  kbd,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; active?: boolean; size?: number; kbd?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={kbd ? `${label}  (${kbd})` : label}
      aria-pressed={active}
      className={`ibtn${active ? ' on' : ''}${className ? ' ' + className : ''}`}
      {...rest}
    >
      <Icon size={size} strokeWidth={1.9} aria-hidden />
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  ariaLabel
}: {
  value: T
  options: { id: T; label: ReactNode; icon?: LucideIcon; title?: string }[]
  onChange: (v: T) => void
  size?: 'sm' | 'md' | 'lg'
  ariaLabel?: string
}) {
  return (
    <div className={`seg seg-${size}`} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          title={o.title}
          className={o.id === value ? 'on' : ''}
          onClick={() => onChange(o.id)}
        >
          {o.icon && <o.icon size={13} strokeWidth={2} aria-hidden />}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
  className
}: {
  value: T
  tabs: { id: T; label: string; icon?: LucideIcon; badge?: ReactNode }[]
  onChange: (v: T) => void
  className?: string
}) {
  return (
    <div className={`tabs${className ? ' ' + className : ''}`} role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value} className={t.id === value ? 'on' : ''} onClick={() => onChange(t.id)} title={t.label}>
          {t.icon && <t.icon size={13} strokeWidth={2} aria-hidden />}
          <span>{t.label}</span>
          {t.badge}
        </button>
      ))}
    </div>
  )
}

export function Field({ label, children, hint, inline }: { label: string; children: ReactNode; hint?: ReactNode; inline?: boolean }) {
  return (
    <label className={`field${inline ? ' inline' : ''}`}>
      <span className="field-label">{label}</span>
      <span className="field-ctl">{children}</span>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function TextInput({ value, onChange, onCommit, placeholder, className, lang, ...rest }: {
  value: string
  onChange?: (v: string) => void
  onCommit?: (v: string) => void
  placeholder?: string
  className?: string
  lang?: LangOpt
  type?: string
  'aria-label'?: string
}) {
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value])
  return (
    <input
      className={`input${lang === 'or' ? ' lang-or' : lang === 'hi' ? ' lang-hi' : ''}${className ? ' ' + className : ''}`}
      value={local}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => {
        setLocal(e.target.value)
        onChange?.(e.target.value)
      }}
      onBlur={() => local !== value && onCommit?.(local)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setLocal(value)
          ;(e.target as HTMLInputElement).blur()
        }
        e.stopPropagation()
      }}
      {...rest}
    />
  )
}

export function Select<T extends string>({ value, options, onChange, className, ariaLabel }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; className?: string; ariaLabel?: string }) {
  return (
    <span className={`select${className ? ' ' + className : ''}`}>
      <select value={value} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={12} aria-hidden />
    </span>
  )
}

/** Numeric slider with a value readout; double-click resets. */
export function Slider({
  value,
  min,
  max,
  step = 0.01,
  onChange,
  format = (v) => v.toFixed(2),
  reset,
  ariaLabel
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  format?: (v: number) => string
  reset?: number
  ariaLabel?: string
}) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <span className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel}
        style={{ '--pct': `${Math.max(0, Math.min(100, pct))}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => reset !== undefined && onChange(reset)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <span className="slider-val num">{format(value)}</span>
    </span>
  )
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`toggle${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden>
        <span className="toggle-knob" />
      </span>
      {label && <span className="toggle-label">{label}</span>}
    </label>
  )
}

export function LangBadge({ lang, className }: { lang: LangOpt; className?: string }) {
  return <span className={`lbadge lb-${lang}${className ? ' ' + className : ''}`}>{langShort(lang)}</span>
}

export function Chip({ children, tone = 'default', icon: Icon }: { children: ReactNode; tone?: 'default' | 'gold' | 'blue' | 'green' | 'red'; icon?: LucideIcon }) {
  return (
    <span className={`chip chip-${tone}`}>
      {Icon && <Icon size={11} strokeWidth={2.2} aria-hidden />}
      {children}
    </span>
  )
}

export function Progress({ value, tone = 'gold', indeterminate }: { value: number; tone?: 'gold' | 'blue' | 'green' | 'red'; indeterminate?: boolean }) {
  return (
    <span className={`progress p-${tone}${indeterminate ? ' indet' : ''}`} role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

export function Empty({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={22} strokeWidth={1.6} aria-hidden />
      </span>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  )
}

export function Section({ title, children, right, defaultOpen = true }: { title: string; children: ReactNode; right?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={`isec${open ? ' open' : ''}`}>
      <header>
        <button type="button" className="isec-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <ChevronDown size={12} aria-hidden />
          <span>{title}</span>
        </button>
        {right && <span className="isec-right">{right}</span>}
      </header>
      {open && <div className="isec-body">{children}</div>}
    </section>
  )
}

/** Image that degrades to a tinted placeholder when the file is not reachable (mock mode without media). */
export function Thumb({ src, alt, className, seed = 0 }: { src: string; alt: string; className?: string; seed?: number }) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const ref = useRef<HTMLImageElement>(null)
  useEffect(() => {
    setFailed(false)
    setLoaded(Boolean(ref.current?.complete && ref.current.naturalWidth))
  }, [src])
  if (failed) {
    const hue = (seed * 47) % 360
    return (
      <span
        className={`thumb-ph${className ? ' ' + className : ''}`}
        style={{ background: `linear-gradient(160deg, hsl(${hue} 35% 30%), hsl(${(hue + 40) % 360} 30% 14%))` }}
        aria-label={alt}
      />
    )
  }
  return (
    <img
      ref={ref}
      className={`${className ? className + ' ' : ''}${loaded ? '' : 'img-loading'}`}
      src={src}
      alt={alt}
      draggable={false}
      loading="lazy"
      decoding="async"
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
    />
  )
}

/** Shimmering placeholder block. */
export function Skeleton({ w, h, r, className }: { w?: number | string; h?: number | string; r?: number; className?: string }) {
  return <span className={`skel${className ? ' ' + className : ''}`} style={{ width: w, height: h, borderRadius: r }} aria-hidden />
}

/** A few placeholder rows while a list loads. */
export function SkeletonRows({ rows = 6, avatar, label = 'Loading' }: { rows?: number; avatar?: boolean; label?: string }) {
  return (
    <div className="skel-rows" role="status" aria-label={label}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skel-row">
          {avatar && <Skeleton w={26} h={26} r={6} />}
          <span className="skel-lines">
            <Skeleton h={10} w={`${88 - ((i * 23) % 40)}%`} />
            <Skeleton h={8} w={`${46 - ((i * 13) % 20)}%`} />
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Windowed grid: only the rows in (or near) view are rendered. Cells keep a fixed aspect ratio.
 * Returns the geometry; the caller renders `range` items absolutely positioned inside a `height` spacer.
 */
export function useVirtualGrid(ref: RefObject<HTMLElement | null>, count: number, opts: { minCell: number; gap: number; aspect: number; pad: number; overscan?: number }) {
  const [box, setBox] = useState({ w: 0, h: 0, top: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setBox({ w: el.clientWidth, h: el.clientHeight, top: el.scrollTop })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    let raf = 0
    const onScroll = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setBox((b) => (b.top === el.scrollTop ? b : { ...b, top: el.scrollTop })))
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    measure()
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [ref])
  const inner = Math.max(0, box.w - opts.pad * 2)
  const cols = Math.max(1, Math.floor((inner + opts.gap) / (opts.minCell + opts.gap)))
  const cellW = cols > 0 ? (inner - opts.gap * (cols - 1)) / cols : inner
  const cellH = cellW * opts.aspect
  const rowH = cellH + opts.gap
  const rows = Math.ceil(count / cols)
  const over = opts.overscan ?? 2
  const first = Math.max(0, Math.floor(box.top / Math.max(1, rowH)) - over)
  const last = Math.min(rows, Math.ceil((box.top + box.h) / Math.max(1, rowH)) + over)
  return {
    ready: box.w > 0,
    cols,
    cellW,
    cellH,
    height: rows * rowH - (rows ? opts.gap : 0) + opts.pad,
    range: [first * cols, Math.min(count, last * cols)] as [number, number],
    pos: (i: number) => ({ left: opts.pad + (i % cols) * (cellW + opts.gap), top: Math.floor(i / cols) * rowH, width: cellW, height: cellH })
  }
}
