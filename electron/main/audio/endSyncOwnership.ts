// A native end-of-stream callback can already be queued when its stream is
// replaced. Only the callback that owns the active registration may advance
// playback; callbacks belonging to an older stream must be ignored.
export function isActiveEndSyncRegistration<T>(
  active: T | null,
  candidate: T | null,
): candidate is T {
  return candidate !== null && active === candidate
}
