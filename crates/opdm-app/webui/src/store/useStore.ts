import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { api, isTauri, on } from '@/lib/tauri'
import {
  mapJob, mapSettings, detailSegments,
  type JobEvent, type ParsePayload, type ToolEvent,
} from '@/lib/backend'
import type { Channel, Download, Settings, Tool } from '@/types'
import { DEFAULT_SETTINGS } from '@/lib/defaults'

/* ---------- log ring buffer (port of the old lib/logs.js, §4.1 rule 4) ----------
 * yt-dlp output is unbounded; keep the first 50 lines + the latest tail, drop the
 * middle and insert a "..." marker (head+tail truncation, cap 500). */
const MAX_TASK_LOGS = 500
const HEAD_TASK_LOGS = 50
const LOG_TRUNCATED_MARKER = '...'
function pushTaskLog(logs: string[], line: string) {
  if (logs[HEAD_TASK_LOGS] === LOG_TRUNCATED_MARKER) {
    logs.splice(HEAD_TASK_LOGS + 1, 1) // steady state: drop the oldest tail line
  } else if (logs.length >= MAX_TASK_LOGS) {
    logs.splice(HEAD_TASK_LOGS, 1)
    logs.splice(HEAD_TASK_LOGS, 0, LOG_TRUNCATED_MARKER)
    logs.splice(HEAD_TASK_LOGS + 1, 1)
  }
  logs.push(line)
}
function trimTaskLogs(logs: string[]) {
  const clean = logs.filter(l => l !== LOG_TRUNCATED_MARKER)
  if (clean.length <= MAX_TASK_LOGS) { logs.length = 0; logs.push(...clean); return }
  const head = clean.slice(0, HEAD_TASK_LOGS)
  const tail = clean.slice(-(MAX_TASK_LOGS - HEAD_TASK_LOGS - 1))
  logs.length = 0
  logs.push(...head, LOG_TRUNCATED_MARKER, ...tail)
}

const STATE_STATUS = { 1: 'queued', 2: 'downloading', 3: 'paused', 4: 'completed', 5: 'failed' } as const

interface S {
  ready: boolean
  // mirrors of Rust-owned data (never persisted by the frontend)
  downloads: Download[]; settings: Settings; tools: Tool[]; channel: Channel
  parse: { seq: number; payload: ParsePayload | null } // sticky parse-slot mirror
  logs: Record<string, string[]>                       // ring buffer per job
  // pure UI state
  selected: string[]; activeId: string | null
  // actions
  boot(): Promise<void>
  analyze(url: string): Promise<void>
  cancelParse(): Promise<void>
  startDownload(req: { url: string; kind: 'ytdlp' | 'classic'; filename: string; fmt: string; dir?: string; referer?: string | null; cookies?: string | null }): Promise<void>
  refreshJobs(): Promise<void>
  refreshTools(): Promise<void>
  applyJobEvent(p: JobEvent): void
  applyParse(p: ParsePayload | null, seq?: number): boolean
  applyToolEvent(p: ToolEvent): void
  pushLog(id: string, line: string): void
  hydrateLog(id: string, text: string): void
  patch(id: string, p: Partial<Download>): void
  upsert(d: Download): void
  setActive(id: string | null): void
  toggle(id: string): void
  toggleAll(): void
  remove(ids: string[], deleteFiles?: boolean): Promise<void>
  setSettings(p: Partial<Settings>): void
  saveSettings(): Promise<void>
  patchTool(id: string, p: Partial<Tool>): void
  installTool(id: string, op?: 'install' | 'update'): Promise<void>
  setChannel(c: Channel): Promise<void>
  removeTool(id: string): Promise<void>
  checkTool(id: string): Promise<void>
  browseTool(id: string): Promise<void>
}

let booting: Promise<void> | null = null // StrictMode / hot-reload guard (§4.4)
let intervalsStarted = false
const hydratedLogs = new Set<string>() // yt_log hydrate-once per job

export const useStore = create<S>()(persist((set, get) => ({
  ready: false,
  downloads: [], settings: DEFAULT_SETTINGS, tools: [], channel: 'stable',
  parse: { seq: 0, payload: null },
  logs: {},
  selected: [], activeId: null,

  boot: async () => {
    if (booting) return booting
    booting = (async () => {
      // listeners first, then fetch — reverse order loses events (§4.3)
      const unlisten = isTauri ? await Promise.all([
        on<JobEvent>('job-update', p => get().applyJobEvent(p)),
        on<ParsePayload>('parse-state', p => get().applyParse(p)),
        on<{ id: string; line: string }>('dl-log', ({ id, line }) => get().pushLog(id, line)),
        on<ToolEvent>('tool-update', p => get().applyToolEvent(p)),
      ]) : []
      void unlisten // listeners live for the app lifetime

      const st = await api.getState()
      set(s => ({
        downloads: st.downloads,
        tools: st.tools,
        channel: (st.channel || 'stable') as Channel,
        // real settings win; theme/language stay UI-only (persisted locally)
        settings: { ...st.settings, theme: s.settings.theme, language: s.settings.language },
        parse: st.parse ? { seq: st.parse.seq ?? s.parse.seq + 1, payload: st.parse } : s.parse,
        ready: true,
      }))

      if (isTauri) {
        if (!intervalsStarted) {
          intervalsStarted = true
          // list refresh: adds/removes rows, reconciles (events only patch existing rows)
          setInterval(() => { if (!document.hidden) void get().refreshJobs() }, 1500)
          // parse-slot catch-up: the window may be hidden when the event fires
          setInterval(() => {
            if (document.hidden) return
            void api.parseState().then(({ seq, payload }) => { get().applyParse(payload, seq) })
          }, 1000)
          // per-segment progress for the selected job only (§6)
          setInterval(async () => {
            if (document.hidden) return
            const id = get().activeId
            if (!id) return
            const dt = await api.details(id)
            if (!dt) return
            set(s => ({ downloads: s.downloads.map(d => d.id === id ? { ...mapJob(dt, d), segments: detailSegments(dt) } : d) }))
          }, 600)
        }
      } else {
        mockTicker(get)
      }
    })()
    return booting
  },

  analyze: async (url) => {
    const r = await api.analyze(url)
    if (r && typeof r === 'object') get().applyParse(r) // browser mock fills the slot directly
  },

  cancelParse: async () => {
    await api.cancelParse()
    set(s => ({ parse: { seq: s.parse.seq, payload: null } })) // local ack (§2)
  },

  startDownload: async (req) => {
    await api.start(req)
    await get().refreshJobs()
  },

  refreshJobs: async () => {
    if (!isTauri) return // browser preview is driven by the mock ticker
    const jobs = await api.list()
    set(s => {
      const prev = new Map(s.downloads.map(d => [d.id, d]))
      const next = jobs.map(j => mapJob(j, prev.get(j.id)))
      const known = new Set(next.map(d => d.id))
      let activeId = s.activeId
      if (activeId && !known.has(activeId)) activeId = next[0]?.id ?? null // dock holds a job when the list is non-empty
      const logs: Record<string, string[]> = {}
      for (const [id, v] of Object.entries(s.logs)) if (known.has(id)) logs[id] = v
      return { downloads: next, activeId, logs }
    })
  },

  refreshTools: async (): Promise<void> => { set({ tools: await api.tools() }) },

  applyJobEvent: (p) => {
    if (p.type === 'progress') {
      get().patch(p.id, {
        downloaded: p.done, size: p.total, speed: p.speed,
        eta: p.speed > 1 && p.total > p.done ? (p.total - p.done) / p.speed : undefined,
      })
    } else {
      // unknown ids are ignored — the next poll adds the row (§4.5)
      get().patch(p.id, { status: STATE_STATUS[p.state], error: p.error ?? undefined })
    }
  },

  applyParse: (p, seq) => {
    const cur = get().parse
    const n = seq ?? (p?.seq ?? 0)
    if (n <= cur.seq) return false // newest seq wins (§4.5)
    set({ parse: { seq: n, payload: p } })
    return true
  },

  applyToolEvent: (p) => {
    const cardId = p.tool === 'ffprobe' ? 'ffmpeg' : p.tool // ffprobe ships with ffmpeg, one card
    if (!get().tools.some(t => t.id === cardId)) return
    if (p.stage === 'complete') { void get().refreshTools(); return }
    if (p.stage === 'error') { get().patchTool(cardId, { status: 'error', error: p.error || 'Install failed', progress: undefined }); return }
    get().patchTool(cardId, { status: 'installing', progress: p.percent ?? undefined, error: undefined })
  },

  pushLog: (id, line) => set(s => {
    const arr = [...(s.logs[id] ?? [])]
    pushTaskLog(arr, line)
    return { logs: { ...s.logs, [id]: arr } }
  }),

  hydrateLog: (id, text) => {
    if (hydratedLogs.has(id)) return
    hydratedLogs.add(id)
    const arr = String(text || '').split('\n')
    if (arr.length && arr[arr.length - 1] === '') arr.pop()
    trimTaskLogs(arr)
    set(s => ({ logs: { ...s.logs, [id]: arr } }))
  },

  patch: (id, p) => set(s => ({ downloads: s.downloads.map(d => d.id === id ? { ...d, ...p } : d) })),
  upsert: (d) => set(s => ({ downloads: s.downloads.some(x => x.id === d.id) ? s.downloads.map(x => x.id === d.id ? d : x) : [d, ...s.downloads] })),
  setActive: (id) => set({ activeId: id }),
  toggle: (id) => set(s => ({ selected: s.selected.includes(id) ? s.selected.filter(x => x !== id) : [...s.selected, id] })),
  toggleAll: () => set(s => ({ selected: s.selected.length === s.downloads.length ? [] : s.downloads.map(d => d.id) })),

  remove: async (ids, deleteFiles = false) => {
    await api.remove(ids, deleteFiles)
    set(s => ({
      downloads: s.downloads.filter(d => !ids.includes(d.id)),
      selected: s.selected.filter(i => !ids.includes(i)),
      activeId: ids.includes(s.activeId ?? '') ? (s.downloads.find(d => !ids.includes(d.id))?.id ?? null) : s.activeId,
    }))
  },

  setSettings: (p) => set(s => ({ settings: { ...s.settings, ...p } })),

  saveSettings: async () => {
    const cur = get().settings
    await api.saveSettings(cur)
    // reconcile what the backend clamped/kept (port>0 rule, max_segments 1–16)
    const raw = await api.getRawSettings()
    set({ settings: mapSettings(raw, { theme: cur.theme, language: cur.language }) })
  },

  patchTool: (id, p) => set(s => ({ tools: s.tools.map(t => t.id === id ? { ...t, ...p } : t) })),

  installTool: async (id, op = 'install') => {
    const t = get().tools.find(t => t.id === id)
    if (!t || t.status === 'installing') return // guard double-click
    get().patchTool(id, { status: 'installing', progress: undefined, error: undefined })
    if (isTauri) {
      try { await api.installTool(id, op) } catch (e) { get().patchTool(id, { status: 'error', error: String(e) }) }
      return // progress rides the tool-update events
    }
    let pr = 0 // preview-only simulation
    const iv = setInterval(() => {
      pr += 6 + Math.random() * 16
      if (pr >= 100) { clearInterval(iv); get().patchTool(id, { status: 'installed', progress: undefined, version: 'latest', path: `~/.opendm/tools/${id}` }) }
      else get().patchTool(id, { progress: pr })
    }, 300)
  },

  setChannel: async (c) => {
    set({ channel: c })
    try { await api.setChannel(c) } catch (e) { console.error(e) }
  },

  // gated behind CAP.toolRemove / toolLatestCheck / toolCustomPath until B6
  removeTool: async (id) => { await api.removeTool(id); get().patchTool(id, { status: 'missing', version: undefined, latest: undefined, path: undefined, custom: false }) },
  checkTool: async (id) => { get().patchTool(id, await api.checkTool(id)) },
  browseTool: async (id) => { const f = await api.pickFile(); if (f) get().patchTool(id, await api.setToolPath(id, f)) },
}), {
  name: 'opendm-ui',
  storage: createJSONStorage(() => localStorage),
  // persist ONLY UI prefs (§4.1 rule 2) — jobs/settings/tools are Rust-owned
  partialize: (s) => ({ settings: { theme: s.settings.theme, language: s.settings.language } }),
  merge: (persisted, current) => {
    const p = persisted as { settings?: { theme?: Settings['theme']; language?: string } }
    return { ...current, settings: { ...current.settings, theme: p.settings?.theme ?? current.settings.theme, language: p.settings?.language ?? current.settings.language } }
  },
}))

function mockTicker(get: () => S) {
  setInterval(() => get().downloads.filter(d => d.status === 'downloading' || d.status === 'queued').forEach(d => {
    const segs = d.segments.map(s => ({ ...s, progress: Math.min(100, s.progress + Math.random() * 6) }))
    const avg = segs.reduce((a, s) => a + s.progress, 0) / (segs.length || 1)
    get().patch(d.id, { segments: segs, downloaded: d.size * avg / 100, speed: 2e6 + Math.random() * 3e6, status: avg >= 100 ? 'completed' : 'downloading' })
  }), 500)
}
