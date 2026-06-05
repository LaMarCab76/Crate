import { parseArtistName } from '@shared/utils/artistName'

// Guest-artist display helpers live in the shared module so both the renderer
// and the test runner can use them; re-exported here so components keep a
// single import source (@renderer/utils/format).
export { FEATURED_PREFIX, formatFeatured, titleWithFeatured } from '@shared/utils/artistName'

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  const x = Math.floor(s % 60)
  return `${m}:${x.toString().padStart(2, '0')}`
}

// Display-only split of a raw artist string into the primary artist and any
// featured guests. NEVER mutate track.artist with this — the raw string is
// still used for search/sort and "various artists" detection.
export function splitArtist(raw: string): { primary: string; featured: string[] } {
  const { primary, featured } = parseArtistName(raw || '')
  return { primary, featured }
}

export interface PlaybackTimePair {
  elapsedSec: number
  remainingSec: number
  elapsedText: string
  remainingText: string
}

function wholeSeconds(s: number): number {
  return Number.isFinite(s) ? Math.max(0, Math.floor(s)) : 0
}

export function formatPlaybackTimePair(positionSec: number, durationSec: number): PlaybackTimePair {
  const durationWholeSec = wholeSeconds(durationSec)
  const positionWholeSec = wholeSeconds(positionSec)
  const elapsedSec = durationWholeSec > 0
    ? Math.min(positionWholeSec, durationWholeSec)
    : positionWholeSec
  const remainingSec = durationWholeSec > 0
    ? Math.max(0, durationWholeSec - elapsedSec)
    : 0

  return {
    elapsedSec,
    remainingSec,
    elapsedText: fmtTime(elapsedSec),
    remainingText: fmtTime(remainingSec),
  }
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
