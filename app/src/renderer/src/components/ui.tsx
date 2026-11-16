import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
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

export function Empty({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon size={26} strokeWidth={1.5} aria-hidden />
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
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
  const ref = useRef<HTMLImageElement>(null)
  useEffect(() => setFailed(false), [src])
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
  return <img ref={ref} className={className} src={src} alt={alt} draggable={false} loading="lazy" onError={() => setFailed(true)} />
}
