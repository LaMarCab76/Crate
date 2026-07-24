/**
 * Electron wraps errors rejected by ipcMain.handle, so an AbortError raised in
 * the main process can arrive with `name === "Error"` and the original name
 * embedded in its message. An audition open is aborted only when another
 * open/close/invalidation supersedes it; that is an expected lifecycle change.
 */
export function isExpectedAuditionCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'AbortError') return true
  return /(?:^|:\s)AbortError(?::|\b)/.test(error.message)
}
