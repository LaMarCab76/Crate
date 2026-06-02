import type { PlaybackStatus } from '@shared/types/ipc-contract'

export interface TransitionFadeDecisionInput {
  status: PlaybackStatus
  fadeOutMs: number
  isAutomatic: boolean
}

// Decides whether a track change should perform the crossfade volume dip.
// The fade is a deliberate cue for a *user-initiated* change; an automatic
// advance at the natural end of a track must stay seamless, so it never fades
// regardless of the configured crossfade time.
export function shouldApplyTransitionFade(input: TransitionFadeDecisionInput): boolean {
  if (input.isAutomatic) return false
  if (input.status !== 'playing') return false
  if (!Number.isFinite(input.fadeOutMs) || input.fadeOutMs <= 0) return false
  return true
}
