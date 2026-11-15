import { CheckCircle2, CircleAlert, Clock, Download as Dl, Pause, Combine } from 'lucide-react'
import type { Status } from '@/types'
import { cn } from '@/lib/utils'
const meta: Record<Status, { label: string; cls: string; Icon: typeof Dl }> = {
  queued: { label: 'Queued', cls: 'bg-muted text-muted-foreground', Icon: Clock },
  downloading: { label: 'Downloading', cls: 'bg-primary/10 text-primary', Icon: Dl },
  paused: { label: 'Paused', cls: 'bg-warn/15 text-warn', Icon: Pause },
  merging: { label: 'Merging', cls: 'bg-primary/10 text-primary', Icon: Combine },
  completed: { label: 'Completed', cls: 'bg-ok/15 text-ok', Icon: CheckCircle2 },
  failed: { label: 'Failed', cls: 'bg-destructive/10 text-destructive', Icon: CircleAlert },
}
export function StatusBadge({ status }: { status: Status }) {
  const { label, cls, Icon } = meta[status]
  return <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors duration-300', cls)}><Icon className={cn('size-3', status === 'downloading' && 'animate-bounce')} />{label}</span>
}
