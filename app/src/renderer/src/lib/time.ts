/** 00:01:12:15 style (fps frames) — used in the viewer and inspector. */
export function timecode(t: number, fps = 30): string {
  const sign = t < 0 ? '-' : ''
  const a = Math.abs(t)
  const totalFrames = Math.round(a * fps)
  const f = totalFrames % fps
  const s = Math.floor(totalFrames / fps)
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return `${sign}${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(f)}`
}

/** 1:12.4 / 12:03 compact */
export function clock(t: number, decimals = 0): string {
  const a = Math.max(0, t)
  const m = Math.floor(a / 60)
  const s = a - m * 60
  const ss = decimals ? s.toFixed(decimals).padStart(3 + decimals, '0') : String(Math.floor(s)).padStart(2, '0')
  return `${m}:${ss}`
}

export function duration(t: number): string {
  if (t >= 3600) {
    const h = Math.floor(t / 3600)
    const m = Math.floor((t % 3600) / 60)
    return `${h}h ${String(m).padStart(2, '0')}m`
  }
  if (t >= 60) return `${Math.floor(t / 60)}m ${String(Math.round(t % 60)).padStart(2, '0')}s`
  return `${t.toFixed(1)}s`
}

const pad = (n: number): string => String(n).padStart(2, '0')

export function parseTime(s: string): number | null {
  const parts = s.trim().split(':').map((p) => Number(p))
  if (!parts.length || parts.some((p) => !Number.isFinite(p))) return null
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
