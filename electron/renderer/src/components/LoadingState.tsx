// Reusable full-box loading state: an animated spinner with a label, sized for a
// .device-empty.large container. Reuses the existing .track-loading-spinner CSS
// (border + spin animation, reduced-motion already handled in globals.css) so the
// spinner keeps animating while the main process loads data off the event loop.
export function LoadingState({ label }: { label: string }) {
  return (
    <div className="device-empty large loading-state" role="status" aria-live="polite">
      <div className="track-loading-spinner loading-state-spinner" aria-hidden="true" />
      <span className="loading-state-label">{label}</span>
    </div>
  )
}
