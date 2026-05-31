import type { LyricsStatus } from '@shared/types/lyrics'

// A track is a background-backfill candidate only when it has no lyrics anywhere.
// getForTrack() returns 'none' exclusively when there is no sidecar, no embedded
// tag, and no session not-found mark — so this single check also skips tracks
// that already carry embedded lyrics (which fetchOnline alone would not detect)
// and tracks we already failed to match this session ('not_found'). Pure helper
// so the rule has one tested source of truth.
export function shouldBackfill(status: LyricsStatus): boolean {
  return status === 'none'
}
