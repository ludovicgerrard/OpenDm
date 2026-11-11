/* Thin shell: header + tab routing between the three pages, shared event
   listeners (job updates, parse-state slot sync, dl-log streaming) and the
   zustand store. Pages live in src/pages/. */

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, FolderOpen, Download as DownloadIcon } from "lucide-react";
import { api } from "./lib/api";
import { useApp, isNewerParseSeq } from "./store";
import { useLogs } from "./lib/logs";
import { MainPage } from "./pages/MainPage.jsx";
import { ParsePage } from "./pages/ParsePage.jsx";
import { SettingsPage } from "./pages/SettingsPage.jsx";
import { Toast, useToast } from "./components/Toast.jsx";
import { Button } from "./components/ui/button.jsx";
import { Badge } from "./components/ui/badge.jsx";
import { Input } from "./components/ui/input.jsx";
import { cn } from "./lib/cn";

const TABS = [
  { id: "main", label: "Downloads" },
  { id: "settings", label: "Settings" },
];

export default function App() {
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const jobs = useApp((s) => s.jobs);
  const parse = useApp((s) => s.parse);
  const [toast, notify] = useToast();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  /* -------- data: diff-poll list + event-painted rows -------- */
  const refresh = useCallback(async () => {
    try {
      const list = await api.list();
      useApp.getState().setJobs(list);
    } catch { /* tauri not ready yet */ }
  }, []);

  /* "New download" entry point: parse page in manual mode (user pastes a URL) */
  const newDownload = () => {
    useApp.getState().setParse(null);
    setPage("parse");
  };

  /* header paste box: send it straight to the engine's parse stage */
  const quickAdd = async (url) => {
    const u = url.trim();
    if (!u) return;
    try {
      await api.add(u, null, null, null);
      setPage("parse"); // engine acks with parse-state; page shows resolution
    } catch (e) {
      notify(String(e).slice(0, 90));
    }
  };

  const onOp = useCallback(async (id, which) => {
    try {
      if (which === "pause") await api.pause(id);
      else if (which === "resume") await api.resume(id);
      else if (which === "remove") {
        await api.remove(id);
        notify("Removed from list");
        refresh();
      } else if (which === "openFile") { try { await api.openFile(id); } catch { await api.openFolder(id); } }
      else if (which === "openFolder") await api.openFolder(id);
    } catch (e) {
      notify(String(e).slice(0, 90));
    }
  }, [notify, refresh]);

  useEffect(() => {
    refresh();
    const net = setInterval(refresh, 1500);
    // --- parse slot: poll fallback (events can be missed while the webview boots) ---
    const poll = setInterval(async () => {
      try {
        const r = await api.parseState();
        if (r && isNewerParseSeq(r.seq)) {
          useApp.getState().setParse(r.payload || null, r.seq);
          // a fresh send always opens the parse page; an ack (empty slot) does not
          if (r.payload) setPage("parse");
        }
      } catch { /* tauri not ready */ }
    }, 1000);
    const offs = [];
    if (window.__TAURI__?.event?.listen) {
      // --- job row diffs ---
      window.__TAURI__.event.listen("job-update", (e) => {
        const p = e.payload || {};
        const st = useApp.getState();
        const i = st.jobs.findIndex((x) => x.id === p.id);
        if (i < 0) return; // new/removed rows arrive with the next diff
        const cur = st.jobs[i];
        const row = p.type === "progress"
          ? { ...cur, done: p.done, total: p.total, speed: p.speed }
          : { ...cur, state: p.state, name: p.name, error: p.error };
        const out = st.jobs.slice();
        out[i] = row;
        st.setJobs(out);
      }).then((f) => offs.push(f));
      // --- parse page payload (authoritative, instant) ---
      window.__TAURI__.event.listen("parse-state", (e) => {
        const p = e.payload || null;
        const seq = p?.seq ?? (useApp.getState().parseSeq + 1);
        const before = useApp.getState().parseSeq;
        useApp.getState().setParse(p, seq);
        // a fresh send always opens the parse page, on every page — the
        // extension's click must visibly land there ("nothing happens" if not)
        if (p && seq > before) setPage("parse");
      }).then((f) => offs.push(f));
      // --- yt-dlp subprocess log lines (stream into the dock's task log) ---
      window.__TAURI__.event.listen("dl-log", (e) => {
        const { id, line } = e.payload || {};
        if (id && line != null) useLogs.getState().push(id, line);
      }).then((f) => offs.push(f));
    }
    return () => { clearInterval(net); clearInterval(poll); offs.forEach((f) => f?.()); };
  }, [refresh, setPage]);

  const counts = jobs.reduce((a, j) => { a[j.state === 2 ? "active" : j.state === 4 ? "done" : "other"]++; return a; },
    { active: 0, done: 0, other: 0 });

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* header */}
      <header className="z-10 flex min-h-[52px] shrink-0 items-center gap-3 border-b border-white/10 bg-zinc-950/80 px-4 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-[13px] font-bold text-white shadow-sm">D</div>
          <span className="text-[14px] font-semibold tracking-tight">OpenDM</span>
        </div>
        {/* page tabs */}
        <nav className="flex gap-1 rounded-lg border border-white/10 bg-white/[.03] p-0.5">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setPage(t.id)}
              className={cn("rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
                page === t.id ? "bg-blue-600 text-white" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200")}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="hidden gap-1.5 md:flex">
          {counts.active > 0 && <Badge tone="blue" withDot>{counts.active} active</Badge>}
          {counts.other > 0 && <Badge tone="zinc">{counts.other} queued</Badge>}
        </div>
        <div className="mx-auto max-w-md min-w-0 flex-1 px-2">
          <HeaderQuickAdd onGo={quickAdd} />
        </div>
        <div className="flex items-center gap-1">
          <Button size="icon" title="Open downloads folder" onClick={() => api.openFolder(null).catch(() => {})}>
            <FolderOpen size={15} />
          </Button>
          <Button variant="default" size="md" onClick={newDownload} title="New download — review it before it starts">
            <Plus size={15} /> New
          </Button>
        </div>
      </header>

      {/* page */}
      {page === "parse"
        ? <ParsePage notify={notify} />
        : page === "settings"
          ? <div className="flex min-h-0 flex-1 flex-col"><SettingsPage notify={notify} /></div>
          : <MainPage onOp={onOp} notify={notify} />}

      {page === "parse" && !parse && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <span className="pointer-events-none flex items-center gap-1.5 rounded-full border border-white/10 bg-zinc-900/90 px-3 py-1.5 text-[11px] text-zinc-400">
            <DownloadIcon size={12} /> The download won't start until you press Download here
          </span>
        </div>
      )}

      <Toast toast={toast} />
    </div>
  );
}

/* paste box → parse stage (Enter) */
function HeaderQuickAdd({ onGo }) {
  const [v, setV] = useState("");
  return (
    <Input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && v.trim()) { setV(""); onGo(v); }
      }}
      placeholder="Paste a URL and press Enter — it opens in the download review page…"
      spellCheck={false}
      className="h-8"
    />
  );
}
