import { useEffect, useState } from 'react'
import { Wrench, SlidersHorizontal, Download, Globe, Puzzle, Blocks, Info, FolderOpen, CheckCircle2, CircleAlert, RefreshCw, Loader2, ArrowUpCircle, PackageX, Trash2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/tauri'
import { useStore } from '@/store/useStore'
import { CAP } from '@/lib/capabilities'
import { cn } from '@/lib/utils'
import type { Channel, Plugin, Reencode, Settings, Tool } from '@/types'

const tabs = [
  { id: 'tools', label: 'Tools', Icon: Wrench }, { id: 'general', label: 'General', Icon: SlidersHorizontal },
  { id: 'downloads', label: 'Downloads', Icon: Download }, { id: 'network', label: 'Network', Icon: Globe },
  ...(CAP.postProcess ? [{ id: 'output', label: 'Output', Icon: Puzzle }] : []),
  ...(CAP.plugins ? [{ id: 'plugins', label: 'Plugins', Icon: Puzzle }] : []),
  { id: 'browser', label: 'Browser capture', Icon: Blocks }, { id: 'about', label: 'About', Icon: Info },
] as const

const Group = ({ title, children }: { title?: string; children: React.ReactNode }) => (
  <section className="space-y-2">{title && <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>}<div className="divide-y rounded-lg border bg-card">{children}</div></section>)
const Row = ({ label, hint, children, stack }: { label: string; hint?: string; children: React.ReactNode; stack?: boolean }) => (
  <div className={cn('gap-4 px-4 py-3', stack ? 'space-y-2' : 'flex items-center justify-between')}><div className="min-w-0"><Label>{label}</Label>{hint && <p className="text-xs text-muted-foreground">{hint}</p>}</div>{children}</div>)
function Seg<T extends string>({ value, options, onChange, disabled }: { value: T; options: [T, string][]; onChange: (v: T) => void; disabled?: boolean }) {
  return <div className={cn('inline-flex rounded-md bg-secondary p-0.5', disabled && 'opacity-50 pointer-events-none')}>{options.map(([v, l]) => <button key={v} onClick={() => onChange(v)} className={cn('rounded px-3 py-1 text-sm transition-all', value === v ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{l}</button>)}</div>
}
const Sel = ({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) => (
  <select value={value} onChange={e => onChange(e.target.value)} className="h-9 rounded-md border bg-card px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30">{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>)

function ToolCard({ t, i, anyBusy }: { t: Tool; i: number; anyBusy: boolean }) {
  const { installTool } = useStore()
  const installing = t.status === 'installing'; const missing = t.status === 'missing'
  return (
    <div style={{ animationDelay: `${i * 70}ms` }} className="animate-in fade-in fill-mode-backwards space-y-3 rounded-lg border bg-card p-4 duration-500">
      <div className="flex items-start gap-3">
        <div className={cn('mt-0.5 grid size-9 shrink-0 place-items-center rounded-md transition-colors duration-300', missing ? 'bg-destructive/10 text-destructive' : t.status === 'outdated' ? 'bg-warn/15 text-warn' : t.status === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-ok/15 text-ok')}>
          {installing ? <Loader2 className="size-5 animate-spin" /> : missing ? <PackageX className="size-5" /> : t.status === 'outdated' ? <ArrowUpCircle className="size-5" /> : t.status === 'error' ? <CircleAlert className="size-5" /> : <CheckCircle2 className="size-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{t.name}</span>
            <span className={cn('rounded-full px-2 py-0.5 text-xs', t.required ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground')}>{t.required ? 'Required' : 'Optional'}</span>
            {t.custom && <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-muted-foreground">Custom path</span>}</div>
          <p className="text-sm text-muted-foreground">{t.description}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {installing ? (t.progress != null ? `Downloading… ${Math.round(t.progress)}%` : 'Downloading…') : missing ? 'Not installed' : t.status === 'error' ? t.error : `Version ${t.version ?? '?'}, installed`}
          </p>
          {t.path && !installing && <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={t.path}>{t.path}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {(missing || t.status === 'error') && <Button size="sm" disabled={installing} onClick={() => void installTool(t.id)}><Download />Download</Button>}
          {!installing && t.status === 'installed' && t.canUpdate && <Button size="sm" disabled={anyBusy} onClick={() => void installTool(t.id, 'update')}><ArrowUpCircle />Update</Button>}
          {CAP.toolLatestCheck && t.status === 'installed' && <Button size="sm" variant="outline" disabled={installing} onClick={() => void useStore.getState().checkTool(t.id)}><RefreshCw />Check</Button>}
          {CAP.toolCustomPath && <Button size="icon" variant="ghost" className="size-8" aria-label="Choose existing binary" disabled={installing} onClick={() => void useStore.getState().browseTool(t.id)}><FolderOpen /></Button>}
          {CAP.toolRemove && !missing && <Button size="icon" variant="ghost" className="size-8 text-destructive" aria-label="Remove" disabled={installing} onClick={() => void useStore.getState().removeTool(t.id)}><Trash2 /></Button>}
        </div>
      </div>
      {installing && <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className={cn('h-full rounded-full bg-primary transition-[width] duration-300', t.progress == null && 'bar-live w-1/3')} style={{ width: `${t.progress ?? 100}%` }} /></div>}
    </div>)
}

const vars = ['title', 'id', 'uploader', 'upload_date', 'resolution', 'ext']
const sample: Record<string, string> = { title: 'Rust in 100 Seconds', id: 'abc123', uploader: 'Fireship', upload_date: '20260102', resolution: '1080p', ext: 'mp4' }

// Snapshot of everything save_settings persists (§7.3): the Save bar compares
// these to decide "unsaved changes". autoDownload rides along (batch feature).
const pickSaved = (s: Settings) => ({ capturePort: s.capturePort, maxSegments: s.maxSegments, downloadDir: s.downloadDir, userAgent: s.userAgent, integrateTakeover: s.integrateTakeover, autoDownload: s.autoDownload })

export default function SettingsPage() {
  const { settings: s, setSettings, tools, setChannel, saveSettings, channel } = useStore()
  const set = (p: Partial<Settings>) => setSettings(p)
  const [tab, setTab] = useState<(typeof tabs)[number]['id']>('tools')
  const [version, setVersion] = useState(''); const [plugins, setPlugins] = useState<Plugin[]>([]); const [pBusy, setPBusy] = useState<string | null>(null)
  useEffect(() => { void api.version().then(setVersion); void api.plugins().then(setPlugins) }, [])
  const missingRequired = tools.filter(t => t.required && t.status === 'missing').length
  const anyBusy = tools.some(t => t.status === 'installing')
  const num = (k: 'maxSegments' | 'maxConcurrent' | 'fragmentThreads' | 'speedLimitKb', min = 1, max?: number) =>
    <Input type="number" min={min} max={max} className="w-24" value={s[k]} onChange={e => set({ [k]: Number(e.target.value) } as Partial<Settings>)} />
  const tog = (k: 'autoDownload' | 'sponsorBlock' | 'notifyInApp' | 'notifySystem' | 'restoreQueue' | 'embedSubs' | 'embedThumb' | 'embedMeta' | 'embedChapters' | 'integrateTakeover') =>
    <Switch checked={s[k]} onCheckedChange={v => set({ [k]: v } as Partial<Settings>)} />
  const togglePlugin = async (p: Plugin) => { setPBusy(p.id); try { p.installed ? await api.removePlugin(p.id) : await api.installPlugin(p.id); setPlugins(l => l.map(x => x.id === p.id ? { ...x, installed: !x.installed } : x)) } finally { setPBusy(null) } }
  const preview = s.filenameTemplate.replace(/%\((\w+)\)s/g, (_, k) => sample[k] ?? k)

  // ---- save draft (§7.3): explicit Save; never per keystroke ----
  const [savedVals, setSavedVals] = useState(() => pickSaved(useStore.getState().settings))
  const [savedPort, setSavedPort] = useState(() => useStore.getState().settings.capturePort)
  const [note, setNote] = useState('')
  const five = pickSaved(s)
  const dirty = JSON.stringify(five) !== JSON.stringify(savedVals)
  const valid = s.capturePort >= 1024 && s.capturePort <= 65535 && s.maxSegments >= 1 && s.maxSegments <= 16 && s.downloadDir.trim().length > 0
  const save = async () => {
    if (!valid) return
    await saveSettings()
    const post = pickSaved(useStore.getState().settings)
    setSavedVals(post); setSavedPort(post.capturePort)
    setNote(post.capturePort !== savedPort ? 'Restart OpenDM to apply the new port, then reconfigure the extension.' : 'Saved.')
    setTimeout(() => setNote(''), 6000)
  }

  return (
    <div className="grid h-full grid-cols-[13.5rem_1fr]">
      <nav className="space-y-0.5 border-r bg-card/50 p-3">
        {tabs.map(({ id, label, Icon }) => (
          <button key={id} onClick={() => setTab(id)} className={cn('relative flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors', tab === id ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')}>
            <span className={cn('absolute inset-y-1.5 left-0 w-0.5 rounded bg-primary transition-transform duration-300', tab === id ? 'scale-y-100' : 'scale-y-0')} />
            <Icon className="size-4" />{label}
            {id === 'tools' && missingRequired > 0 && <span className="ml-auto grid size-5 place-items-center rounded-full bg-destructive text-xs text-white">{missingRequired}</span>}
          </button>))}
      </nav>
      <div className="scroll-y relative min-h-0"><div key={tab} className="mx-auto max-w-2xl animate-in fade-in space-y-6 p-6 pb-20 duration-200">
        {tab === 'tools' && <>
          <div><h1 className="text-lg font-semibold">Tools</h1>
            <p className="text-sm text-muted-foreground">Needed for YouTube and other video sites. Plain HTTP and HLS downloads work without them.</p></div>
          {missingRequired > 0 && <div className="flex items-center gap-2 rounded-lg border px-4 py-3 text-sm text-muted-foreground animate-in fade-in"><CircleAlert className="size-4" />YouTube links need yt-dlp{missingRequired > 1 ? ' (and the other missing tools below)' : ''}.</div>}
          <div className="space-y-3">{tools.map((t, i) => <ToolCard key={t.id} t={t} i={i} anyBusy={anyBusy} />)}</div>
          <Group title="Release channel">
            <Row label="yt-dlp channel" hint="Applies on the next install/update"><Seg value={channel} disabled={anyBusy} onChange={v => void setChannel(v as Channel)} options={[['stable', 'Stable'], ['nightly', 'Nightly'], ['master', 'Master']]} /></Row>
          </Group>
        </>}
        {tab === 'general' && <>
          <h1 className="text-lg font-semibold">General</h1>
          <Group>
            <Row label="Download folder" hint="Where new files are saved">
              {CAP.pickFolder
                ? <div className="flex gap-2"><Input readOnly value={s.downloadDir} className="w-60" /><Button variant="outline" size="icon" aria-label="Browse" onClick={async () => { const p = await api.pickFolder(); if (p) set({ downloadDir: p }) }}><FolderOpen /></Button></div>
                : <Input className="w-60" value={s.downloadDir} onChange={e => set({ downloadDir: e.target.value })} />}
            </Row>
            <Row label="Theme"><Seg value={s.theme} onChange={v => set({ theme: v })} options={[['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']]} /></Row>
            <Row label="Language" hint="Interface language"><Sel value={s.language} onChange={v => set({ language: v })} options={[['en', 'English'], ['fr', 'Français'], ['es', 'Español'], ['ja', '日本語'], ['zh-CN', '简体中文']]} /></Row>
          </Group>
          {CAP.notifications && <Group title="Notifications">
            <Row label="In-app notification" hint="Toast when a download finishes">{tog('notifyInApp')}</Row>
            <Row label="System notification">{tog('notifySystem')}</Row>
          </Group>}
          {CAP.restoreQueue && <Group title="Startup"><Row label="Restore the queue after a restart" hint="Unfinished downloads come back paused">{tog('restoreQueue')}</Row></Group>}
        </>}
        {tab === 'downloads' && <>
          <h1 className="text-lg font-semibold">Downloads</h1>
          <Group>
            <Row label="Segments per file" hint="Parallel connections per HTTP download (1–16)">{num('maxSegments', 1, 16)}</Row>
            {CAP.maxConcurrent && <Row label="Simultaneous downloads">{num('maxConcurrent')}</Row>}
            {CAP.fragmentThreads && <Row label="Fragment threads" hint="Parallel fragments per download (yt-dlp)">{num('fragmentThreads')}</Row>}
            {CAP.speedLimit && <Row label="Speed limit (KB/s)" hint="0 means unlimited">{num('speedLimitKb', 0)}</Row>}
            <Row label="Auto download" hint="Starts 5 seconds after a link is analyzed. YouTube waits for the quality list and picks 1080p, or the closest lower.">{tog('autoDownload')}</Row>
            {CAP.filenameTemplate && <Row label="Skip sponsored segments" hint="SponsorBlock">{tog('sponsorBlock')}</Row>}
          </Group>
          {CAP.filenameTemplate && <Group title="File name template">
            <Row label="Template" stack><Input className="font-mono text-xs" value={s.filenameTemplate} onChange={e => set({ filenameTemplate: e.target.value })} />
              <div className="flex flex-wrap gap-1.5">{vars.map(v => <button key={v} onClick={() => set({ filenameTemplate: s.filenameTemplate + `%(${v})s` })} className="rounded-full bg-secondary px-2.5 py-0.5 font-mono text-xs transition-colors hover:bg-accent">{v}</button>)}</div>
              <p className="text-xs text-muted-foreground">Result: <span className="text-foreground">{preview}</span></p></Row>
          </Group>}
        </>}
        {tab === 'network' && <>
          <h1 className="text-lg font-semibold">Network</h1>
          <Group>
            {CAP.proxy && <Row label="Proxy" hint="HTTP or SOCKS, leave empty for none"><Input className="w-64" placeholder="socks5://127.0.0.1:1080" value={s.proxy} onChange={e => set({ proxy: e.target.value })} /></Row>}
            <Row label="User agent" hint="Empty uses the default"><Input className="w-64" value={s.userAgent} onChange={e => set({ userAgent: e.target.value })} /></Row>
          </Group>
          {CAP.cookies && <Group title="Cookies">
            <Row label="Cookie source" hint="Needed for age-restricted or members-only videos"><Seg value={s.cookieMode} onChange={v => set({ cookieMode: v })} options={[['none', 'None'], ['text', 'Paste text'], ['file', 'File']]} /></Row>
            {s.cookieMode === 'text' && <Row label="Netscape format" stack><textarea value={s.cookieText} onChange={e => set({ cookieText: e.target.value })} rows={5} placeholder="# Netscape HTTP Cookie File" className="w-full rounded-md border bg-card p-3 font-mono text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 animate-in fade-in" /></Row>}
            {s.cookieMode === 'file' && <Row label="cookies.txt"><div className="flex gap-2 animate-in fade-in"><Input readOnly className="w-60" value={s.cookieFile} placeholder="No file selected" /><Button variant="outline" size="icon" aria-label="Browse" onClick={async () => { const p = await api.pickFile(); if (p) set({ cookieFile: p }) }}><FolderOpen /></Button></div></Row>}
          </Group>}
        </>}
        {tab === 'output' && <>
          <h1 className="text-lg font-semibold">Output</h1>
          <Group>
            <Row label="Convert to" hint="Re-encode after download (needs FFmpeg)"><Sel value={s.reencode} onChange={v => set({ reencode: v as Reencode })} options={[['none', 'Keep original'], ['mp4', 'MP4'], ['mkv', 'MKV'], ['webm', 'WebM'], ['mp3', 'MP3'], ['aac', 'AAC'], ['flac', 'FLAC']]} /></Row>
            <Row label="Embed subtitles">{tog('embedSubs')}</Row>
            <Row label="Embed thumbnail">{tog('embedThumb')}</Row>
            <Row label="Embed metadata">{tog('embedMeta')}</Row>
            <Row label="Embed chapters">{tog('embedChapters')}</Row>
          </Group>
        </>}
        {tab === 'plugins' && <>
          <div><h1 className="text-lg font-semibold">Plugins</h1><p className="text-sm text-muted-foreground">yt-dlp plugins, installed in OpenDM's own plugin folder.</p></div>
          <Group>{plugins.map(p => <Row key={p.id} label={p.name} hint={p.description}><Button size="sm" variant={p.installed ? 'outline' : 'default'} disabled={pBusy === p.id} onClick={() => void togglePlugin(p)}>{pBusy === p.id ? <Loader2 className="animate-spin" /> : p.installed ? <Trash2 /> : <Download />}{p.installed ? 'Remove' : 'Install'}</Button></Row>)}</Group>
        </>}
        {tab === 'browser' && <>
          <div><h1 className="text-lg font-semibold">Browser capture</h1><p className="text-sm text-muted-foreground">Send the current page and its cookies to OpenDM with one click. Cookies never leave your computer.</p></div>
          <Group>
            <Row label="Capture port" stack hint={`The WebSocket listener is bound once at startup — changing the port needs a restart. Connect the extension to ws://127.0.0.1:${s.capturePort} (subprotocol plugin.v3.opendm.local).`}>
              <Input type="number" className="w-32" min={1024} max={65535} value={s.capturePort} onChange={e => set({ capturePort: Number(e.target.value) })} />
            </Row>
            <Row label="Take over browser downloads" hint="Ask OpenDM when the browser starts a download">{tog('integrateTakeover')}</Row>
            {CAP.extensionFolder && <Row label="Extension folder" hint="Bundled with the app"><Button variant="outline" onClick={() => void api.openExtensionFolder()}><FolderOpen />Open folder</Button></Row>}
          </Group>
        </>}
        {tab === 'about' && <>
          <h1 className="text-lg font-semibold">About</h1>
          <Group>
            <Row label="OpenDM version"><span className="text-sm text-muted-foreground">{version}</span></Row>
            <Row label="App data folder" hint="Settings, jobs and tools live next to OpenDM.exe"><span className="text-sm text-muted-foreground">Portable — next to the app</span></Row>
            {CAP.appUpdate && <Row label="Updates"><Button variant="outline" onClick={() => void api.checkAppUpdate()}><RefreshCw />Check for updates</Button></Row>}
          </Group>
          {CAP.cli && <Group title="Command line"><div className="p-4"><pre className="overflow-auto rounded-md bg-secondary p-3 font-mono text-xs leading-relaxed">{`opendm --url "https://example.com/video" \\
  --cookies "/path/cookies.txt" --dir "/path/downloads" \\
  --yt-dlp-path "/path/yt-dlp" --deno-path "/path/deno"`}</pre></div></Group>}
        </>}
      </div>
        {/* save bar: save_settings needs all five values, validated, on explicit Save (§7.3) */}
        <div className={cn('pointer-events-none sticky bottom-0 flex justify-end p-4 transition-all', dirty && 'pointer-events-auto')}>
          {dirty && <div className="flex items-center gap-3 rounded-lg border bg-card p-3 pl-4 text-sm shadow-lg animate-in fade-in">
            <span className={cn(!valid && 'text-destructive')}>{!valid ? 'Fix: port 1024–65535, segments 1–16, folder required.' : 'Unsaved changes'}</span>
            <Button size="sm" disabled={!valid} onClick={() => void save()}>Save</Button>
          </div>}
          {note && <div className="absolute bottom-full right-4 mb-2 rounded-lg border bg-card px-4 py-2 text-sm shadow-lg animate-in fade-in">{note}</div>}
        </div>
      </div>
    </div>)
}
