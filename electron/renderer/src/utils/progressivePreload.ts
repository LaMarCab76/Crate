import type { PlaybackStatus, StreamLoadSource } from '@shared/types/ipc-contract'

// Preload no later than the final lead window, but usually much earlier (halfway
// through the current track) once the current stream is already resident in RAM.
// That keeps current-track promotion prioritized while giving slow media enough
// runway to load the next full file before the gapless swap.
export const PRELOAD_LEAD_SECONDS = 12
export const PRELOAD_EARLY_FRACTION = 0.5

function preloadThresholdSec(durationSec: number): number {
  return Math.min(durationSec * PRELOAD_EARLY_FRACTION, Math.max(0, durationSec - PRELOAD_LEAD_SECONDS))
}

export interface UpcomingPreloadDecisionInput {
  status: PlaybackStatus
  durationSec: number
  positionSec: number
  streamSource: StreamLoadSource
  bufferComplete: boolean
  isTrackTransitioning: boolean
  nextPath?: string | null
  alreadyPreloadedPath?: string | null
}

export function shouldPreloadUpcomingTrack(input: UpcomingPreloadDecisionInput): boolean {
  if (input.status !== 'playing') return false
  if (!Number.isFinite(input.durationSec) || input.durationSec <= 0) return false
  if (!Number.isFinite(input.positionSec) || input.positionSec < preloadThresholdSec(input.durationSec)) return false
  if (input.isTrackTransitioning) return false
  if (!input.nextPath) return false
  if (input.alreadyPreloadedPath === input.nextPath) return false

  if (input.streamSource === 'file') return false
  if (input.streamSource === 'progressive' && !input.bufferComplete) return false

  return true
}
