import { api } from '@/api'
import type { Project } from '@/api/types'

export interface MediaSrc {
  url: string
  /** source second at file time 0 */
  offset: number
  start: number
  end: number
}

/** Engine proxies only analysed ranges: pick the proxy covering a source time, else the original video. */
export function mediaSources(project: Project | null): MediaSrc[] {
  if (!project) return []
  const out: MediaSrc[] = project.proxies.map((p) => ({ url: api().mediaUrl(p.path), offset: p.start, start: p.start, end: p.end }))
  if (!out.length && project.proxy) {
    const off = project.proxy_offset || 0
    out.push({ url: api().mediaUrl(project.proxy), offset: off, start: off, end: off > 0 ? Infinity : project.duration || Infinity })
  }
  if (project.video_path) out.push({ url: api().mediaUrl(project.video_path), offset: 0, start: 0, end: Infinity })
  return out
}

/** The playable file covering a source time (proxy range first, else the original). */
export function pickSource(list: MediaSrc[], t: number): MediaSrc | null {
  return list.find((s) => t >= s.start - 0.01 && t < s.end - 0.01) ?? list[list.length - 1] ?? null
}
