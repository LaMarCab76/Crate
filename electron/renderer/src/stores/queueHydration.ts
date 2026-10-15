/** Restore renderer identity for an engine stream which survived a reload.
 * This bridge can only read engine status and adopt library metadata; it never
 * loads, seeks, pauses or restarts the native stream.
 */
export interface EngineTrackRecovery<T extends { path?: string }> {
  availableTracks: readonly T[]
  readEngineStatus(): Promise<{ currentPath: string | null; status: string }>
  currentTrack(): T | null
  transitionToken(): number
  isTransitioning(): boolean
  adopt(track: T): void
}

export async function recoverEngineTrack<T extends { path?: string }>(recovery: EngineTrackRecovery<T>): Promise<boolean> {
  const token = recovery.transitionToken()
  if (recovery.currentTrack() || recovery.isTransitioning()) return false
  const status = await recovery.readEngineStatus()
  // A user action may have loaded, cleared or started preparing another track
  // while IPC was pending. Never adopt the older engine reply over that action.
  if (token !== recovery.transitionToken() || recovery.currentTrack() || recovery.isTransitioning()) return false
  if (!status.currentPath || status.status === 'loading') return false
  const track = recovery.availableTracks.find(candidate => candidate.path === status.currentPath)
  if (!track) return false
  recovery.adopt(track)
  return true
}

interface QueueHydrationState<T> {
  tracks: readonly T[]
  currentIndex: number
  repeat: string
  shuffle: boolean
  isTrackTransitioning: boolean
  transitionTarget: T | null
}

/** User changes made while the persisted queue was loading take precedence. */
export function canRestoreQueueSnapshot<T>(
  initial: QueueHydrationState<T>,
  current: QueueHydrationState<T>,
  currentTrack: T | null,
  tokenAtStart: number,
  currentToken: number,
): boolean {
  return tokenAtStart === currentToken && current.tracks === initial.tracks &&
    current.currentIndex === initial.currentIndex && current.shuffle === initial.shuffle &&
    current.repeat === initial.repeat && !current.isTrackTransitioning &&
    current.transitionTarget == null && currentTrack == null
}
