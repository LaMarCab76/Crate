// Shared lyrics enums and DTOs used by main, preload and renderer.
// ipc-contract.ts imports the wire types from here.

export type LyricsSource = 'user' | 'embedded' | 'sidecar' | 'cache' | 'lrclib'

// Persistent / main-derived states. The renderer's store overlays the transient
// 'idle' | 'loading' | 'error' states on top of these for rendering.
export type LyricsStatus =
  | 'none'
  | 'found_plain'
  | 'found_synced'
  | 'instrumental'
  | 'not_found'
  | 'low_confidence'
  | 'failed_provider'

export type LyricsFailureReason =
  | 'missing_metadata'
  | 'provider_timeout'
  | 'provider_rate_limited'
  | 'provider_not_found'
  | 'low_confidence_match'
  | 'file_not_writable'
  | 'file_locked'
  | 'file_not_found'
  | 'not_flac'
  | 'existing_lyrics'
  | 'write_failed'
  | 'verification_failed'
  | 'backup_failed'
  | 'unknown'

// Provider-internal result (mirrors lrclib's payload, confidence 0..1).
export interface LyricsResult {
  source: LyricsSource
  sourceId?: string
  sourceUrl?: string
  plainLyrics?: string
  syncedLyricsLrc?: string
  instrumental: boolean
  confidence: number
}

// Authoritative object main returns for a track; the renderer renders from this.
export interface LyricsView {
  trackId: number
  status: LyricsStatus
  source: LyricsSource | null
  plainLyrics: string | null
  syncedLyricsLrc: string | null
  instrumental: boolean
  isUserEdited: boolean
  embeddedInFile: boolean
  sidecarWritten: boolean
  confidence: number
}

// One online search candidate (an lrclib /api/search row, normalized + scored).
export interface LyricsCandidate {
  id: string
  trackName: string
  artistName: string
  albumName: string | null
  durationSeconds: number | null
  instrumental: boolean
  hasSynced: boolean
  hasPlain: boolean
  score: number
}

export interface LyricsSelectionSummary {
  done: number
  found: number
  failed: number
}

export interface LyricsSelectionProgress {
  done: number
  total: number
  found: number
  failed: number
}

export interface LyricsSettingsState {
  autoFetch: boolean
  preferSynced: boolean
  // Proactively fetch missing lyrics from LRCLIB in the background as songs are
  // added, plus a one-time sweep of the existing library on startup. Distinct
  // from autoFetch, which only fires on playback. Default off (network traffic).
  backgroundFetch: boolean
  // Delete orphaned .lrc sidecar files (no sibling audio) during library scans.
  // Default off (destructive).
  deleteOrphanLyrics: boolean
}

export const LYRICS_SETTINGS_DEFAULTS: LyricsSettingsState = {
  autoFetch: true,
  preferSynced: true,
  backgroundFetch: false,
  deleteOrphanLyrics: false,
}
