import { useQueueStore } from '@renderer/stores/queueStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'

// Small circular spinner meant to sit inside an artwork container as a
// position:absolute overlay. Each view (fullscreen player, player pane, bottom
// bar) renders this directly under its <Artwork>, so the spinner sits exactly
// over the album art instead of taking over the whole screen.
export function TrackLoadingOverlay() {
  const visible = usePlaybackStore(s => s.isTrackLoading)
  const target = useQueueStore(s => s.transitionTarget)

  if (!visible) return null

  return (
    <div
      className="track-loading-overlay"
      aria-live="polite"
      aria-label={target ? `Loading ${target.t}` : 'Loading next track'}
    >
      <div className="track-loading-spinner" aria-hidden="true" />
    </div>
  )
}
