import type { LibraryProvider } from '@shared/types/library-locations'

/**
 * Playback analysis only accepts filesystem paths. Cloud playback itself is
 * supported elsewhere through RAM materialization, but the native decoder and
 * stat calls in this service must never receive a synthetic OneDrive URI.
 */
export function requireFilesystemPlaybackAnalysisPath(
  path: string,
  provider?: LibraryProvider,
): string {
  if (provider === 'onedrive' || /^onedrive:\/\//i.test(path)) {
    throw new Error('Playback analysis is unavailable for OneDrive tracks')
  }
  return path
}
