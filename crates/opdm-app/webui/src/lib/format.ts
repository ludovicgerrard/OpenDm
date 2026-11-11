export const bytes = (n: number) => {
  if (!n) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4)
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`
}
export const duration = (s?: number) => !s ? '—' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
export const pct = (d: { size: number; downloaded: number }) => d.size ? Math.min(100, (d.downloaded / d.size) * 100) : 0
