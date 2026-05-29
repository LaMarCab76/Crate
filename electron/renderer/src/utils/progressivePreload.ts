import type { PlaybackStatus, StreamLoadSource } from '@shared/types/ipc-contract'

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
  if (!Number.isFinite(input.positionSec) || input.positionSec < input.durationSec / 2) return false
  if (input.isTrackTransitioning) return false
  if (!input.nextPath) return false
  if (input.alreadyPreloadedPath === input.nextPath) return false

  if (input.streamSource === 'file') return false
  if (input.streamSource === 'progressive' && !input.bufferComplete) return false

  return true
}
