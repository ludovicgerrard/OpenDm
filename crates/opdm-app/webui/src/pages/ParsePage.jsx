/* Parse page — every download passes through here (extension sends, paste,
   New button). YouTube URLs resolve through `yt-dlp -J` (metadata + quality
   rows), classic URLs appear instantly with a HEAD probe (size/type) and an
   editable filename. The slot is sticky in the engine: events + polling both
   land here. */

import { useEffect, useRef, useState } from "react";
import { Loader2, Film, Download as DownloadIcon, X, ArrowLeft } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { cn } from "../lib/cn";

function fmtDuration(secs) {
  const s = Math.round(Number(secs) || 0);
  if (!s) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

function fmtBytes(b) {
  if (!b || b <= 0) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0; let v = Number(b);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

/** Map a quality row to a yt-dlp -f selector. "" = let yt-dlp pick (best). */
function rowFmt(row) {
  if (!row || row.note === "best") return "";
  if (row.note === "audio") return row.a || "";
  if (row.note === "video") return row.a ? `${row.v}+${row.a}` : `${row.v}+bestaudio`;
  return row.v || "";
}

export function ParsePage({ notify }) {
  const parse = useApp((s) => s.parse);
  const setPage = useApp((s) => s.setPage);
  const setParse = useApp((s) => s.setParse);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [manualUrl, setManualUrl] = useState("");
  const [name, setName] = useState("");       // editable filename
  const touchedName = useRef(false);          // don't clobber user edits on probe updates

  /* sync the editable filename each time a NEW payload arrives */
  const seq = parse?.seq ?? 0;
  useEffect(() => {
    if (parse?.filename) { setName(parse.filename); }
    touchedName.current = false;
    setSel(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq]);
  useEffect(() => {
    if (!touchedName.current && parse?.filename) setName(parse.filename);
  }, [parse?.filename]);

  /* belt-and-braces: one immediate state fetch on mount (in case events were
     missed while this page wasn't mounted — App's poll covers the rest) */
  useEffect(() => {
    api.parseState().then((r) => {
      if (r && r.payload && r.seq > useApp.getState().parseSeq) {
        setParse(r.payload, r.seq);
      }
    }).catch(() => {});
  }, [setParse]);

  const cancel = async () => {
    try { await api.parseClear(); } catch { /* engine may be busy */ }
    setParse(null, useApp.getState().parseSeq); /* local ack */
    setPage("main");
  };

  const manualSend = async () => {
    const u = manualUrl.trim();
    if (!u || busy) return;
    setBusy(true);
    try {
      await api.add(u, null, null, null);
      // engine will emit parse-state → App flips us into the resolved view
    } catch (e) {
      notify(String(e).slice(0, 90));
    }
    setBusy(false);
  };

  const download = async () => {
    if (!parse || parse.status !== "ready" || busy) return;
    setBusy(true);
    try {
      await api.parseConfirm(
        parse.url, parse.kind, name.trim() || null,
        parse.kind === "ytdlp" ? rowFmt(parse.rows?.[sel]) : "",
        parse.referer || null, parse.cookies || null,
      );
      setPage("main");
      notify(parse.kind === "ytdlp" ? "Queued" : "Added to queue");
    } catch (e) {
      notify(String(e).slice(0, 120));
    }
    setBusy(false);
  };

  /* keyboard parity with the old dialog: Enter = download, Esc = cancel */
  useEffect(() => {
    const k = (e) => {
      if (e.key === "Escape") cancel();
      const ready = parse?.status === "ready" && !busy;
      const typing = document.activeElement === document.getElementById("parse-url-manual");
      if (!typing && !ready) return;
      if (e.key === "Enter") {
        if (typing && manualUrl.trim()) manualSend();
        else if (ready) download();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parse, busy, manualUrl]);

  /* ---------- render ---------- */
  if (!parse) {
    return (
      <main className="min-h-0 flex-1 overflow-y-auto">
        <section className="mx-auto flex h-full max-w-xl flex-col justify-center px-6 pb-16">
          <BackBar onClick={cancel} label="Back to downloads" />
          <h2 className="text-[15px] font-semibold">New download</h2>
          <p className="mt-1 text-[12px] text-zinc-500">
            Paste a link (YouTube, video, file — anything works). Review and rename it below before it starts.
          </p>
          <div className="mt-4 flex gap-2">
            <Input id="parse-url-manual" value={manualUrl}
              onChange={(e) => setManualUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && manualSend()}
              placeholder="https://…" autoFocus spellCheck={false}
              style={{ color: "white", borderColor: "rgba(255,255,255,.14)" }} />
            <Button variant="default" disabled={busy || !manualUrl.trim()} onClick={manualSend}>
              Next
            </Button>
          </div>
        </section>
      </main>
    );
  }

  const { kind, status } = parse;
  const size = parse.probe?.totalBytes;
  const type = parse.probe?.type;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <section className="mx-auto max-w-xl space-y-4 px-6 py-6">
        <BackBar onClick={cancel} label={kind === "ytdlp" ? "Cancel" : "Back to downloads"} />

        {/* ---- status: parsing ---- */}
        {status === "parsing" && (
          <div className="flex items-center gap-3 py-6 text-[13px] text-zinc-300">
            <Loader2 className="animate-spin text-blue-400" size={18} />
            <div>
              <div>Parsing the page with yt-dlp…</div>
              <div className="mt-0.5 text-[11px] text-zinc-500">Fetching title, duration and available qualities.</div>
            </div>
          </div>
        )}

        {/* ---- status: error ---- */}
        {status === "error" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-[13px] font-medium text-red-300">
              <X size={15} /> {kind === "ytdlp" ? "yt-dlp could not parse this video" : "Could not read this URL"}
            </div>
            <div className="rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2 text-[12px] leading-relaxed text-red-300 break-all">
              {parse.error || "unknown error"}
            </div>
            <Button variant="ghost" onClick={cancel}>Back</Button>
          </div>
        )}

        {/* ---- status: ready ---- */}
        {status === "ready" && kind === "ytdlp" && (
          <>
            <div className="flex gap-3">
              {parse.thumbnail
                ? <img src={parse.thumbnail} alt=""
                    className="h-[86px] w-[152px] shrink-0 rounded-lg border border-white/10 bg-black/40 object-cover" />
                : <div className="flex h-[86px] w-[152px] shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/40">
                    <Film size={26} className="text-zinc-600" />
                  </div>}
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-[13px] font-semibold leading-snug">{parse.title}</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
                  {parse.uploader && <span className="truncate">{parse.uploader}</span>}
                  {!!parse.duration && <span>· {fmtDuration(parse.duration)}</span>}
                </div>
              </div>
            </div>

            <label className="block space-y-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">File name</span>
              <Input value={name} onChange={(e) => { touchedName.current = true; setName(e.target.value); }}
                spellCheck={false} style={{ color: "white", borderColor: "rgba(255,255,255,.14)" }} />
              <span className="block text-[10.5px] text-zinc-600">Container (.mp4/.webm) is chosen automatically.</span>
            </label>

            <div className="max-h-[220px] space-y-1 overflow-y-auto pr-1">
              {(parse.rows || []).map((r, i) => (
                <button key={i} onClick={() => setSel(i)}
                  className={cn("flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-[12px] transition-colors",
                    i === sel ? "border-blue-400/50 bg-blue-500/15 text-zinc-100" : "border-white/10 bg-white/[.03] text-zinc-300 hover:bg-white/[.06]")}>
                  <span className={cn("flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
                    i === sel ? "border-blue-400 bg-blue-500" : "border-white/25")}>
                    {i === sel && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{r.label}</span>
                  {!!r.size && (
                    <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">
                      {r.approx ? "~" : ""}{fmtBytes(r.size)}
                    </span>
                  )}
                  {r.note === "best" && <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">recommended</span>}
                  {r.note === "video" && <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-amber-300">merge</span>}
                </button>
              ))}
            </div>
          </>
        )}

        {status === "ready" && kind === "classic" && (
          <>
            <div className="space-y-0.5 rounded-xl border border-white/10 bg-white/[.03] p-3">
              <div className="text-[13px] font-semibold leading-snug break-all">{parse.filename}</div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
                <span className="break-all">{parse.url}</span>
                {!!size && <span>· {fmtBytes(size)}</span>}
                {!!type && <span>· {type}</span>}
              </div>
            </div>

            <label className="block space-y-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">File name</span>
              <Input value={name} onChange={(e) => { touchedName.current = true; setName(e.target.value); }}
                spellCheck={false} style={{ color: "white", borderColor: "rgba(255,255,255,.14)" }} />
            </label>
          </>
        )}

        {/* footer: Download / Cancel */}
        {status === "ready" && (
          <div className="flex items-center justify-end gap-2 border-t border-white/10 pt-3">
            <Button variant="ghost" onClick={cancel}>Cancel</Button>
            <Button id="parse-dl-btn" variant="default" disabled={busy} onClick={download}>
              <DownloadIcon size={14} /> {busy ? "Starting…" : "Download"}
            </Button>
          </div>
        )}
      </section>
    </main>
  );
}

function BackBar({ onClick, label }) {
  return (
    <button onClick={onClick}
      className="mb-1 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200">
      <ArrowLeft size={14} /> {label}
    </button>
  );
}
