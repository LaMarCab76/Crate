// Portable library metadata file dropped at the root of every imported folder
// as `.hifidelity-library.json`. Carries user-modifiable state (favorites,
// play counts, ratings, lyrics, EQ overrides) so it can travel with the audio
// files between machines.
//
// Track keys are POSIX-normalized paths relative to the folder root (forward
// slashes even on Windows) so the entry stays valid when the folder is moved
// or mounted at a different absolute path. Artist keys are the raw artist
// name (matched against `artists.name`) because DB IDs do not survive a fresh
// import.
//
// All entries omit fields that are at their default value; this keeps the
// JSON human-readable and small. `stateUpdatedAt` is the per-entry "last
// modified" timestamp used by the merge logic to decide which side wins on
// re-import.

export const BACKUP_VERSION = 1
export const BACKUP_FILENAME = '.hifidelity-library.json'

export interface BackupEqOverride {
  enabled: boolean
  bands: number[]   // EQ gains in dB; older backups are normalized on import
}

export interface BackupLyrics {
  lrc: string
  language: string | null
  source: string | null
}

export interface BackupTrack {
  playCount?: number
  lastPlayedAt?: string | null   // ISO 8601
  favorite?: boolean
  rating?: number | null
  eqOverride?: BackupEqOverride | null
  lyrics?: BackupLyrics | null
  stateUpdatedAt?: string | null // ISO 8601
}

export interface BackupArtist {
  favorite?: boolean
  stateUpdatedAt?: string | null // ISO 8601
}

export interface BackupFile {
  version: number
  appName: string
  createdAt: string             // ISO 8601, only set on the first write
  updatedAt: string             // ISO 8601, refreshed on every write
  tracks: Record<string, BackupTrack>
  artists: Record<string, BackupArtist>
}
