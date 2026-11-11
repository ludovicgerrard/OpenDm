/* Tauri bridge: global API (withGlobalTauri), thin wrappers + event tap. */

export const invoke = (cmd, args) =>
  window.__TAURI__?.core?.invoke(cmd, args) ?? Promise.reject("tauri api unavailable");

function listenJob(handler) {
  if (window.__TAURI__?.event?.listen) {
    return window.__TAURI__.event.listen("job-update", (e) => handler(e.payload || {}));
  }
  return Promise.resolve(() => {});
}

/** Generic event listener (parse-state / dl-log / tool-update). */
export function listenEvent(name, handler) {
  if (window.__TAURI__?.event?.listen) {
    return window.__TAURI__.event.listen(name, (e) => handler(e.payload || {}));
  }
  return Promise.resolve(() => {});
}

export const api = {
  list: () => invoke("list_jobs"),
  detail: (id) => invoke("job_details", { id }),
  add: (url, referer, filename, folder) => invoke("add_download", { url, referer, filename, folder }),
  pause: (id) => invoke("pause_job", { id }),
  resume: (id) => invoke("resume_job", { id }),
  stop: (id) => invoke("stop_job", { id }),
  remove: (id) => invoke("remove_job", { id, delFiles: false }),
  openFile: (id) => invoke("open_file", { id }),
  openFolder: (id) => invoke("open_folder", { id }),
  settings: () => invoke("get_settings"),
  saveSettings: (s) => invoke("save_settings", s),
  // --- YouTube tools (yt-dlp manager) ---
  ytStatus: () => invoke("yt_status"),
  ytInstall: (tool, operation) => invoke("yt_install_tool", { tool, operation }),
  setChannel: (channel) => invoke("set_ytdlp_channel", { channel }),
  // --- parse page (every download passes through the parse stage) ---
  parseState: () => invoke("parse_state"),
  parseClear: () => invoke("parse_clear"),
  /** kind: 'ytdlp' | 'classic'; fmt: yt-dlp -f selector ('' = auto) */
  parseConfirm: (url, kind, filename, fmt, referer, cookies) =>
    invoke("parse_confirm", { url, kind, filename, fmt, referer, cookies }),
  ytLog: (id) => invoke("yt_log", { id }),
  listenJob,
  listenEvent,
};

export function fmtSize(b) {
  if (!b || b <= 0) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0; let v = Number(b);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

export function fmtSpeed(b) {
  return !b || b < 1 ? "" : `${fmtSize(b)}/s`;
}

export function pctOf(done, total) {
  if (!total || total <= 0 || done > total) return total > 0 ? 100 : 0;
  return Math.min(100, Math.round((done / total) * 100));
}

export function fmtEta(speed, done, total) {
  if (!speed || speed < 1 || !total || total <= 0) return "";
  const left = Math.max(0, total - done) / speed;
  if (left < 5) return "5s";
  const s = Math.round(left);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export const STATE_META = {
  1: { label: "Queued",      tone: "zinc" },
  2: { label: "Downloading", tone: "blue" },
  3: { label: "Paused",      tone: "amber" },
  4: { label: "Done",        tone: "emerald" },
  5: { label: "Error",       tone: "red" },
};

export async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; }
  catch { return false; }
}
