// Translation layer between the REAL Rust contract (docs/MIGRATE_TO_NEW_FRONTEND.md §1)
// and the UI's own types. Rust is authoritative: numeric job states, snake_case
// settings, a sticky "parse slot" (seq-ordered) that the UI only mirrors.
import type { Download, Settings, Status, Tool, ToolId, Segment } from '@/types'
import { DEFAULT_SETTINGS } from '@/lib/defaults'

/* ---------- raw shapes returned by the Rust commands ---------- */

export type RawJob = {
  id: string; url: string; name: string; folder: string
  state: 1 | 2 | 3 | 4 | 5 // 1 queued, 2 running, 3 paused, 4 done, 5 error
  done: number; total: number // bytes, total 0 = unknown
  speed: number // bytes/s
  error: string | null
  kind: '' | 'hls' | 'ytdlp'
  stage: '' | 'downloading' | 'merging'
}

export type RawDetail = {
  id: string; url: string; referer: string | null; cookiesSent: boolean
  folder: string; name: string
  state: 1 | 2 | 3 | 4 | 5
  done: number; total: number; speed: number
  error: string | null
  kind: 'range' | 'hls' | 'ytdlp'
  stage: '' | 'downloading' | 'merging'
  segs: { idx: number; frac: number; done: boolean }[]
  hls: { total: number; done: number } | null
}

export type RawToolStatus = {
  tool: 'yt-dlp' | 'deno' | 'ffmpeg' | 'ffprobe'
  installed: boolean; runnable: boolean
  version: string; path: string; source: string
  is_managed: boolean; can_update: boolean
}

export type RawSettings = {
  port: number; max_segments: number; download_dir: string
  user_agent: string; integrate_takeover: boolean; ytdlp_channel: string
}

/** Parse-slot payload. Every entry point (extension, paste box, New button)
 *  funnels through it; nothing downloads until `parse_confirm`. */
export type ParseRow = {
  label: string; size: number; approx: boolean
  note: 'best' | 'video' | 'audio' | 'muxed' | ''
  v?: string; a?: string
}
export type ParsePayload = {
  seq?: number
  kind: 'ytdlp' | 'classic'
  status: 'parsing' | 'ready' | 'error'
  url: string; filename: string; folder: string
  cookies: string | null; referer: string | null
  probe: null | { totalBytes?: number; type?: string; disposition?: string } // classic only, arrives a moment later
  // ytdlp & ready only:
  title?: string; videoId?: string; duration?: number; uploader?: string; thumbnail?: string
  rows?: ParseRow[]
  error?: string
}

export type JobEvent =
  | { type: 'progress'; id: string; done: number; total: number; speed: number }
  | { type: 'state'; id: string; state: 1 | 2 | 3 | 4 | 5; name?: string; error?: string | null }

export type ToolEvent = {
  tool: string; operation?: string
  stage: 'downloading' | 'installing' | 'complete' | 'error'
  percent?: number | null; error?: string; type?: string
  downloaded?: number; total?: number
}

/* ---------- mappers ---------- */

const STATUS: Record<RawJob['state'], Status> = { 1: 'queued', 2: 'downloading', 3: 'paused', 4: 'completed', 5: 'failed' }
const host = (u: string) => { try { return new URL(u).hostname } catch { return u } }

/** name/ext split: yt-dlp jobs have no extension until the merge finishes. */
export function mapJob(j: RawJob | RawDetail, prev?: Download): Download {
  const status = j.state === 2 && j.stage === 'merging' ? 'merging' : STATUS[j.state]
  const dot = j.name.lastIndexOf('.')
  const hasExt = j.kind !== 'ytdlp' && dot > 0 && j.name.length - dot <= 6
  return {
    id: j.id, url: j.url, dir: j.folder, kind: (j.kind || 'range') as Download['kind'],
    name: hasExt ? j.name.slice(0, dot) : j.name, ext: hasExt ? j.name.slice(dot + 1) : '',
    size: j.total, downloaded: j.done, speed: j.speed,
    eta: j.speed > 1 && j.total > j.done ? (j.total - j.done) / j.speed : undefined,
    status, error: j.error ?? undefined, source: host(j.url),
    segments: prev?.segments ?? [], logs: [],
    referer: 'referer' in j ? j.referer : undefined,
    cookiesSent: 'cookiesSent' in j ? j.cookiesSent : undefined,
    quality: prev?.quality, createdAt: prev?.createdAt ?? Date.now(),
  }
}

export function mapSettings(s: RawSettings, ui?: { theme?: Settings['theme']; language?: string }): Settings {
  return {
    ...DEFAULT_SETTINGS,
    downloadDir: s.download_dir, maxSegments: s.max_segments, userAgent: s.user_agent,
    capturePort: s.port, integrateTakeover: s.integrate_takeover,
    theme: ui?.theme ?? DEFAULT_SETTINGS.theme, language: ui?.language ?? DEFAULT_SETTINGS.language,
  }
}

const TOOL_META: Record<string, { name: string; description: string; required: boolean }> = {
  'yt-dlp': { name: 'yt-dlp', description: 'Extracts video and audio from 1000+ sites', required: true },
  deno: { name: 'Deno', description: 'JavaScript runtime that unlocks every YouTube format', required: false },
  ffmpeg: { name: 'FFmpeg + FFprobe', description: 'Merges video and audio, converts formats — installs both binaries', required: true },
}

/** 4 managed tools → 3 cards: ffmpeg and ffprobe come from one archive. */
export function mapTool(list: RawToolStatus[]): Tool[] {
  const ff = list.find(t => t.tool === 'ffmpeg')
  const fp = list.find(t => t.tool === 'ffprobe')
  const merged = (t: RawToolStatus): RawToolStatus =>
    t.tool === 'ffmpeg' && ff && fp
      ? { ...t, installed: ff.installed && fp.installed, runnable: ff.runnable && fp.runnable, can_update: ff.can_update && fp.can_update }
      : t
  return list.filter(t => t.tool !== 'ffprobe').map(t0 => {
    const t = merged(t0)
    const meta = TOOL_META[t.tool] ?? { name: t.tool, description: '', required: true }
    return {
      id: t.tool as ToolId, name: meta.name, description: meta.description, required: meta.required,
      status: !t.installed ? 'missing' : !t.runnable ? 'error' : 'installed',
      version: t.version || undefined, path: t.path || undefined,
      custom: !t.is_managed, canUpdate: t.can_update,
      error: t.installed && !t.runnable ? 'Present but not runnable — reinstall to fix' : undefined,
    }
  })
}

/** job_details → segment cells for the bar (§6). */
export function detailSegments(dt: RawDetail): Segment[] {
  if (dt.kind === 'range') return dt.segs.map(s => ({ id: s.idx, progress: s.done ? 100 : s.frac * 100 }))
  if (dt.kind === 'hls') {
    const h = dt.hls
    if (!h || h.total === 0) return []
    const n = Math.min(h.total, 80)
    const filled = Math.round(h.done / (h.total / n))
    return Array.from({ length: n }, (_, i) => ({ id: i, progress: i < filled ? 100 : 0 }))
  }
  return [] // yt-dlp: single bar, stage-driven label
}

/** quality rows → yt-dlp -f selector; '' = best (§5). */
export const rowFmt = (r?: ParseRow) =>
  !r || r.note === 'best' ? '' : r.note === 'audio' ? (r.a ?? '')
  : r.note === 'video' ? (r.a ? `${r.v}+${r.a}` : `${r.v}+bestaudio`) : (r.v ?? '')

export const fullName = (d: { name: string; ext: string }) => (d.ext ? `${d.name}.${d.ext}` : d.name)

export const kindLabel = (k?: Download['kind']) =>
  k === 'hls' ? 'HLS · m3u8' : k === 'ytdlp' ? 'yt-dlp' : 'HTTP · multi-segment'
