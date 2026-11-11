/**
 * Per-job log ring buffer — direct port of yt-dlp-gui's src/utils/logs.ts.
 *
 * yt-dlp subprocess output is unbounded (long tasks / playlists can reach
 * thousands of lines); keeping it all in memory would make rendering lag.
 * "head + tail" truncation: keep the first 50 lines (the [download]
 * Destination lines that locate the file) plus the latest tail, drop the
 * middle and insert a "..." marker line.
 */
import { create } from "zustand";

/** max lines kept in memory for one task */
export const MAX_TASK_LOGS = 500;
/** head lines permanently kept when truncating */
export const HEAD_TASK_LOGS = 50;
/** truncation placeholder (plain "..." — language independent) */
export const LOG_TRUNCATED_MARKER = "...";

/** push one line into the ring (mutates the array in place, like the repo) */
const pushTaskLog = (logs, line) => {
  if (logs[HEAD_TASK_LOGS] === LOG_TRUNCATED_MARKER) {
    // steady state: drop the oldest tail line after the marker
    logs.splice(HEAD_TASK_LOGS + 1, 1);
  } else if (logs.length >= MAX_TASK_LOGS) {
    // first time over the cap: swap the tail's oldest line for the marker
    logs.splice(HEAD_TASK_LOGS, 1);
    logs.splice(HEAD_TASK_LOGS, 0, LOG_TRUNCATED_MARKER);
    logs.splice(HEAD_TASK_LOGS + 1, 1);
  }
  logs.push(line);
};

/** trim an already-existing log array (hydrate from the engine log file) */
const trimTaskLogs = (logs) => {
  const clean = logs.filter((line) => line !== LOG_TRUNCATED_MARKER);
  if (clean.length <= MAX_TASK_LOGS) {
    logs.length = 0;
    logs.push(...clean);
    return;
  }
  const head = clean.slice(0, HEAD_TASK_LOGS);
  const tail = clean.slice(-(MAX_TASK_LOGS - HEAD_TASK_LOGS - 1));
  logs.length = 0;
  logs.push(...head, LOG_TRUNCATED_MARKER, ...tail);
};

/** jobs whose engine log file (yt_log) we already merged in */
const hydrated = new Set();

export const useLogs = create((set, get) => ({
  map: {}, // id → string[]
  push(id, line) {
    const prev = get().map[id] ?? [];
    const arr = prev.slice();
    pushTaskLog(arr, line);
    set({ map: { ...get().map, [id]: arr } });
  },
  /** replace the buffer with the engine's log.txt (authoritative, tail-capped) */
  hydrate(id, text) {
    const arr = String(text || "").split("\n");
    if (arr.length && arr[arr.length - 1] === "") arr.pop();
    trimTaskLogs(arr);
    hydrated.add(id);
    set({ map: { ...get().map, [id]: arr } });
  },
  has(id) {
    return !!get().map[id]?.length;
  },
}));

/** engine log.txt hydrate-once per (job); live lines arrive via dl-log events */
export const hydrateOnce = (id, text) => {
  if (hydrated.has(id) || !text) return;
  useLogs.getState().hydrate(id, text);
};
