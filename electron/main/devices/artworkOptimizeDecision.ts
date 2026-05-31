import type { ArtworkStatus } from '@shared/types/device-sync'

// Resolved state of a single track's embedded artwork for the optimize analysis.
export interface ArtworkClassifyState {
  // The device's max edge in pixels (square limit applied to BOTH width and height).
  maxEdge: number
  // The audio file carries at least one embedded picture.
  hasPicture: boolean
  // Decoded picture format; null when the bytes are neither JPEG nor PNG, or the
  // image could not be decoded — treated as unsupported for optimization.
  format: 'jpeg' | 'png' | null
  // Largest decoded dimensions across the file's pictures (null when undecodable).
  width: number | null
  height: number | null
}

// Pure classifier — no I/O. The caller probes the file (taglib + nativeImage),
// resolves this state, and uses the returned status to build the report.
//   no_artwork    -> the track carries no embedded picture
//   unsupported   -> a picture exists but its format/dimensions can't be read
//   oversized     -> width OR height exceeds the device max edge (needs optimizing)
//   within_limit  -> the artwork already fits the device limit
export function classifyArtwork(state: ArtworkClassifyState): ArtworkStatus {
  if (!state.hasPicture) return 'no_artwork'
  if (state.format === null || state.width === null || state.height === null) {
    return 'unsupported'
  }
  if (state.width > state.maxEdge || state.height > state.maxEdge) return 'oversized'
  return 'within_limit'
}
