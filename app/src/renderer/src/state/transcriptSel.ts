import { create } from 'zustand'

/** Transcript selection (line indices, inclusive), shared so I / O hotkeys can mark in / out points. */
export type Range = [number, number]

export function normalizeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as Range).sort((x, y) => x[0] - y[0])
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

interface SelState {
  ranges: Range[]
  /** pending in-point (I) waiting for an out-point (O) */
  markIn: number | null
  setRanges: (r: Range[]) => void
  setMarkIn: (i: number | null) => void
}

export const useTranscriptSel = create<SelState>((set) => ({
  ranges: [],
  markIn: null,
  setRanges: (ranges) => set({ ranges }),
  setMarkIn: (markIn) => set({ markIn })
}))
