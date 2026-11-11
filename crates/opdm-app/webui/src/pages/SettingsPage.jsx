/* Settings page — scrollable full page (was a dialog). General engine
   settings plus a YouTube-tools manager section in the yt-dlp-gui style:
   per-tool status (installed/version/path), download progress, and
   Install/Update buttons driven by tool-update events. */

import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, AlertTriangle, HardDriveDownload, RefreshCw } from "lucide-react";
import { api, listenEvent, fmtSize } from "../lib/api";
import { Button } from "../components/ui/button.jsx";
import { Field, Input } from "../components/ui/input.jsx";
import { cn } from "../lib/cn";

export function SettingsPage({ notify }) {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  // YouTube tools: managed yt-dlp / Deno / FFmpeg+FFprobe + release channel
  const [yt, setYt] = useState(null);            // { tools:[ToolStatus], channel }
  const [toolProg, setToolProg] = useState({});  // tool → { operation, stage, percent, error, downloaded?, total? }

  useEffect(() => {
    api.settings().then(setS).catch(() => setS(null));
    api.ytStatus().then(setYt).catch(() => setYt(null));
    // live install/update progress → rerender the busy tool; refresh at completion
    const off = listenEvent("tool-update", (p) => {
      setToolProg((prev) => ({ ...prev, [p.tool]: { ...p } }));
      if (p.stage === "complete" || p.stage === "error") {
        api.ytStatus().then(setYt).catch(() => {});
      }
    });
    return () => { off.then?.((f) => f?.()); };
  }, []);

  const save = async () => {
    if (!s || busy) return;
    setBusy(true);
    try {
      await api.saveSettings({
        port: Number(s.port) || 9100,
        maxSegments: Number(s.max_segments) || 8,
        downloadDir: s.download_dir,
        userAgent: s.user_agent,
        integrateTakeover: !!s.integrate_takeover,
      });
      notify("Settings saved");
    } catch (e) { notify(String(e).slice(0, 80)); }
    setBusy(false);
  };

  const anyBusy = Object.values(toolProg).some((p) => p.stage && p.stage !== "complete" && p.stage !== "error");

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-xl space-y-6 px-6 pb-16 pt-5">

        {/* ---------- general ---------- */}
        <Section title="General" sub="Engine and capture settings.">
          {!s ? (
            <div className="py-4 text-center text-[12px] text-zinc-500">Loading…</div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Capture port"><Input type="number" value={s.port} onChange={(e) => setS({ ...s, port: e.target.value })} /></Field>
                <Field label="Max segments (1–16)"><Input type="number" value={s.max_segments} onChange={(e) => setS({ ...s, max_segments: e.target.value })} /></Field>
              </div>
              <Field label="Download folder"><Input value={s.download_dir} onChange={(e) => setS({ ...s, download_dir: e.target.value })} spellCheck={false} /></Field>
              <Field label="User agent"><Input value={s.user_agent} onChange={(e) => setS({ ...s, user_agent: e.target.value })} spellCheck={false} /></Field>
              <label className="flex items-center gap-2 text-[12px] text-zinc-300">
                <input type="checkbox" className="h-3.5 w-3.5 accent-blue-600" checked={!!s.integrate_takeover}
                  onChange={(e) => setS({ ...s, integrate_takeover: e.target.checked })} />
                Take over downloads started by the browser (like IDM)
              </label>
              <div className="flex justify-end border-t border-white/10 pt-3">
                <Button variant="default" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save settings"}</Button>
              </div>
            </>
          )}
        </Section>

        {/* ---------- YouTube tools ---------- */}
        <Section title="YouTube tools (yt-dlp)" sub={YOTools_SUB}>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Release channel</span>
            <select
              className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-zinc-200 outline-none"
              value={yt?.channel || "stable"}
              disabled={anyBusy}
              onChange={async (e) => {
                try { await api.setChannel(e.target.value); } catch {}
                api.ytStatus().then(setYt).catch(() => {});
              }}>
              <option value="stable">stable</option>
              <option value="nightly">nightly</option>
              <option value="master">master</option>
            </select>
          </div>

          <div className="space-y-2">
            <ToolCard tool="yt-dlp" yt={yt} prog={toolProg} notify={notify} />
            <ToolCard tool="deno" yt={yt} prog={toolProg} notify={notify} />
            <ToolCard tool="ffmpeg" yt={yt} prog={toolProg} notify={notify} />
            <ToolCard tool="ffprobe" yt={yt} prog={toolProg} notify={notify} />
          </div>
        </Section>
      </div>
    </main>
  );
}

const YOTools_SUB = "Needed to download YouTube videos: yt-dlp does the download, Deno runs YouTube's JS solver, FFmpeg merges video+audio. Extends each tool with a progress bar and an Update path.";

function Section({ title, sub, children }) {
  return (
    <section className="space-y-3 rounded-xl border border-white/10 bg-white/[.02] p-4">
      <div>
        <h2 className="text-[13px] font-semibold">{title}</h2>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-zinc-500">{sub}</p>
      </div>
      {children}
    </section>
  );
}

const TOOL_LABEL = {
  "yt-dlp": "yt-dlp",
  deno: "Deno",
  ffmpeg: "FFmpeg",
  ffprobe: "FFprobe",
};
const TOOL_DESK = {
  "yt-dlp": "Downloader core — parses pages and runs the transfer (managed: GitHub releases).",
  deno: "JavaScript runtime needed by yt-dlp for YouTube (managed: Deno zip).",
  ffmpeg: "Merges the selected video+audio streams into one file (installing FFprobe fetches this too).",
  ffprobe: "Reads media info for merge/post-processing (installing FFmpeg fetches this too, GitHub ffmpeg-static).",
};
/** FFmpeg and FFprobe are two binaries served by one archive download. */
function ctas(tool) { return tool === "ffmpeg" || tool === "ffprobe" ? "ffmpeg" : tool; }

function ToolCard({ tool, yt, prog, notify }) {
  const st = yt?.tools?.find((t) => t.tool === tool);
  const p = prog[tool];
  const busyOr = p && p.stage !== "complete" && p.stage !== "error";
  const downloading = p?.stage === "downloading";
  const installingOr = p?.stage === "installing";
  const failed = p?.stage === "error";
  const done = p?.stage === "complete";
  const updable = !!st?.can_update && !busyOr;

  const statusLine = busyOr
    ? `${downloading ? "Downloading" : "Installing"}${p.percent != null && p.percent >= 0 ? ` ${Math.round(p.percent)}%` : "…"}`
    : failed
      ? `Failed: ${String(p.error || "unknown").slice(0, 80)}`
      : done
        ? "Done — ready to use"
        : st?.runnable
          ? (st.version ? `v${st.version}` : "installed")
          : st?.installed
            ? "present but not runnable"
            : "not installed";

  return (
    <div className="space-y-1.5 rounded-lg border border-white/10 bg-white/[.03] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] font-semibold text-zinc-200">{TOOL_LABEL[tool] || tool}</span>
            {st?.runnable && !busyOr && <CheckCircle2 size={13} className="text-emerald-400" />}
            {!st?.installed && !busyOr && !failed && <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-600">not installed</span>}
            {failed && <AlertTriangle size={13} className="text-red-400" />}
          </div>
          <div className={cn("truncate text-[10.5px]", failed && "text-red-300")}>{statusLine}</div>
          <div className="truncate font-mono text-[10px] text-zinc-600" title={st?.path || ""}>
            {st?.path || "managed download on first use"}
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {updable && (
            <Button size="sm" variant="outline" onClick={async () => {
              try { await api.ytInstall(ctas(tool), "update"); } catch (e) { notify?.(String(e).slice(0, 90)); }
            }}><RefreshCw size={12} /> Update</Button>
          )}
          {!st?.runnable && (
            <Button size="sm" variant="default" disabled={busyOr} onClick={async () => {
              try { await api.ytInstall(ctas(tool), "install"); } catch (e) { notify?.(String(e).slice(0, 90)); }
            }}>
              {busyOr ? <Loader2 size={12} className="animate-spin" /> : <HardDriveDownload size={12} />}
              {st?.installed ? "Fix" : "Install"}
            </Button>
          )}
        </div>
      </div>

      {(busyOr) && (
        <div className="space-y-1">
          <div className="h-1 overflow-hidden rounded bg-white/10">
            <div className={cn("h-full bg-blue-500 transition-all duration-300",
              p.percent == null || p.percent < 0 ? "w-1/3 indeterminate" : "")}
              style={{ width: p.percent != null && p.percent >= 0 ? `${Math.min(100, Math.round(p.percent))}%` : undefined }} />
          </div>
          <div className="text-right text-[10px] tabular-nums text-zinc-600">
            {p.downloaded && p.total ? `${fmtSize(p.downloaded)} / ${fmtSize(p.total)}` : ""}
          </div>
        </div>
      )}
    </div>
  );
}
