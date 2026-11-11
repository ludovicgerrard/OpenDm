/* Collapsible task log — port of yt-dlp-gui's DownloadCard.vue log area:
   chevron toggle, copy button, ~200px box auto-scrolled to the bottom,
   lines streamed one by one via dl-log events and hydrated from the
   engine's log file when the panel first opens. */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Copy } from "lucide-react";
import { api, copyText } from "../lib/api";
import { useLogs, hydrateOnce, LOG_TRUNCATED_MARKER } from "../lib/logs";
import { Button } from "./ui/button.jsx";
import { cn } from "../lib/cn";

export function TaskLog({ id, kind, errored = false }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  const logs = useLogs((s) => s.map[id]);
  const isYt = kind === "ytdlp";

  /* a failed job: surface the reason automatically (open the log once) */
  useEffect(() => {
    if (errored) setOpen(true);
  }, [errored]);

  /* hydrate once from the engine's log.txt (past/finished jobs too) */
  useEffect(() => {
    if (!isYt || !id) return;
    api.ytLog(id).then((t) => hydrateOnce(id, t)).catch(() => {});
  }, [id, isYt]);

  /* auto-scroll to the newest line while open (repo: n-log bottom follow) */
  useEffect(() => {
    if (open) {
      const b = boxRef.current;
      if (b) b.scrollTo({ top: b.scrollHeight });
    }
  }, [logs, open]);

  if (!isYt) return null;
  const lines = logs ?? [];

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-black/25">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200">
          <span>Task log</span>
          <span className="text-[10px] tabular-nums text-zinc-600">({lines.length})</span>
          {open
            ? <ChevronUp size={13} className="text-zinc-500" />
            : <ChevronDown size={13} className="text-zinc-500" />}
        </button>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" disabled={!lines.length}
          onClick={async () => { await copyText(lines.join("\n")); }}>
          <Copy size={12} /> Copy
        </Button>
      </div>
      {open && (
        <div
          ref={boxRef}
          className="h-[200px] overflow-y-auto border-t border-white/5 px-3 py-2 font-mono text-[11px] leading-[1.5] text-zinc-400">
          {lines.length === 0 && (
            <div className="text-[11px] text-zinc-600">No log output yet.</div>
          )}
          {lines.map((line, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre-wrap break-all",
                line === LOG_TRUNCATED_MARKER && "text-zinc-600",
                /^.*(ERROR|exiting|failed)/i.test(line) && "text-red-400",
                i > 0 && line.startsWith("[download]") && "text-zinc-300",
              )}>
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
