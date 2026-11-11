import { memo } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../lib/cn";
import { fmtSize, fmtSpeed, pctOf, STATE_META } from "../lib/api";
import { Progress } from "./ui/progress.jsx";
import { Button } from "./ui/button.jsx";

const GRID = "grid grid-cols-[minmax(0,1fr)_5rem_11rem_5.5rem_auto] items-center gap-3";

export const JobRow = memo(function JobRow({ j, selected, onSelect, onOp }) {
  const meta = STATE_META[j.state] ?? STATE_META[1];
  const running = j.state === 2;
  const indet = running && (!j.total || j.total <= 0);
  const pct = pctOf(j.done, j.total);
  // yt-dlp post-processing (merging video+audio) — show as a status word
  const merging = running && j.kind === "ytdlp" && j.stage === "merging";

  const op = (e, which) => { e.stopPropagation(); onOp(j.id, which); };

  return (
    <div
      onClick={() => onSelect(j.id)}
      className={cn(
        GRID,
        "h-[56px] cursor-pointer border-b border-white/5 px-3 transition-colors duration-150",
        selected ? "bg-blue-500/10" : "hover:bg-white/[.04]",
      )}
      title={j.error || ""}
    >
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-zinc-100">{j.name}</div>
        <div className="truncate text-[11px] text-zinc-500">{j.url}</div>
      </div>
      <div className="text-right text-[12px] tabular-nums text-zinc-400">{fmtSize(j.total)}</div>
      <div className="flex items-center gap-2">
        {merging
          ? <span className="flex w-full items-center gap-1 text-[11px] font-medium text-amber-300"><Loader2 size={11} className="animate-spin" /> merging…</span>
          : <>
            <Progress value={pct} indeterminate={indet} className="w-full" />
            <span className="w-9 text-right text-[11px] tabular-nums text-zinc-400">{pct}%</span>
          </>}
      </div>
      <div className="text-right text-[12px] tabular-nums text-zinc-400">{running && !merging ? fmtSpeed(j.speed) : ""}</div>
      <div className="flex items-center gap-0.5 opacity-80 transition-opacity group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
        {running && <Button size="icon" title={merging ? "Stop" : "Pause"} onClick={(e) => op(e, "pause")}>⏸</Button>}
        {(j.state === 1 || j.state === 3 || j.state === 5) && <Button size="icon" title={j.state === 5 ? "Retry" : "Resume"} onClick={(e) => op(e, "resume")}>▶</Button>}
        {j.state === 4 && <Button size="icon" title="Open file" onClick={(e) => op(e, "openFile")}>📂</Button>}
        <Button size="icon" variant="danger" title="Remove" onClick={(e) => op(e, "remove")}>🗑</Button>
      </div>
    </div>
  );
}, (a, b) =>
  a.selected === b.selected &&
  a.j.id === b.j.id && a.j.state === b.j.state && a.j.done === b.j.done &&
  a.j.total === b.j.total && a.j.speed === b.j.speed &&
  a.j.name === b.j.name && a.j.error === b.j.error &&
  a.j.kind === b.j.kind && a.j.stage === b.j.stage &&
  a.onOp === b.onOp,
);

export function ListHeader() {
  return (
    <div className={cn(GRID, "border-b border-white/10 px-3 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-zinc-500")}>
      <div>File</div>
      <div className="text-right">Size</div>
      <div>Progress</div>
      <div className="text-right">Speed</div>
      <div />
    </div>
  );
}
