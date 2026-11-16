export type DragPayload =
  | { kind: 'image'; path: string; name: string }
  | { kind: 'music'; path: string; name: string; duration: number }
  | { kind: 'sfx'; path: string; name: string; duration: number }
  | { kind: 'verse'; ref: string; text: string }

export const DND_TYPE = 'application/x-viku'

let current: DragPayload | null = null

export function startDrag(e: React.DragEvent, p: DragPayload): void {
  current = p
  e.dataTransfer.setData(DND_TYPE, JSON.stringify(p))
  e.dataTransfer.setData('text/plain', 'path' in p ? p.path : p.ref)
  e.dataTransfer.effectAllowed = 'copy'
}

export function endDrag(): void {
  current = null
}

/** payload of the drag in progress (dataTransfer is unreadable during dragover) */
export function dragging(): DragPayload | null {
  return current
}

export function readDrop(e: React.DragEvent): DragPayload | null {
  try {
    const raw = e.dataTransfer.getData(DND_TYPE)
    if (raw) return JSON.parse(raw) as DragPayload
  } catch {
    /* ignore */
  }
  return current
}
