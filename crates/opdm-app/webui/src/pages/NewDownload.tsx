// New page as a batch list (STEP2_BATCH_DOWNLOADS.md): every link is a card —
// thumbnail, status, per-card auto-download countdown, Details with the quality
// / name / folder / size controls. Analysis runs sequentially through the single
// sticky parse slot (store `pump`); cards match payloads by url (`routeParse`).
// RULE: fade-only animations inside a `.scroll-y` page — the Details collapse
// animates grid-template-rows 0fr→1fr, never slide-in-from-* (§8 flicker).
import { useEffect, useState } from 'react'
import {
  Link2, Search, Video, Music, FileIcon, Download, Clock, Check,
  TriangleAlert, Loader2, ChevronDown, X, Pause, Play,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/tauri'
import { useStore, type BatchItem } from '@/store/useStore'
import { AUTO_MS, AUTO_SECONDS } from '@/lib/autoFormat'
import { bytes, duration } from '@/lib/format'
import { host } from '@/lib/backend'
import { cn } from '@/lib/utils'

const kindIcon = { video: Video, audio: Music, file: FileIcon }

/** YouTube thumbnail straight from the video id — a card looks populated while
 *  yt-dlp is still analyzing; the ready payload may bring a better one. */
const ytThumb = (url: string): string | undefined => {
  const m = /(?:youtube\.com\/(?:watch\?[^#\s]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/.exec(url)
  return m ? `https://i.ytimg.com/vi/${m[1]}/mqdefault.jpg` : undefined
}

/** Re-renders while this card counts down (reference `Lf`): 100 ms local tick,
 *  the DEADLINE itself lives on the card so hidden windows still start on time. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(t)
  }, [active])
  return now
}

function BatchCard({ it }: { it: BatchItem }) {
  const patchItem = useStore(s => s.patchItem)
  const removeItem = useStore(s => s.removeItem)
  const startItem = useStore(s => s.startItem)
  const deadline = it.deadline
  const counting = deadline !== null
  const now = useNow(counting)
  const left = deadline !== null ? Math.max(0, deadline - now) : 0
  const info = it.info
  const rows = info?.kind === 'ytdlp' ? (info.rows ?? []) : []
  const selRow = info?.kind === 'ytdlp' ? rows[Number(it.fmt) || 0] : undefined
  const size = info?.kind === 'ytdlp' ? selRow?.size : info?.probe?.totalBytes
  const ready = it.status === 'ready'
  // thumbnail: payload's own, else derived from the video id (works while analyzing)
  const thumb = (info?.kind === 'ytdlp' && info.thumbnail) || ytThumb(info?.url ?? it.url) || undefined
  const [imgOk, setImgOk] = useState(true)
  useEffect(() => setImgOk(true), [thumb]) // a new source may load fine again
  // title: user-edited name → payload title/filename → the url (never blank, even mid-analysis)
  const label = it.name || info?.title || info?.filename || it.url
  // any edit cancels ONLY this card's countdown (§ per-card countdowns)
  const edit = (p: Partial<BatchItem>) => patchItem(it.id, { ...p, deadline: null })
  const meta = ready && info ? [
    info.kind === 'ytdlp' ? info.uploader : (info.probe?.type || host(info.url)),
    info.kind === 'ytdlp' ? duration(info.duration) : '',
    selRow?.label ?? '',
    size ? `${selRow?.approx ? '~' : ''}${bytes(size)}` : '',
  ].filter(Boolean).join(' · ') : ''

  return (
    <div className="animate-in fade-in rounded-lg border bg-card duration-300">
      <div className="flex items-center gap-3 p-3">
        <div className="grid aspect-video w-28 shrink-0 place-items-center overflow-hidden rounded-md bg-secondary text-muted-foreground">
          {thumb && imgOk
            ? <img src={thumb} alt="" className="size-full object-cover" onError={() => setImgOk(false)} />
            : <Video className="size-6" />}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate font-medium" title={label}>{label}</p>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {it.status === 'waiting' && <><Clock className="size-3.5" />Waiting</>}
            {it.status === 'parsing' && <><Loader2 className="size-3.5 animate-spin" />Analyzing…</>}
            {it.status === 'starting' && <><Loader2 className="size-3.5 animate-spin" />Adding…</>}
            {it.status === 'started' && (!it.jobState || it.jobState === 1) && <span className="flex items-center gap-1.5 text-ok"><Check className="size-3.5" />Added to downloads</span>}
            {it.status === 'started' && it.jobState === 2 && <><Loader2 className="size-3.5 animate-spin" />Downloading…</>}
            {it.status === 'started' && it.jobState === 3 && <><Pause className="size-3.5" />Paused</>}
            {it.status === 'started' && it.jobState === 4 && <span className="flex items-center gap-1.5 text-ok"><Check className="size-3.5" />Completed</span>}
            {it.status === 'started' && it.jobState === 5 && <span className="flex items-center gap-1.5 text-destructive"><TriangleAlert className="size-3.5 shrink-0" />Download failed — see Home</span>}
            {it.status === 'error' && <span className="flex min-w-0 items-center gap-1.5 text-destructive"><TriangleAlert className="size-3.5 shrink-0" /><span className="truncate">{it.error}</span></span>}
            {ready && meta && <span className="truncate">{meta}</span>}
          </div>
          {counting && (
            <div className="flex items-center gap-2 animate-in fade-in duration-200">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                <div className="h-full rounded-full bg-primary transition-[width] duration-100 ease-linear" style={{ width: `${left / AUTO_MS * 100}%` }} />
              </div>
              <span className="w-24 text-right text-xs tabular-nums text-muted-foreground">Starting in {Math.ceil(left / 1000)} s</span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {counting && <Button size="sm" variant="outline" onClick={() => edit({ deadline: null })}>Cancel</Button>}
          {ready && !counting && <Button size="sm" onClick={() => void startItem(it.id)} disabled={!it.name.trim()}><Download />Download</Button>}
          {it.status === 'started' && it.jobId && it.jobState === 2 &&
            <Button size="sm" variant="outline" onClick={() => void api.pause(it.jobId!)}><Pause />Pause</Button>}
          {it.status === 'started' && it.jobId && it.jobState === 3 &&
            <Button size="sm" variant="outline" onClick={() => void api.resume(it.jobId!)}><Play />Resume</Button>}
          <Button size="sm" variant="outline" disabled={!ready} aria-expanded={it.open} onClick={() => patchItem(it.id, { open: !it.open })}>
            Details<ChevronDown className={cn('transition-transform duration-300', it.open && 'rotate-180')} />
          </Button>
          <Button size="icon" variant="ghost" className="size-8" aria-label="Remove" disabled={it.status === 'starting'} onClick={() => removeItem(it.id)}><X /></Button>
        </div>
      </div>
      <div className={cn('grid transition-[grid-template-rows] duration-300', it.open && ready ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="min-h-0 overflow-hidden">
          {ready && info && (
            <div className="space-y-5 border-t p-4">
              {info.kind === 'ytdlp' && <div className="space-y-2">
                <Label>Quality</Label>
                <div className="grid gap-2" role="radiogroup">
                  {rows.map((r, i) => { const I = kindIcon[r.note === 'audio' ? 'audio' : 'video']; return (
                    <button key={i} role="radio" aria-checked={(Number(it.fmt) || 0) === i} onClick={() => edit({ fmt: String(i) })}
                      className={cn('flex items-center gap-3 rounded-lg border bg-card px-4 py-2.5 text-left text-sm transition-all hover:border-primary/50', (Number(it.fmt) || 0) === i && 'border-primary bg-primary/5 ring-2 ring-primary/20')}>
                      <I className="size-4 text-muted-foreground" />
                      <span className="flex-1 font-medium">{r.label}</span>
                      <span className="text-muted-foreground">{r.approx ? '~' : ''}{bytes(r.size)}</span>
                    </button>) })}
                </div>
              </div>}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`n-${it.id}`}>File name</Label>
                  <Input id={`n-${it.id}`} value={it.name} onChange={e => patchItem(it.id, { name: e.target.value, nameDirty: true, deadline: null })} />
                  {info.kind === 'ytdlp' && <p className="text-xs text-muted-foreground">The container is chosen automatically — no extension needed.</p>}
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`d-${it.id}`}>Save to</Label>
                  {/* B1 pending: parse_confirm has no folder argument — read-only until then */}
                  <Input id={`d-${it.id}`} value={it.dir} readOnly title="All downloads go to the downloads folder (Settings → General)" />
                </div>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-secondary px-4 py-3 text-sm">
                <span className="text-muted-foreground">Estimated size</span>
                <span className="font-medium">{selRow?.approx ? '~' : ''}{size ? bytes(size) : '—'}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function NewDownload() {
  const batch = useStore(s => s.batch)
  const addLinks = useStore(s => s.addLinks)
  const clearBatch = useStore(s => s.clearBatch)
  const startItem = useStore(s => s.startItem)
  const auto = useStore(s => s.settings.autoDownload)
  const setAuto = useStore(s => s.setAuto)
  const [url, setUrl] = useState('')
  const readyCards = batch.filter(i => i.status === 'ready')

  return (
    <div className="scroll-y h-full">
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <div>
          <h1 className="text-xl font-semibold">New downloads</h1>
          <p className="text-sm text-muted-foreground">Add one or more links. Nothing downloads until you confirm, or until the auto download countdown ends.</p>
        </div>

        <form onSubmit={e => { e.preventDefault(); const v = url.trim(); if (!v) return; setUrl(''); addLinks(v) }} className="flex gap-2">
          <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="Paste a link (several links separated by spaces work too)" className="h-10" />
          <Button type="submit" className="h-10" disabled={!url.trim()}><Search />Analyze</Button>
        </form>

        <label className="-mt-3 flex w-fit cursor-pointer items-center gap-2 text-sm">
          <Switch checked={auto} onCheckedChange={v => void setAuto(v === true)} />
          Auto download <span className="text-muted-foreground">starts {AUTO_SECONDS} s after each analysis</span>
        </label>

        {batch.length === 0 ? (
          <div className="grid place-items-center rounded-lg border border-dashed py-14 text-center text-sm text-muted-foreground animate-in fade-in duration-300">
            <div><Link2 className="mx-auto mb-2 size-8" strokeWidth={1.25} />Your links will appear here</div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{batch.length} {batch.length === 1 ? 'link' : 'links'}</span>
              <div className="flex gap-2">
                {readyCards.length > 1 && <Button size="sm" variant="outline" onClick={() => readyCards.forEach(c => void startItem(c.id))}><Download />Download all ({readyCards.length})</Button>}
                <Button size="sm" variant="ghost" onClick={clearBatch}>Clear</Button>
              </div>
            </div>
            {batch.map(it => <BatchCard key={it.id} it={it} />)}
          </div>
        )}
      </div>
    </div>
  )
}
