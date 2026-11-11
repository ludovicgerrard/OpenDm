import { FolderOpen, Trash2, Inbox } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { useStore } from '@/store/useStore'
import { api } from '@/lib/tauri'
import { bytes, pct } from '@/lib/format'
import { fullName } from '@/lib/backend'
import { StatusBadge } from '@/components/StatusBadge'
import { SegmentedBar } from '@/components/SegmentedBar'
import { DetailsPanel } from '@/components/DetailsPanel'
import { cn } from '@/lib/utils'

const cols = 'grid-cols-[2rem_minmax(0,2fr)_6rem_9rem_minmax(8rem,1fr)_2.5rem]'
export default function Home() {
  const { downloads, selected, activeId, toggle, toggleAll, setActive, remove } = useStore()
  const all = downloads.length > 0 && selected.length === downloads.length
  return (
    <ResizablePanelGroup direction="vertical">
      <ResizablePanel defaultSize={62} minSize={30}>
        {downloads.length === 0 ? (
          <div className="grid h-full place-items-center p-8 text-center">
            <div className="animate-in zoom-in-95 fade-in duration-500">
              <Inbox className="mx-auto mb-3 size-10 text-muted-foreground" strokeWidth={1.25} />
              <p className="font-medium">Nothing downloaded yet</p>
              <p className="mt-1 text-sm text-muted-foreground">Paste a link in the bar above, or <Link to="/new" className="text-primary underline-offset-4 hover:underline">open the New page</Link>.</p>
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col">
            <div className={cn('flex h-11 items-center gap-3 border-b px-4 text-sm transition-colors', selected.length ? 'bg-accent' : 'bg-card')}>
              <Checkbox checked={all ? true : selected.length ? 'indeterminate' : false} onCheckedChange={toggleAll} aria-label="Select all" />
              <span className="text-muted-foreground">{selected.length ? `${selected.length} selected` : `${downloads.length} downloads`}</span>
              {selected.length > 0 && <Button size="sm" variant="ghost" className="ml-auto text-destructive animate-in fade-in slide-in-from-right-2" onClick={() => remove(selected)}><Trash2 />Delete selected</Button>}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <div className={cn('grid gap-x-4 border-b px-4 py-2 text-xs text-muted-foreground', cols)}><span /><span>Name</span><span>Size</span><span>Status</span><span>Progress</span><span /></div>
              {downloads.map((d, i) => {
                const p = pct(d)
                const indet = d.status === 'downloading' && d.size === 0 // total unknown yet (§2)
                return (
                  <div key={d.id} onClick={() => setActive(d.id)} style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
                    className={cn('group grid cursor-pointer items-center gap-x-4 border-b px-4 py-2.5 text-sm transition-colors animate-in fade-in slide-in-from-left-2 fill-mode-backwards hover:bg-accent/50', cols, activeId === d.id && 'bg-accent shadow-[inset_3px_0_0_var(--primary)]')}>
                    <Checkbox checked={selected.includes(d.id)} onClick={e => e.stopPropagation()} onCheckedChange={() => toggle(d.id)} aria-label={`Select ${d.name}`} />
                    <div className="min-w-0"><div className="truncate font-medium">{fullName(d)}</div><div className="truncate text-xs text-muted-foreground">{d.source ?? d.url}</div></div>
                    <span className="text-muted-foreground">{d.size ? bytes(d.size) : '—'}</span>
                    <StatusBadge status={d.status} />
                    <div className="flex items-center gap-2"><SegmentedBar segments={d.segments} value={p} indeterminate={indet} live={d.status === 'downloading'} className="flex-1" /><span className="w-10 text-right text-xs text-muted-foreground">{indet ? '—' : `${Math.round(p)}%`}</span></div>
                    <Button size="icon" variant="ghost" className="size-8 opacity-60 transition-opacity group-hover:opacity-100" aria-label="Open folder" onClick={e => { e.stopPropagation(); api.openFolder(d.id) }}><FolderOpen /></Button>
                  </div>)
              })}
            </div>
          </div>
        )}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={38} minSize={12} className="bg-card"><DetailsPanel /></ResizablePanel>
    </ResizablePanelGroup>
  )
}
