import { isAbsolute, resolve, sep } from 'node:path'
import type { BackupTrack } from '@shared/types/library-backup'

// Backup keys are always POSIX-style relative paths. Treat them as untrusted:
// accepting `..`, absolute paths, drive letters or backslashes would let a
// hand-edited portable backup address tracks outside the registered library.
export function resolvePortableTrackPath(folderPath: string, portablePath: string): string | null {
  if (typeof portablePath !== 'string' || portablePath.length === 0) return null
  if (portablePath.includes('\\') || portablePath.includes('\0')) return null
  if (portablePath.startsWith('/') || /^[A-Za-z]:\//.test(portablePath)) return null

  const parts = portablePath.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) return null

  const root = resolve(folderPath)
  const candidate = resolve(root, ...parts)
  if (isAbsolute(portablePath)) return null
  if (!candidate.startsWith(`${root}${sep}`)) return null
  return candidate
}

export function portableTrackState(row: {
  play_count: number
  last_played_date: string | null
  is_favorite: number
  rating: number | null
  state_updated_at: number | null
}): BackupTrack | null {
  const isDefault =
    (row.play_count ?? 0) === 0 &&
    !row.last_played_date &&
    (row.is_favorite ?? 0) === 0 &&
    row.rating == null &&
    !row.state_updated_at
  if (isDefault) return null

  const entry: BackupTrack = {}
  if (row.play_count > 0) entry.playCount = row.play_count
  if (row.last_played_date) entry.lastPlayedAt = row.last_played_date
  if (row.state_updated_at) {
    entry.favorite = Boolean(row.is_favorite)
    entry.rating = row.rating
    entry.stateUpdatedAt = new Date(row.state_updated_at).toISOString()
  } else {
    if (row.is_favorite) entry.favorite = true
    if (row.rating != null) entry.rating = row.rating
  }
  return entry
}

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

export function mergedPortableTrackState(
  dbTrack: {
    play_count: number
    last_played_date: string | null
    is_favorite: number
    rating: number | null
    state_updated_at: number | null
  },
  backup: BackupTrack,
): [number, string | null, number, number | null, number | null] {
  const backupTs = backup.stateUpdatedAt ? Date.parse(backup.stateUpdatedAt) || 0 : 0
  const dbTs = dbTrack.state_updated_at ?? 0
  const backupWins = backupTs > dbTs
  return [
    Math.max(dbTrack.play_count ?? 0, backup.playCount ?? 0),
    maxIso(dbTrack.last_played_date, backup.lastPlayedAt ?? null),
    backupWins && backup.favorite !== undefined ? (backup.favorite ? 1 : 0) : dbTrack.is_favorite,
    backupWins && backup.rating !== undefined ? backup.rating : dbTrack.rating,
    Math.max(dbTs, backupTs) || null,
  ]
}
