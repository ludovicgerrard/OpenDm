import type { Segment } from '@/types'
import { cn } from '@/lib/utils'
// One cell per connection/segment; a single bar when there are fewer than 2 segments.
// `indeterminate` = total size still unknown: a moving stripe instead of a 0 % bar.
export function SegmentedBar({ segments, value, live, indeterminate, className }: { segments: Segment[]; value: number; live?: boolean; indeterminate?: boolean; className?: string }) {
  if (indeterminate) return (
    <div className={cn('h-2 overflow-hidden rounded-full bg-secondary', className)}>
      <div className="bar-live h-full w-1/3 rounded-full bg-primary/50" />
    </div>)
  if (segments.length < 2) return (
    <div className={cn('h-2 overflow-hidden rounded-full bg-secondary', className)}>
      <div className={cn('h-full rounded-full bg-primary transition-[width] duration-500 ease-out', live && 'bar-live')} style={{ width: `${value}%` }} />
    </div>)
  return (
    <div className={cn('flex h-2 gap-0.5', className)}>
      {segments.map(s => (
        <div key={s.id} className="flex-1 overflow-hidden rounded-sm bg-secondary">
          <div className={cn('h-full bg-primary transition-[width] duration-500 ease-out', s.progress >= 100 && 'bg-ok', live && s.progress < 100 && 'bar-live')} style={{ width: `${s.progress}%` }} />
        </div>))}
    </div>)
}
