// Auto-download helpers (STEP1_AUTO_DOWNLOAD.md §1 + STEP2 §4).
// The countdown is DEADLINE-based: a card stores `Date.now() + AUTO_MS`, never
// tick counts, so the countdown stays correct when the window is hidden or the
// 200 ms store tick gets throttled (a late tick still fires the start).
import type { ParseRow } from '@/lib/backend'

/** Countdown length in seconds (spec: starts 5 s after each analysis). */
export const AUTO_SECONDS = 5
export const AUTO_MS = AUTO_SECONDS * 1000
/** Auto quality cap: 1080p, or the closest lower — never higher. */
export const AUTO_MAX_HEIGHT = 1080

/** Height parsed from a row label ("1080p — video only…", "3840x2160"). */
const rowHeight = (label: string): number => {
  const m = /(\d{3,4})p|x(\d{3,4})\b/.exec(label)
  return m ? Number(m[1] ?? m[2]) : -1
}

/** Index of the row auto-download picks: 1080p or the closest lower, NEVER
 *  audio-only. Falls back to the first video row, then the default best row. */
export function pickAutoRow(rows: ParseRow[]): number {
  let bestI = -1
  let bestH = -1
  rows.forEach((r, i) => {
    if (r.note === 'audio') return
    const h = rowHeight(r.label)
    if (h > AUTO_MAX_HEIGHT) return // above the cap (2160p, 1440p…)
    // highest height ≤ cap wins; unknown heights only win when nothing better
    if (h > bestH) { bestH = h; bestI = i }
  })
  if (bestI >= 0) return bestI
  const v = rows.findIndex(r => r.note !== 'audio')
  return v >= 0 ? v : 0
}
