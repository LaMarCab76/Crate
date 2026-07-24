import type { PlaybackStatus } from '@shared/types/ipc-contract'

export interface MainPlaybackSnapshot {
  path: string | null
  positionSec: number
  status: PlaybackStatus
}

export interface MainPlaybackSessionEngine {
  getCurrentPath(): string | null
  getPosition(): number
  getStatus(): PlaybackStatus
  pause(): void
  seek(positionSec: number): void
  play(): void
  unload(): void
}

/**
 * A route teardown can overlap React Strict Mode's immediate remount. Exposing
 * the active close as a barrier lets the next begin wait until restoration has
 * finished, then capture a fresh snapshot instead of one that is being cleared.
 */
export class MainPlaybackSessionGate {
  private closing: Promise<void> | null = null

  get pendingClose(): Promise<void> | null {
    return this.closing
  }

  runClose(operation: () => Promise<void>): Promise<void> {
    if (this.closing) return this.closing
    let tracked: Promise<void>
    tracked = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.closing === tracked) this.closing = null
      })
    this.closing = tracked
    return tracked
  }
}

/**
 * Capture the main deck before duplicate review starts. The A/B deck owns its
 * own streams, so the main deck only needs to be silenced while the session is
 * active; its queue and loaded track stay untouched.
 */
export function captureMainPlayback(
  engine: MainPlaybackSessionEngine,
): MainPlaybackSnapshot {
  const snapshot: MainPlaybackSnapshot = {
    path: engine.getCurrentPath(),
    positionSec: engine.getPosition(),
    status: engine.getStatus(),
  }
  if (snapshot.status === 'playing') engine.pause()
  return snapshot
}

/**
 * Restore only the track captured at session start. A deleted track must leave
 * the main deck stopped, and an unrelated track loaded by another workflow
 * must never be replaced implicitly.
 */
export function restoreMainPlayback(
  engine: MainPlaybackSessionEngine,
  snapshot: MainPlaybackSnapshot,
  trackStillExists: boolean,
): void {
  if (!snapshot.path) return
  if (!trackStillExists) {
    if (engine.getCurrentPath() === snapshot.path) engine.unload()
    return
  }
  if (engine.getCurrentPath() !== snapshot.path) return

  engine.seek(snapshot.positionSec)
  if (snapshot.status === 'playing') engine.play()
  else if (snapshot.status === 'paused') engine.pause()
}
