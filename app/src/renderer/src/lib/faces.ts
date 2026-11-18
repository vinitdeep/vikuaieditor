import { create } from 'zustand'
import type { FacesState } from '@shared/ipc'
import { toast } from '@/state/app'

/**
 * "Same face": reference photos kept by the main process (<userData>/faces). The chosen face goes with every new AI
 * picture — the browser extension attaches it in AI Studio and the prompt asks Gemini to keep that person.
 */
interface FacesStore extends FacesState {
  ready: boolean
  init: () => void
}

let started = false

export const useFaces = create<FacesStore>((set) => ({
  faces: [],
  selected: '',
  ready: false,
  init: () => {
    const b = window.viku
    if (started || !b?.faces) return
    started = true
    void b.faces.list().then((s) => set({ ...s, ready: true }))
    b.faces.onChange((s) => set({ ...s, ready: true }))
  }
}))

/** id of the face to send with new pictures, or undefined */
export function selectedFaceId(): string | undefined {
  const { selected, faces } = useFaces.getState()
  return faces.some((f) => f.id === selected) ? selected : undefined
}

export async function addFaceFromFile(): Promise<void> {
  const b = window.viku
  if (!b?.faces) return
  const files = await b.dialog.openFile({ title: 'Choose a clear photo of one face', filters: [{ name: 'Photos', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
  if (!files.length) return
  await addFace(files[0])
}

export async function addFace(path: string, name?: string): Promise<void> {
  const b = window.viku
  if (!b?.faces) return
  try {
    const s = await b.faces.add([path], name)
    const f = s.faces.find((x) => x.id === s.selected)
    toast('success', `${f ? `“${f.name}”` : 'The face'} goes with every new AI picture now`)
  } catch (e) {
    toast('error', `Could not add the face: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** A face photo's thumbnail, made by the desktop app itself (works with any data adapter). */
export const faceThumb = (file: string, width = 96): string => `viku-thumb://img/?p=${encodeURIComponent(file)}&w=${Math.round(width)}`
