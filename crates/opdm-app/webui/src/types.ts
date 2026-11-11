export type Status = 'queued' | 'downloading' | 'paused' | 'merging' | 'completed' | 'failed'
export type Channel = 'stable' | 'nightly' | 'master'
export interface Segment { id: number; progress: number } // progress 0..100
export interface Download {
  id: string; url: string; name: string; dir: string; ext: string
  size: number; downloaded: number; speed: number; eta?: number
  status: Status; segments: Segment[]; logs: string[]
  kind?: 'range' | 'hls' | 'ytdlp'
  referer?: string | null; cookiesSent?: boolean
  quality?: string; source?: string; createdAt: number; error?: string
}
export type Reencode = 'none' | 'mp4' | 'mkv' | 'webm' | 'mp3' | 'aac' | 'flac'
export interface Settings {
  // general
  downloadDir: string; theme: 'auto' | 'light' | 'dark'; language: string; notifyInApp: boolean; notifySystem: boolean; restoreQueue: boolean
  // real backend keys (save_settings / get_settings)
  maxSegments: number; capturePort: number; integrateTakeover: boolean; userAgent: string
  // downloads (hidden until backend support — see lib/capabilities.ts)
  maxConcurrent: number; fragmentThreads: number; speedLimitKb: number; autoStart: boolean; filenameTemplate: string; sponsorBlock: boolean
  // network (hidden until backend support)
  proxy: string; cookieMode: 'none' | 'text' | 'file'; cookieText: string; cookieFile: string
  // output (hidden until backend support)
  reencode: Reencode; embedSubs: boolean; embedThumb: boolean; embedMeta: boolean; embedChapters: boolean
}
export type ToolId = 'yt-dlp' | 'ffmpeg' | 'deno'
export interface Tool {
  id: ToolId; name: string; description: string; required: boolean
  status: 'missing' | 'installed' | 'outdated' | 'installing' | 'error'
  version?: string; latest?: string; path?: string; custom: boolean; progress?: number; error?: string
  /** yt_status.can_update — show the Update button when true. */
  canUpdate?: boolean
}
export interface Plugin { id: string; name: string; description: string; installed: boolean }
