import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { api, isTauri, on } from '@/lib/tauri'
import {
  mapJob, mapSettings, detailSegments, rowFmt,
  type JobEvent, type ParsePayload, type ToolEvent,
} from '@/lib/backend'
import { AUTO_MS, pickAutoRow } from '@/lib/autoFormat'
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

/* ---------- batch list (New page, STEP2_BATCH_DOWNLOADS.md) ---------- */

export type BatchStatus = 'waiting' | 'parsing' | 'ready' | 'starting' | 'started' | 'error'

export type BatchItem = {
  id: string
  url: string
  status: BatchStatus
  /** Latest parse-slot payload snapshot for this url (probe merges land here). */
  info: ParsePayload | null
  name: string
  /** Selected quality row INDEX as a string ('' = default best row); '' for classic. */
  fmt: string
  dir: string
  open: boolean
  /** Auto-download deadline — Date.now()+AUTO_MS, never a tick count, so it stays
   *  correct while the window is hidden or the tick interval is throttled. */
  deadline: number | null
  /** When this card entered 'parsing' — feeds the stuck-analysis watchdog. */
  parsingSince?: number
  error?: string
  /** User edited the name → later payload updates must not overwrite it. */
  nameDirty?: boolean
}

const uid = (): string =>
  (globalThis.crypto as { randomUUID?: () => string } | undefined)?.randomUUID?.()
  ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/** Urls removed moments ago → a late payload for them must not recreate a card
 *  (the sticky slot can deliver a canceled parse's result after removal). */
const REMOVE_TTL = 15_000
const recentlyRemoved = new Map<string, number>()

/** Watchdog: a 'parsing' card whose payload never arrives (the single slot was
 *  replaced by an extension send) would block `pump` forever — fail it and move
 *  on. A genuinely slow parse that finishes later still revives the card. */
const PARSE_STUCK_MS = 90_000

interface S {
  ready: boolean
  // mirrors of Rust-owned data (never persisted by the frontend)
  downloads: Download[]; settings: Settings; tools: Tool[]; channel: Channel
  parse: { seq: number; payload: ParsePayload | null } // sticky parse-slot mirror
  // batch list (New page) — the slot only feeds it, cards are the source of truth
  batch: BatchItem[]
  /** Bumped when an incoming payload CREATES a card (extension send). The App
   *  watcher navigates to /new on it; probe updates never bump it (no yank). */
  batchAdded: number
  logs: Record<string, string[]>                       // ring buffer per job
  // pure UI state
  selected: string[]; activeId: string | null
  // actions
  boot(): Promise<void>
  addLinks(text: string): void
  pump(): Promise<void>
  patchItem(id: string, p: Partial<BatchItem>): void
  removeItem(id: string): void
  clearBatch(): void
  setAuto(v: boolean): Promise<void>
  startItem(id: string): Promise<void>
  routeParse(p: ParsePayload, opts?: { navigate?: boolean }): boolean
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
let lastJobsJson = '' // raw list identity — idle polls skip the reconcile entirely

export const useStore = create<S>()(persist((set, get) => ({
  ready: false,
  downloads: [], settings: DEFAULT_SETTINGS, tools: [], channel: 'stable',
  parse: { seq: 0, payload: null },
  batch: [], batchAdded: 0,
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
        // newest-ADDED first (§8) — getState seeded createdAt in backend order
        downloads: [...st.downloads].sort((a, b) => b.createdAt - a.createdAt),
        channel: st.channel,
        // real settings win; theme/language stay UI-only (persisted locally)
        settings: { ...st.settings, theme: s.settings.theme, language: s.settings.language },
        parse: st.parse ? { seq: st.parse.seq ?? s.parse.seq + 1, payload: st.parse } : s.parse,
        ready: true,
      }))
      // a payload left in the sticky slot becomes a card — but boot must NOT yank
      // the user to /new (§8): route with navigate:false
      if (st.parse) get().routeParse(st.parse, { navigate: false })
      // tools are probed out-of-band (§2): the probe spawns managed binaries and
      // must never delay first paint — patch them in whenever the answer lands
      void api.tools().then(tools => set({ tools })).catch(() => {})

      if (!intervalsStarted) {
        intervalsStarted = true
        // batch countdown auto-start: every card holds a deadline (Date.now()+5000);
        // a throttled tick can only delay a start, never lose it (STEP1/STEP2 spec)
        setInterval(() => tickBatch(get), 200)
      }
      if (isTauri) {
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
      } else {
        mockTicker(get)
      }
    })()
    return booting
  },

  /* ---------- batch list (New page, STEP2_BATCH_DOWNLOADS.md) ---------- */

  addLinks: (text) => {
    const have = new Set(get().batch.map(i => i.url))
    // split on spaces / commas / newlines, dedupe, skip urls already listed
    const urls = [...new Set(text.split(/[\s,]+/).filter(Boolean))].filter(u => !have.has(u))
    if (!urls.length) return
    const items: BatchItem[] = urls.map(url => ({
      id: uid(), url, status: 'waiting', info: null, name: '', fmt: '',
      dir: get().settings.downloadDir, open: false, deadline: null,
    }))
    const top = [...items].reverse() // newest-first display (§8): the last link of a paste lands topmost
    set(s => ({ batch: [...top, ...s.batch] }))
    void get().pump()
  },

  pump: async () => {
    // single sticky parse slot (§2): one card parses at a time. The queue itself
    // stays FIFO (first pasted = first analyzed) even though the display is
    // newest-first (§8) — the oldest waiting card sits at the END of the array.
    if (get().batch.some(i => i.status === 'parsing' || i.status === 'starting')) return
    const batch = get().batch
    let next: BatchItem | undefined
    for (let k = batch.length - 1; k >= 0; k--) {
      if (batch[k].status === 'waiting') { next = batch[k]; break }
    }
    if (!next) return
    get().patchItem(next.id, { status: 'parsing', parsingSince: Date.now() })
    try {
      const r = await api.analyze(next.url)
      // browser mock resolves with the payload; Tauri resolves fast ("parse")
      // and the real payloads arrive via parse-state / the 1 s catch-up poll
      if (r && typeof r === 'object') get().applyParse(r)
    } catch (e) {
      get().patchItem(next.id, { status: 'error', error: String(e) })
    }
    void get().pump() // mock path: payload already routed → next waiting card
  },

  patchItem: (id, p) => set(s => ({ batch: s.batch.map(i => i.id === id ? { ...i, ...p } : i) })),

  removeItem: (id) => {
    const it = get().batch.find(i => i.id === id)
    if (!it || it.status === 'starting') return // guarded in the UI too (§ card)
    if (it.status === 'parsing') {
      // free the slot for the next card; a late payload for this url must not
      // resurrect the card (recentlyRemoved covers the cancel-ack race)
      recentlyRemoved.set(it.url, Date.now())
      void get().cancelParse()
    }
    set(s => ({ batch: s.batch.filter(i => i.id !== id) }))
    void get().pump()
  },

  clearBatch: () => set(s => ({
    // cards mid-flight stay; waiting/ready/started/error cards go
    batch: s.batch.filter(i => i.status === 'parsing' || i.status === 'starting'),
  })),

  setAuto: async (v) => {
    // persist ONLY this flag: rebuild the saved settings from the backend —
    // never send the possibly-dirty Settings draft (§7.3). One setting, two places.
    try {
      const raw = await api.getRawSettings()
      await api.saveSettings({ ...mapSettings(raw), autoDownload: v })
    } catch (e) { console.error('setAuto: persist failed', e); return } // checkbox stays as-is
    set(s => ({
      settings: { ...s.settings, autoDownload: v }, // display value (both checkboxes read it)
      // live behavior on ready cards: start / stop the countdowns (reference setAuto)
      batch: s.batch.map(i => i.status !== 'ready' || !i.info ? i
        : v ? { ...i, fmt: String(pickAutoRow(i.info.rows ?? [])), deadline: Date.now() + AUTO_MS }
            : { ...i, deadline: null }),
    }))
  },

  startItem: async (id) => {
    const it = get().batch.find(i => i.id === id)
    if (!it || it.status !== 'ready' || !it.info) return
    get().patchItem(id, { status: 'starting', deadline: null, parsingSince: undefined })
    try {
      await get().startDownload({
        url: it.info.url, kind: it.info.kind,
        filename: it.name.trim(), dir: it.dir,
        fmt: it.info.kind === 'ytdlp' ? rowFmt(it.info.rows?.[Number(it.fmt) || 0]) : '',
        referer: it.info.referer, cookies: it.info.cookies,
      })
      get().patchItem(id, { status: 'started' })
    } catch (e) {
      get().patchItem(id, { status: 'error', error: String(e) })
    }
    void get().pump()
  },

  routeParse: (p, opts) => {
    if (!p.url) return false // unidentifiable payload — no card can ever match it
    const st = get()
    const card = st.batch.find(i => i.url === p.url)
      // same video re-sent in a different url form (youtu.be/… vs watch?v=…):
      // the video id is the stable identity for ytdlp payloads
      ?? (p.kind === 'ytdlp' && p.videoId
        ? st.batch.find(i => i.info?.kind === 'ytdlp' && i.info.videoId === p.videoId)
        : undefined)
    const auto = st.settings.autoDownload
    const defaultFmt = (rows: ParsePayload['rows']) =>
      p.kind === 'ytdlp' ? String(auto ? pickAutoRow(rows ?? []) : 0) : ''
    if (!card) {
      const removedAt = recentlyRemoved.get(p.url)
      if (removedAt && Date.now() - removedAt < REMOVE_TTL) return false
      const item: BatchItem = {
        id: uid(), url: p.url,
        status: p.status === 'parsing' ? 'parsing' : p.status === 'error' ? 'error' : 'ready',
        info: p.status === 'error' ? null : p,
        name: p.status === 'ready' ? (p.filename || '') : '',
        fmt: p.status === 'ready' ? defaultFmt(p.rows) : '',
        dir: st.settings.downloadDir, open: false,
        deadline: auto && p.status === 'ready' ? Date.now() + AUTO_MS : null,
        parsingSince: p.status === 'parsing' ? Date.now() : undefined,
        error: p.status === 'error' ? (p.error || 'Could not analyze this link.') : undefined,
      }
      // extension sends (any payload without a card) create one, newest at the
      // TOP (§8); the App watcher navigates to /new on batchAdded. Boot passes
      // navigate:false (§8, no yank).
      set(s => ({
        batch: [item, ...s.batch],
        batchAdded: opts?.navigate === false ? s.batchAdded : s.batchAdded + 1,
      }))
      void get().pump()
      return true
    }
    switch (card.status) {
      case 'parsing':
        if (p.status === 'ready') {
          // fresh ready: countdown starts now when auto is on
          get().patchItem(card.id, {
            status: 'ready', info: p,
            name: card.nameDirty ? card.name : (p.filename || card.name),
            fmt: card.fmt !== '' ? card.fmt : defaultFmt(p.rows),
            deadline: auto ? Date.now() + AUTO_MS : null,
          })
        } else if (p.status === 'error') {
          get().patchItem(card.id, { status: 'error', deadline: null, parsingSince: undefined, error: p.error || 'Could not analyze this link.' })
        } else {
          get().patchItem(card.id, { info: p }) // 'parsing' snapshot refresh
        }
        break
      case 'ready':
        // probe/refresh merge: keep fmt + deadline (classic links emit a second
        // payload when the HEAD probe lands — never restart the countdown)
        if (p.status === 'ready') {
          get().patchItem(card.id, {
            info: { ...(card.info ?? p), ...p },
            name: card.nameDirty ? card.name : (p.filename || card.name),
          })
        }
        break // a late error for an already-ready card is stale — ignore
      case 'error':
        // a re-analysis of the same url succeeded — revive the card
        if (p.status === 'ready') {
          get().patchItem(card.id, {
            status: 'ready', info: p, error: undefined,
            name: card.nameDirty ? card.name : (p.filename || card.name),
            fmt: card.fmt !== '' ? card.fmt : defaultFmt(p.rows),
            deadline: auto ? Date.now() + AUTO_MS : null,
          })
        }
        break
      default: break // starting / started: a card being started is untouched
    }
    void get().pump() // the slot may have freed — start the next waiting card
    return true
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
    const raw = JSON.stringify(jobs)
    if (raw === lastJobsJson) return // idle list (e.g. all completed) → no reconcile, no re-render
    lastJobsJson = raw
    set(s => {
      const prev = new Map(s.downloads.map(d => [d.id, d]))
      const next = jobs.map(j => mapJob(j, prev.get(j.id)))
      next.sort((a, b) => b.createdAt - a.createdAt) // newest-ADDED first (§8); rows never reshuffle on progress
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
    if (p) get().routeParse(p) // route the payload into the batch cards by url
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

/* Batch countdown driver (STEP2): every 200 ms fire any card whose deadline has
   passed, and fail cards stuck in 'parsing' (their slot was replaced by another
   send — the payload for them can then never arrive; a late success still
   revives the card via routeParse). Also prunes the recentlyRemoved map. */
function tickBatch(get: () => S) {
  const st = get()
  const now = Date.now()
  for (const it of st.batch) {
    if (it.deadline !== null && now >= it.deadline) void st.startItem(it.id)
    else if (it.status === 'parsing' && it.parsingSince !== undefined && now - it.parsingSince > PARSE_STUCK_MS) {
      st.patchItem(it.id, { status: 'error', error: 'Analysis timed out — try again', parsingSince: undefined })
      void st.pump()
    }
  }
  for (const [u, t] of recentlyRemoved) if (now - t > REMOVE_TTL) recentlyRemoved.delete(u)
}

function mockTicker(get: () => S) {
  setInterval(() => get().downloads.filter(d => d.status === 'downloading' || d.status === 'queued').forEach(d => {
    const segs = d.segments.map(s => ({ ...s, progress: Math.min(100, s.progress + Math.random() * 6) }))
    const avg = segs.reduce((a, s) => a + s.progress, 0) / (segs.length || 1)
    get().patch(d.id, { segments: segs, downloaded: d.size * avg / 100, speed: 2e6 + Math.random() * 3e6, status: avg >= 100 ? 'completed' : 'downloading' })
  }), 500)
}
