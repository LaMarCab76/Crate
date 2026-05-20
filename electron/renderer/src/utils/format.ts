export function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  const x = Math.floor(s % 60)
  return `${m}:${x.toString().padStart(2, '0')}`
}

export function fmtTotal(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

export function fmtFileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '-'
  const mb = bytes / 1024 / 1024
  if (mb < 1024) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`

  const gb = mb / 1024
  return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`
}
