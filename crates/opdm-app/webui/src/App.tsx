import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Link2, ArrowDown } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useStore } from '@/store/useStore'
import { cn } from '@/lib/utils'

const nav = [{ to: '/', label: 'Home' }, { to: '/new', label: 'New' }, { to: '/settings', label: 'Settings' }]

// Boot skeleton: mimics the Home list rows (fade-in container + pulsing bars).
// RULE: fade/pulse only — never `slide-in-from-*` inside a scroll container (§8 flicker).
const SKEL_COLS = 'grid-cols-[2rem_minmax(0,2fr)_6rem_9rem_minmax(8rem,1fr)_2.5rem]'
function BootSkeleton() {
  return (
    <div className="scroll-y h-full animate-in fade-in duration-200" aria-busy="true">
      <div className="h-11 border-b bg-card" />
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className={cn('grid items-center gap-x-4 border-b px-4 py-2.5 animate-pulse', SKEL_COLS)}>
          <div className="size-4 rounded border" />
          <div className="min-w-0 space-y-1.5"><div className="h-3.5 w-2/3 rounded bg-muted" /><div className="h-2.5 w-1/2 rounded bg-muted" /></div>
          <div className="h-3 w-12 rounded bg-muted" />
          <div className="h-5 w-16 rounded-full bg-muted" />
          <div className="h-2 w-full rounded bg-muted" />
          <div className="size-7 rounded bg-muted" />
        </div>
      ))}
    </div>
  )
}

export default function App() {
  const boot = useStore(s => s.boot); const ready = useStore(s => s.ready)
  // batch cards: an incoming payload that CREATES a card (extension send) lands
  // on /new — probe updates never create cards, so nothing yanks mid-review (§8)
  const batchAdded = useStore(s => s.batchAdded)
  const [url, setUrl] = useState(''); const navigate = useNavigate(); const loc = useLocation()
  const seenBatch = useRef(0)
  useEffect(() => { void boot() }, [boot])
  useEffect(() => {
    if (batchAdded > seenBatch.current) { seenBatch.current = batchAdded; navigate('/new') }
  }, [batchAdded, navigate])
  const theme = useStore(s => s.settings.theme)
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'auto' && mq.matches))
    apply(); mq.addEventListener('change', apply); return () => mq.removeEventListener('change', apply)
  }, [theme])
  // header paste box: multi-links land in the batch, then navigate (§5)
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); const u = url.trim(); if (!u) return
    setUrl(''); useStore.getState().addLinks(u); navigate('/new')
  }
  return (
    <div className="flex h-screen flex-col">
      <header className="grid grid-cols-[1fr_minmax(0,34rem)_1fr] items-center gap-4 border-b bg-card/80 px-5 py-3 backdrop-blur">
        <span className="text-lg font-semibold tracking-tight">OpenDM</span>
        <form onSubmit={submit} className="group relative">
          <Link2 className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
          <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="Paste a link to download" className="h-10 rounded-full pl-9 pr-10 transition-shadow focus-visible:shadow-[0_0_0_4px_color-mix(in_oklch,var(--primary)_15%,transparent)]" />
          <button type="submit" aria-label="Analyze link" className={cn('absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full bg-primary text-primary-foreground transition-all', url ? 'scale-100 opacity-100' : 'scale-75 opacity-0 pointer-events-none')}><ArrowDown className="size-4 -rotate-90" /></button>
        </form>
        <nav className="flex justify-end gap-1">
          {nav.map(n => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => cn('relative rounded-md px-3 py-1.5 text-sm transition-colors', isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {({ isActive }) => <>{n.label}<span className={cn('absolute inset-x-3 -bottom-[13px] h-0.5 origin-left rounded bg-primary transition-transform duration-300', isActive ? 'scale-x-100' : 'scale-x-0')} /></>}
            </NavLink>
          ))}
        </nav>
      </header>
      <main key={loc.pathname} className="min-h-0 flex-1 overflow-hidden animate-in fade-in duration-200">
        {ready ? <Outlet /> : <BootSkeleton />}
      </main>
    </div>
  )
}
