import { parseArtistName } from '@shared/utils/artistName'
export { fmtTime, formatPlaybackTimePair } from './playbackTime'

// Guest-artist display helpers live in the shared module so both the renderer
// and the test runner can use them; re-exported here so components keep a
// single import source (@renderer/utils/format).
export { FEATURED_PREFIX, formatFeatured, titleWithFeatured } from '@shared/utils/artistName'

// Display-only split of a raw artist string into the primary artist and any
// featured guests. NEVER mutate track.artist with this — the raw string is
// still used for search/sort and "various artists" detection.
export function splitArtist(raw: string): { primary: string; featured: string[] } {
  const { primary, featured } = parseArtistName(raw || '')
  return { primary, featured }
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
