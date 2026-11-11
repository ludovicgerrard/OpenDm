import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Link2, ArrowDown } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useStore } from '@/store/useStore'
import { cn } from '@/lib/utils'

const nav = [{ to: '/', label: 'Home' }, { to: '/new', label: 'New' }, { to: '/settings', label: 'Settings' }]

export default function App() {
  const boot = useStore(s => s.boot); const ready = useStore(s => s.ready)
  // sticky parse slot: a newer payload (extension click, paste) lands on /new (§5)
  const parseSeq = useStore(s => s.parse.seq); const hasPayload = useStore(s => !!s.parse.payload)
  const [url, setUrl] = useState(''); const navigate = useNavigate(); const loc = useLocation()
  const seenParse = useRef(0)
  useEffect(() => { void boot() }, [boot])
  useEffect(() => {
    if (hasPayload && parseSeq > seenParse.current) { seenParse.current = parseSeq; navigate('/new') }
  }, [parseSeq, hasPayload, navigate])
  const theme = useStore(s => s.settings.theme)
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'auto' && mq.matches))
    apply(); mq.addEventListener('change', apply); return () => mq.removeEventListener('change', apply)
  }, [theme])
  // header paste box: analyze then navigate — the page shows parsing/ready as events arrive (§5)
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); const u = url.trim(); if (!u) return
    setUrl(''); void useStore.getState().analyze(u); navigate('/new')
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
        {ready ? <Outlet /> : null}
      </main>
    </div>
  )
}
