/* Main page — download list + the bottom-fixed details dock. */

import { useEffect } from "react";
import { Download } from "lucide-react";
import { useApp } from "../store";
import { JobRow, ListHeader } from "../components/JobRow.jsx";
import { DetailsDock } from "../components/DetailsDock.jsx";

export function MainPage({ onOp, notify }) {
  const jobs = useApp((s) => s.jobs);
  const selected = useApp((s) => s.selected);
  const setSelected = useApp((s) => s.setSelected);

  /* auto-select: dock must always hold a job once the list is non-empty */
  useEffect(() => {
    if (!jobs.length) { if (selected) setSelected(null); return; }
    if (!selected || !jobs.some((j) => j.id === selected)) {
      setSelected(jobs[0].id);
    }
  }, [jobs, selected, setSelected]);

  return (
    <>
      {/* list (shrinks above the dock) */}
      <main className="min-h-0 flex-1 overflow-y-auto">
        <ListHeader />
        {jobs.map((j) => (
          <JobRow key={j.id} j={j} selected={selected === j.id} onSelect={setSelected} onOp={onOp} />
        ))}
        {jobs.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Download size={44} className="text-zinc-700" />
            <div>
              <div className="text-[13px] font-medium text-zinc-400">No downloads yet</div>
              <div className="mt-1 text-[12px] text-zinc-600">
                Send one from the browser extension, or press +New to paste a link.
              </div>
            </div>
          </div>
        )}
      </main>

      {/* bottom-fixed details dock: always visible, scrollable, not hideable */}
      <div className="h-[40vh] min-h-[270px] shrink-0">
        <DetailsDock id={selected ?? undefined} onOp={onOp} notify={notify} />
      </div>
    </>
  );
}
