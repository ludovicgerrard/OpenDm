import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Search, Video, Music, FileIcon, Download, FolderOpen, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/tauri'
import { useStore } from '@/store/useStore'
import { rowFmt, type ParseRow } from '@/lib/backend'
import { bytes, duration } from '@/lib/format'
import { CAP } from '@/lib/capabilities'
import { cn } from '@/lib/utils'

const kindIcon = { video: Video, audio: Music, file: FileIcon }
const badge = (note?: ParseRow['note']) =>
  note === 'best' ? 'Recommended' : note === 'video' ? 'Merge' : ''

export default function NewDownload() {
  const navigate = useNavigate()
  const parse = useStore(s => s.parse)
  const settings = useStore(s => s.settings)
  const [url, setUrl] = useState('')
  const [name, setName] = useState(''); const [sel, setSel] = useState(0)
  const [busy, setBusy] = useState(false)
  const [imgOk, setImgOk] = useState(true)
  const touchedName = useRef(false)
  const p = parse.payload

  // a new URL resets name/selection; probe updates keep a name the user edited (§5)
  const urlKey = p?.url ?? ''
  useEffect(() => { touchedName.current = false; setSel(0); setImgOk(true) }, [urlKey])
  useEffect(() => {
    if (!touchedName.current && p?.filename) setName(p.kind === 'ytdlp' ? p.filename : p.filename)
  }, [parse.seq, urlKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const analyze = () => { const u = url.trim(); if (!u) return; setUrl(''); void useStore.getState().analyze(u) }
  const cancel = () => { void useStore.getState().cancelParse(); navigate('/') }

  const ready = p?.status === 'ready'
  const selectedRow = p?.kind === 'ytdlp' ? p.rows?.[sel] : undefined
  const size = p?.kind === 'ytdlp' ? selectedRow?.size : p?.probe?.totalBytes
  const start = async () => {
    if (!p || p.status !== 'ready' || busy) return
    setBusy(true)
    try {
      await useStore.getState().startDownload({
        url: p.url, kind: p.kind, filename: name.trim(), dir,
        fmt: p.kind === 'ytdlp' ? rowFmt(selectedRow) : '',
        referer: p.referer, cookies: p.cookies,
      })
      navigate('/')
    } catch (e) { console.error(e) } finally { setBusy(false) }
  }
  const [dir, setDir] = useState('') // used once backend addition B1 lands (CAP.saveToFolder)
  useEffect(() => { setDir(p?.folder || settings.downloadDir) }, [urlKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const analyzing = p?.status === 'parsing'

  return (
    <div className="mx-auto h-full max-w-3xl space-y-6 overflow-auto p-6" onKeyDown={e => {
      if (e.key === 'Escape') cancel()
      if (e.key === 'Enter' && ready && (e.target as HTMLElement).tagName !== 'BUTTON') void start()
    }}>
      <div><h1 className="text-xl font-semibold">New download</h1>
        <p className="text-sm text-muted-foreground">The download won&apos;t start until you press Download.</p></div>

      <form onSubmit={e => { e.preventDefault(); analyze() }} className="flex gap-2">
        <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" className="h-10" />
        <Button type="submit" className="h-10" disabled={busy || analyzing}>{busy ? <Loader2 className="animate-spin" /> : <Search />}Analyze</Button>
      </form>

      {!p && <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Paste a link above, or send one from the browser extension.</div>}

      {p?.status === 'parsing' && <div className="space-y-3">
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{p.kind === 'ytdlp' ? 'Parsing with yt-dlp…' : 'Fetching file info…'}</p>
        {[0, 1, 2].map(i => <div key={i} className="h-14 animate-pulse rounded-lg bg-secondary" style={{ animationDelay: `${i * 120}ms` }} />)}
      </div>}

      {p?.status === 'error' && <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive animate-in fade-in">{p.error || 'Could not analyze this link.'}</div>}
      {p?.status === 'error' && <Button variant="outline" onClick={cancel}><ArrowLeft />Back</Button>}

      {p?.status === 'ready' && (
        <div className="animate-in fade-in slide-in-from-bottom-3 space-y-6 duration-500">
          <div className="flex gap-4 rounded-lg border bg-card p-4">
            <div className="grid h-20 w-32 shrink-0 place-items-center overflow-hidden rounded-md bg-secondary text-muted-foreground">
              {p.kind === 'ytdlp' && p.thumbnail && imgOk
                ? <img src={p.thumbnail} alt="" className="h-full w-full object-cover" onError={() => setImgOk(false)} />
                : <Video />}
            </div>
            <div className="min-w-0 text-sm">
              <p className="truncate font-medium">{p.kind === 'ytdlp' ? (p.title || p.filename) : p.filename}</p>
              <p className="text-muted-foreground">
                {p.kind === 'ytdlp' ? [p.uploader, duration(p.duration)].filter(Boolean).join(', ') : [p.probe?.type, p.probe?.disposition].filter(Boolean).join(' · ') || 'Direct link'}
              </p>
            </div>
          </div>

          {p.kind === 'ytdlp' && <div className="space-y-2"><Label>Quality</Label>
            <div className="grid gap-2" role="radiogroup">
              {(p.rows ?? []).map((x, i) => { const I = kindIcon[x.note === 'audio' ? 'audio' : 'video']; return (
                <button key={i} role="radio" aria-checked={sel === i} onClick={() => setSel(i)} style={{ animationDelay: `${i * 50}ms` }}
                  className={cn('flex items-center gap-3 rounded-lg border bg-card px-4 py-3 text-left text-sm transition-all animate-in fade-in slide-in-from-bottom-1 fill-mode-backwards hover:border-primary/50', sel === i && 'border-primary bg-primary/5 ring-2 ring-primary/20')}>
                  <I className="size-4 text-muted-foreground" />
                  <span className="flex-1 font-medium">{x.label}</span>
                  {badge(x.note) && <span className={cn('rounded-full px-2 py-0.5 text-xs', x.note === 'best' ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground')}>{badge(x.note)}</span>}
                  <span className="text-muted-foreground">{x.approx ? '~' : ''}{bytes(x.size)}</span>
                </button>) })}
            </div>
          </div>}

          <div className={cn('grid gap-4', !CAP.saveToFolder && 'sm:grid-cols-1')}>
            <div className="space-y-2"><Label htmlFor="n">File name</Label>
              <Input id="n" value={name} onChange={e => { touchedName.current = true; setName(e.target.value) }} />
              {p.kind === 'ytdlp' && <p className="text-xs text-muted-foreground">The container is chosen automatically — no extension needed.</p>}
            </div>
            {CAP.saveToFolder && <div className="space-y-2"><Label htmlFor="d">Save to</Label>
              <div className="flex gap-2"><Input id="d" value={dir} onChange={e => setDir(e.target.value)} />
                <Button type="button" variant="outline" size="icon" aria-label="Browse" onClick={async () => { const q = await api.pickFolder(); if (q) setDir(q) }}><FolderOpen /></Button>
              </div></div>}
          </div>

          <div className="flex items-center justify-between rounded-lg bg-secondary px-4 py-3 text-sm">
            <span className="text-muted-foreground">Estimated size</span>
            <span className="font-medium">{selectedRow?.approx ? '~' : ''}{size ? bytes(size) : '—'}</span>
          </div>

          <div className="flex justify-end"><Button size="lg" onClick={start} disabled={!name.trim() || busy}>{busy ? <Loader2 className="animate-spin" /> : <Download />}Download</Button></div>
        </div>
      )}
    </div>)
}
