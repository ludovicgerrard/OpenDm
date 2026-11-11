/* Bottom-fixed details dock. Always visible once the list has jobs (not
   hideable — no close button), scrollable, with a collapsible yt-dlp task
   log for YouTube jobs (repo DownloadCard pattern). */

import { useEffect, useState } from "react";
import { Copy, FolderOpen, ExternalLink, Trash2, Pause, Play, FileVideo, Loader2 } from "lucide-react";
import { cn } from "../lib/cn";
import { api, fmtSize, fmtSpeed, fmtEta, pctOf, STATE_META, copyText } from "../lib/api";
import { Badge } from "./ui/badge.jsx";
import { Progress } from "./ui/progress.jsx";
import { Button } from "./ui/button.jsx";
import { TaskLog } from "./TaskLog.jsx";

function Row({ k, v, mono = false, trunc = true }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 py-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{k}</span>
      <span className={cn("text-[12px] text-zinc-200", mono && "font-mono", trunc && "truncate")} title={typeof v === "string" ? v : ""}>
        {v || <span className="text-zinc-500">—</span>}
      </span>
    </div>
  );
}

/** dlman-style segment visualization: one mini bar per Range part. */
function SegmentGrid({ segs }) {
  if (!segs?.length) return null;
  return (
    <div className="flex h-2 gap-[2px] overflow-hidden rounded">
      {segs.map((s) => (
        <span key={s.idx} className="relative h-full flex-1 overflow-hidden rounded-[2px] bg-white/10">
          <span
            className={cn("absolute inset-0", s.done ? "bg-emerald-500" : "bg-blue-500")}
            style={{ width: `${Math.round((s.frac || 0) * 100)}%` }}
          />
        </span>
      ))}
    </div>
  );
}

/** HLS: tiny squares per segment (cap display to 80 for perf). */
function HlsGrid({ hls }) {
  if (!hls || !hls.total) return null;
  const n = Math.min(hls.total, 80);
  const per = hls.total / n;
  const doneShown = Math.min(n, Math.round(hls.done / per));
  const cols = Math.min(n, 40);
  return (
    <div className="grid gap-[2px]" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={cn("h-2 rounded-[2px]", i < doneShown ? "bg-blue-500" : "bg-white/10")} />
      ))}
    </div>
  );
}

export function DetailsDock({ id, onOp, notify }) {
  const [d, setD] = useState(null);

  const load = async () => {
    if (!id) return;
    try {
      const det = await api.detail(id);
      if (det) setD(det);
    } catch { /* window may be closing */ }
  };

  useEffect(() => {
    setD(null);
    load();
    const t = setInterval(load, 600); // detail view polls faster than the list
    const off = window.__TAURI__?.event?.listen?.("job-update", () => load()) ?? null;
    return () => { clearInterval(t); (off ? off.then((f) => f?.()) : null); };
  }, [id]);

  const meta = STATE_META[d?.state] ?? STATE_META[1];
  const running = d?.state === 2;
  const pct = pctOf(d?.done, d?.total);
  const eta = fmtEta(d?.speed, d?.done, d?.total);
  const merging = running && d?.kind === "ytdlp" && d?.stage === "merging";
  const host = (() => { try { return new URL(d?.url || "").host; } catch { return ""; } })();
  const KIND_LABEL = { ytdlp: "YouTube · yt-dlp", hls: "HLS · m3u8", range: "HTTP · range" };

  return (
    <aside className="relative z-20 flex h-full flex-col border-t border-white/10 bg-zinc-900/95">
      {/* header */}
      <div className="flex shrink-0 items-start gap-2 border-b border-white/10 px-4 py-2.5">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/5 text-blue-400 ring-1 ring-inset ring-white/10">
          <FileVideo size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">{d?.name ?? "Select a download"}</div>
          <div className="truncate text-[11px] text-zinc-500">{host}</div>
        </div>
      </div>

      {!d && <div className="flex flex-1 items-center justify-center text-[12px] text-zinc-600">—</div>}

      {d && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {/* progress block */}
          <div className="space-y-2 rounded-xl border border-white/10 bg-white/[.03] p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Badge tone={merging ? "amber" : meta.tone} withDot={running}>{merging ? "Merging" : meta.label}</Badge>
                {merging && <Loader2 size={12} className="animate-spin text-amber-300" />}
              </div>
              <span className="text-lg font-semibold tabular-nums">{pct}%</span>
            </div>
            <Progress value={pct} indeterminate={running && (!d.total || d.total <= 0)} />
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-[13px] font-medium tabular-nums">{fmtSize(d.done)}</div>
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">Done</div>
              </div>
              <div>
                <div className="text-[13px] font-medium tabular-nums">{fmtSize(d.total)}</div>
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">Size</div>
              </div>
              <div>
                <div className="text-[13px] font-medium tabular-nums">{running ? fmtSpeed(d.speed) : eta ? "" : "0"}</div>
                <div className="text-[10px] uppercase tracking-wide text-zinc-500">{running ? "Speed" : eta ? "ETA" : "—"}</div>
              </div>
            </div>
            {eta && running && (
              <div className="text-center text-[11px] text-zinc-500">~{eta} remaining</div>
            )}
          </div>

          {/* segment visualization */}
          {d.kind === "range" && d.segs?.length > 1 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                <span>Segments</span><span className="tabular-nums text-zinc-400">{d.segs.length} parts</span>
              </div>
              <SegmentGrid segs={d.segs} />
            </div>
          )}
          {d.kind === "hls" && d.hls?.total > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                <span>HLS segments</span>
                <span className="tabular-nums text-zinc-400">{d.hls.done}/{d.hls.total}</span>
              </div>
              <HlsGrid hls={d.hls} />
            </div>
          )}

          {/* yt-dlp task log (collapsible; opens itself when the job errors) */}
          <TaskLog id={d.id} kind={d.kind} errored={d.state === 5} />

          {/* error */}
          {d.error && (
            <div className="rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2 text-[12px] leading-relaxed text-red-300">
              {d.error}
            </div>
          )}

          {/* metadata */}
          <div className="space-y-0.5 rounded-xl border border-white/10 bg-white/[.03] p-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Details</span>
              <div className="flex gap-1">
                <Badge tone="zinc">{KIND_LABEL[d.kind] || "HTTP · range"}</Badge>
                {d.cookiesSent && <Badge tone="zinc">cookies</Badge>}
              </div>
            </div>
            <Row k="URL" v={d.url} mono />
            {d.referer && <Row k="Referer" v={d.referer} mono />}
            <Row k="Folder" v={d.folder} mono />
          </div>
        </div>
      )}

      {/* actions pinned at the bottom of the dock */}
      {d && (
        <div className="flex shrink-0 flex-wrap gap-1.5 border-t border-white/10 px-4 py-2">
          {running
            ? <Button variant="outline" onClick={() => onOp(d.id, "pause")}><Pause size={14} /> Pause</Button>
            : (d.state === 1 || d.state === 3 || d.state === 5) &&
              <Button variant="outline" onClick={() => onOp(d.id, "resume")}><Play size={14} /> {d.state === 5 ? "Retry" : "Resume"}</Button>}
          <Button variant="ghost" onClick={() => onOp(d.id, "openFile")}><ExternalLink size={14} /> Open file</Button>
          <Button variant="ghost" onClick={() => onOp(d.id, "openFolder")}><FolderOpen size={14} /> Open folder</Button>
          <Button variant="ghost" onClick={async () => { notify((await copyText(d.url)) ? "URL copied" : "Copy failed"); }}>
            <Copy size={14} /> Copy URL
          </Button>
          <Button variant="danger" className="ml-auto" onClick={() => onOp(d.id, "remove")}><Trash2 size={14} /> Remove</Button>
        </div>
      )}
    </aside>
  );
}
