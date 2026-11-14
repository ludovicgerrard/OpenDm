import { Fragment, useState } from 'react'
import { ChevronDown, ExternalLink, FolderOpen, Play, RotateCw, Trash2, Pause, MousePointerClick } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useStore } from '@/store/useStore'
import { api } from '@/lib/tauri'
import { bytes, pct } from '@/lib/format'
import { fullName, kindLabel } from '@/lib/backend'
import { CAP } from '@/lib/capabilities'
import { StatusBadge } from './StatusBadge'
import { SegmentedBar } from './SegmentedBar'
import { cn } from '@/lib/utils'

export function DetailsPanel() {
  const d = useStore(s => s.downloads.find(x => x.id === s.activeId)); const remove = useStore(s => s.remove)
  const log = useStore(s => s.activeId ? s.logs[s.activeId] : undefined)
  const hydrateLog = useStore(s => s.hydrateLog)
  const [logOpen, setLogOpen] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  if (!d) return <div className="grid h-full place-items-center text-sm text-muted-foreground"><div className="flex items-center gap-2"><MousePointerClick className="size-4" />Select a download to see its details</div></div>
  const p = pct(d); const live = d.status === 'downloading'
  const isYtdlp = d.kind === 'ytdlp'
  const indet = live && d.size === 0
  const rows: [string, string][] = [
    ['Type', kindLabel(d.kind)], ['Location', `${d.dir}/${fullName(d)}`],
    ['Size', `${bytes(d.downloaded)} of ${d.size ? bytes(d.size) : 'unknown'}`],
    ['Speed', live ? `${bytes(d.speed)}/s` : '—'], ['Remaining', live && d.eta ? `${Math.round(d.eta)} s` : '—'],
    ['Referer', d.referer || '—'], ['Cookies sent', d.cookiesSent ? 'Yes' : 'No'],
    ['Source', d.source ?? d.url], ['Added', new Date(d.createdAt).toLocaleString()], ['URL', d.url],
  ]
  // first open of a yt-dlp job: hydrate the ring buffer from the engine log once
  const openLog = () => {
    setLogOpen(o => !o)
    if (isYtdlp && !log?.length) void api.ytLog(d.id).then(t => { if (t) hydrateLog(d.id, t) })
  }
  const doRemove = (deleteFiles: boolean) => { setConfirmDel(false); void remove([d.id], deleteFiles) }
  return (
    <div key={d.id} className="scroll-y flex h-full animate-in fade-in flex-col gap-3 p-4 duration-200">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{fullName(d)}</h2>
        <StatusBadge status={d.status} />
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" disabled={d.status !== 'completed'} onClick={() => void api.openFile(d.id)}><ExternalLink />Open</Button>
          <Button size="sm" variant="outline" onClick={() => void api.openFolder(d.id)}><FolderOpen />Open folder</Button>
          {live ? <Button size="sm" variant="outline" onClick={() => void api.pause(d.id)}><Pause />Pause</Button>
            : d.status === 'paused' ? <Button size="sm" variant="outline" onClick={() => void api.resume(d.id)}><Play />Resume</Button> : null}
          <Button size="sm" variant="outline" disabled={!CAP.retry} onClick={() => void api.retry(d.id)}><RotateCw />Retry</Button>
          {!confirmDel
            ? <Button size="sm" variant="destructive" onClick={() => setConfirmDel(true)}><Trash2 />Delete</Button>
            : <span className="flex items-center gap-1.5 text-sm animate-in fade-in">
                <span className="text-muted-foreground">Also delete the file?</span>
                <Button size="sm" variant="outline" onClick={() => doRemove(false)}>Keep file</Button>
                <Button size="sm" variant="destructive" onClick={() => doRemove(true)}>Delete both</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDel(false)}>Cancel</Button>
              </span>}
        </div>
      </div>
      <div>
        <div className="mb-1.5 flex justify-between text-xs text-muted-foreground">
          <span>{p.toFixed(1)}%</span>
          <span>{isYtdlp ? (d.status === 'merging' ? 'Merging streams' : 'Downloading') : d.segments.length > 1 ? `${d.segments.length} segments` : 'Single stream'}</span>
        </div>
        <SegmentedBar segments={d.segments} value={p} indeterminate={indet} live={live} className="h-2.5" />
        {d.error && <p className="mt-2 text-sm text-destructive">{d.error}</p>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        {rows.map(([k, v]) => <Fragment key={k}><dt className="text-muted-foreground">{k}</dt><dd className="truncate" title={v}>{v}</dd></Fragment>)}
      </dl>
      <div>
        <button onClick={openLog} className="flex items-center gap-1 text-sm font-medium"><ChevronDown className={cn('size-4 transition-transform duration-300', !logOpen && '-rotate-90')} />Log ({log?.length ?? 0})</button>
        <div className={cn('grid transition-[grid-template-rows] duration-300', logOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
          <pre className="mt-2 max-h-48 min-h-0 overflow-auto rounded-md bg-secondary p-3 font-mono text-xs leading-relaxed">
            {!isYtdlp ? 'No log for this download type.' : (log?.join('\n') || 'No output yet.')}
          </pre>
        </div>
      </div>
    </div>)
}
