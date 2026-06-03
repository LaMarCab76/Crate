// Per-folder lyrics presence index. Each imported folder gets a hidden
// `.crate/lyrics-index.json` (alongside the portable `library.yaml`) that caches
// which tracks have lyrics and which don't. It exists purely to spare the lyrics
// library overview from reading every `.lrc` sidecar (and opening every audio
// file for embedded tags) on each open. It is a derived cache: if deleted it is
// rebuilt from disk on the next scan.
//
// Keys are POSIX-normalized paths relative to the folder root (same scheme as
// library.yaml), so the index survives the folder being moved or remounted.

import type { LyricsStatus, LyricsSource } from './lyrics'

export const LYRICS_INDEX_VERSION = 1
// Reuse the existing hidden app dir so both the backup and the index live
// together. Kept as its own constant (value identical to BACKUP_DIRNAME) so the
// two modules stay decoupled.
export const LYRICS_INDEX_DIRNAME = '.crate'
export const LYRICS_INDEX_FILENAME = 'lyrics-index.json'

// Compact, view-derived record. Only fields the library overview needs are
// cached; track metadata (title/artist/album/duration/path) is NOT stored here
// because it lives in the DB and would drift when the user edits tags.
export interface LyricsIndexEntry {
  status: LyricsStatus
  source: LyricsSource | null
  hasLyrics: boolean
  embeddedInFile: boolean
  sidecarWritten: boolean
}

export interface LyricsIndexFile {
  version: number
  appName: string
  createdAt: string // ISO 8601, set on first write only
  updatedAt: string // ISO 8601, refreshed every write
  entries: Record<string, LyricsIndexEntry> // POSIX-relative track path -> entry
}
