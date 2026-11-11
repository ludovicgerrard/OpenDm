// Single bridge to the Rust backend. Outside Tauri (plain `vite dev`) every call
// falls back to mocks. The Tauri branch calls the REAL backend contract —
// add_download / list_jobs / parse_confirm / parse_state etc. — see
// docs/MIGRATE_TO_NEW_FRONTEND.md (it supersedes the command names in the other docs).
import type { Download, Plugin, Settings, Tool } from '@/types'
import { DEFAULT_SETTINGS } from '@/lib/defaults'
import {
  mapJob, mapSettings, mapTool, rowFmt,
  type ParsePayload, type RawDetail, type RawJob, type RawSettings, type RawToolStatus,
} from '@/lib/backend'

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

async function call<T>(cmd: string, args: Record<string, unknown> | undefined, mock: () => T | Promise<T>): Promise<T> {
  if (!isTauri) return mock()
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}
export async function on<T>(event: string, cb: (p: T) => void): Promise<() => void> {
  if (!isTauri) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<T>(event, (e) => cb(e.payload))
}

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/* ---------- mocks (browser preview only) ---------- */
const MOCK_TOOLS: Tool[] = [
  { id: 'yt-dlp', name: 'yt-dlp', description: 'Extracts video and audio from 1000+ sites', required: true, status: 'installed', version: '2026.09.12', path: '~/.opendm/tools/yt-dlp', custom: false, canUpdate: true },
  { id: 'deno', name: 'Deno', description: 'JavaScript runtime that unlocks every YouTube format', required: false, status: 'installed', version: '2.4', path: '~/.opendm/tools/deno', custom: false },
  { id: 'ffmpeg', name: 'FFmpeg + FFprobe', description: 'Merges video and audio, converts formats — installs both binaries', required: true, status: 'installed', version: '7.1', path: '~/.opendm/tools/ffmpeg', custom: false },
]
const MOCK_PLUGINS: Plugin[] = [
  { id: 'ChromeCookieUnlock', name: 'ChromeCookieUnlock', description: 'Lets yt-dlp read Chrome cookies on Windows', installed: false },
  { id: 'bgutil-ytdlp-pot-provider', name: 'bgutil PO token provider', description: 'Supplies PO tokens for YouTube', installed: true },
]
let mockSeq = 0
const mockParse = (url: string): ParsePayload => {
  mockSeq++
  return {
    seq: mockSeq, kind: 'ytdlp', status: 'ready', url, filename: 'Sample video title',
    folder: DEFAULT_SETTINGS.downloadDir || '~/Downloads', cookies: null, referer: null, probe: null,
    title: 'Sample video title', videoId: 'abc123', duration: 312, uploader: 'Fireship', thumbnail: '',
    rows: [
      { label: '1080p · mp4', size: 182e6, approx: true, note: 'best', v: '137', a: '140' },
      { label: '1080p · mp4 (video only)', size: 176e6, approx: true, note: 'video', v: '137' },
      { label: 'Audio only · m4a', size: 5e6, approx: false, note: 'audio', a: '140' },
    ],
  }
}

/* ---------- the api object (method names are what the pages call) ---------- */
export const api = {
  /** getVersion() from @tauri-apps/api/app (core app plugin). */
  version: async (): Promise<string> => {
    if (!isTauri) return 'browser preview'
    try { const { getVersion } = await import('@tauri-apps/api/app'); return await getVersion() } catch { return '' }
  },

  /** One boot fetch: list_jobs + get_settings + yt_status + parse_state in parallel (§2). */
  getState: async (): Promise<{ downloads: Download[]; settings: Settings; tools: Tool[]; channel: string; parse: ParsePayload | null }> => {
    if (!isTauri) return { downloads: [], settings: DEFAULT_SETTINGS, tools: MOCK_TOOLS, channel: 'stable', parse: null }
    const [jobs, s, yt, ps] = await Promise.all([
      invoke0<RawJob[]>('list_jobs'),
      invoke0<RawSettings>('get_settings'),
      invoke0<{ tools: RawToolStatus[]; channel: string }>('yt_status'),
      invoke0<{ seq: number; payload: ParsePayload | null }>('parse_state'),
    ])
    return {
      downloads: jobs.map(j => mapJob(j)),
      settings: mapSettings(s),
      tools: mapTool(yt.tools),
      channel: yt.channel,
      parse: ps.payload,
    }
  },

  /** list_jobs refresh (store calls this every 1.5 s). */
  list: (): Promise<RawJob[]> => (isTauri ? invoke0<RawJob[]>('list_jobs') : Promise.resolve([])),

  /** Poll the sticky parse slot — {seq, payload}; an ack is payload=null with a new seq. */
  parseState: (): Promise<{ seq: number; payload: ParsePayload | null }> =>
    isTauri ? invoke0<{ seq: number; payload: ParsePayload | null }>('parse_state') : Promise.resolve({ seq: mockSeq, payload: null }),

  /** add_download fills the parse slot; in Tauri the result arrives via parse-state. */
  analyze: (url: string): Promise<ParsePayload | string> =>
    call<ParsePayload | string>('add_download', { url }, async () => { await delay(900); return mockParse(url) }),

  cancelParse: (): Promise<void> => call<void>('parse_clear', undefined, () => {}),

  /** parse_confirm: fmt is a yt-dlp -f selector ('' = best) for ytdlp, '' for classic. */
  start: (req: { url: string; kind: 'ytdlp' | 'classic'; filename: string; fmt: string; dir?: string; referer?: string | null; cookies?: string | null }): Promise<string> =>
    call<string>('parse_confirm', {
      url: req.url, kind: req.kind,
      filename: req.filename?.trim() || null,
      fmt: req.kind === 'ytdlp' ? (req.fmt ?? '') : '',
      referer: req.referer || null, cookies: req.cookies || null,
      // req.dir is not sent: parse_confirm has no folder argument yet — backend addition B1
    }, () => { mockSeq++; return `mock-${mockSeq}` }),

  pause: (id: string) => call<void>('pause_job', { id }, () => {}),
  resume: (id: string) => call<void>('resume_job', { id }, () => {}),
  /** Needs backend addition B2 — disabled in the UI (CAP.retry). */
  retry: (id: string) => call<void>('retry_job', { id }, () => { throw new Error('Retry needs backend addition B2') }),

  remove: async (ids: string[], deleteFiles: boolean) => {
    if (!isTauri) return
    const { invoke } = await import('@tauri-apps/api/core')
    for (const id of ids) { try { await invoke('remove_job', { id, delFiles: deleteFiles }) } catch (e) { console.error('remove_job', id, e) } }
  },

  /** open_file may fail for yt-dlp jobs (name has no extension) → fall back to the folder. */
  openFile: (id: string): Promise<void> =>
    call<void>('open_file', { id }, () => {}).catch(() => api.openFolder(id)),
  openFolder: (id?: string | null) => call<void>('open_folder', { id: id ?? null }, () => {}),

  details: (id: string): Promise<RawDetail | null> => (isTauri ? invoke0<RawDetail | null>('job_details', { id }) : Promise.resolve(null)),

  /** yt-dlp subprocess log of one job (hydrate the ring buffer once). */
  ytLog: (id: string): Promise<string | null> => (isTauri ? invoke0<string | null>('yt_log', { id }) : Promise.resolve(null)),

  /** save_settings needs ALL five values, no partial update (§7.3). */
  saveSettings: (s: Settings) =>
    call<void>('save_settings', {
      port: s.capturePort, maxSegments: s.maxSegments, downloadDir: s.downloadDir,
      userAgent: s.userAgent, integrateTakeover: s.integrateTakeover,
    }, () => {}),
  /** re-read the real settings (reconcile clamps after a save). */
  getRawSettings: (): Promise<RawSettings> => (isTauri ? invoke0<RawSettings>('get_settings') : Promise.resolve({ port: 9100, max_segments: 8, download_dir: '', user_agent: '', integrate_takeover: true, ytdlp_channel: 'stable' })),

  tools: async (): Promise<Tool[]> => {
    if (!isTauri) return MOCK_TOOLS
    const yt = await invoke0<{ tools: RawToolStatus[]; channel: string }>('yt_status')
    return mapTool(yt.tools)
  },
  installTool: (id: string, op: 'install' | 'update' = 'install') => call<void>('yt_install_tool', { tool: id, operation: op }, () => { return delay(1500) }),
  setChannel: (c: string) => call<void>('set_ytdlp_channel', { channel: c }, () => {}),

  // backend additions B6 (docs/MIGRATE_TO_NEW_FRONTEND.md §10) — UI gated by CAP
  removeTool: async (_id: string): Promise<void> => {},
  checkTool: async (_id: string): Promise<Partial<Tool>> => ({}),
  setToolPath: async (_id: string, _path: string | null): Promise<Partial<Tool>> => ({}),

  /** B4 (dialog plugin) not installed yet — hidden by CAP.pickFolder/toolCustomPath. */
  pickFolder: async (): Promise<string | null> => (isTauri ? null : '~/Downloads/OpenDM'),
  pickFile: async (): Promise<string | null> => (isTauri ? null : '/path/to/file'),

  plugins: async (): Promise<Plugin[]> => (isTauri ? [] : MOCK_PLUGINS), // plugins tab hidden (CAP.plugins)
  installPlugin: async (_id: string): Promise<void> => {},
  removePlugin: async (_id: string): Promise<void> => {},
  openExtensionFolder: async () => {}, // hidden (CAP.extensionFolder)
  checkAppUpdate: async (): Promise<{ available: boolean; version?: string }> => ({ available: false }), // hidden (CAP.appUpdate)
  openDataDir: async () => {}, // hidden (needs backend addition B8/§10)
}

/** small helper: invoke without the mock plumbing */
async function invoke0<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export { rowFmt }
