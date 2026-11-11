/* Global app state (zustand): current page + the engine's sticky parse slot +
   the refreshable download list. Pages read from here instead of prop-drilling. */
import { create } from "zustand";

/** 'main' | 'parse' | 'settings' */
export const useApp = create((set) => ({
  page: "main",
  jobs: [],
  selected: null,
  parse: null, // parse-page payload from the engine (kind/status/rows/…)
  parseSeq: 0, // monotonic slot counter (dedupes event vs. poll)

  setPage: (page) => set({ page }),
  setJobs: (jobs) => set({ jobs }),
  setSelected: (selected) => set({ selected }),
    /// payload = null → new slot seq without content (engine acked/cleared)
  setParse: (payload, seq) => set((st) => ({
    parse: payload ?? (seq === undefined ? st.parse : null),
    parseSeq: seq ?? st.parseSeq,
  })),
}));

/** newest-seq-wins: true if `seq` is strictly newer than what we hold */
export function isNewerParseSeq(seq) {
  return seq > useApp.getState().parseSeq;
}
