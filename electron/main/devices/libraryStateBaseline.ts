/**
 * Pure helpers for computing the on-device sync baseline (`library-state.yaml`).
 *
 * The baseline records the last *settled* state of every track so the next sync
 * can tell an intentional deletion apart from a track that was simply never
 * copied. It must therefore advance only for tracks that are genuinely in sync,
 * and preserve the previous entry for tracks whose change is still pending.
 *
 * Kept import-free so it can be unit-tested directly by the Node test runner.
 */

export interface BaselineSnapshotLike {
  fingerprint: string
}

export interface BaselineTrackMaps<T> {
  pc: Record<string, T>
  device: Record<string, T>
}

export interface BaselineMergeInput<T extends BaselineSnapshotLike> {
  /** Snapshot of the PC library, scanned after the sync finished. */
  currentPc: Record<string, T>
  /** Snapshot of the device music tree, scanned after the sync finished. */
  currentDevice: Record<string, T>
  /** PC tracks from the previous baseline (`library-state.yaml`). */
  previousPc: Record<string, T>
  /** Device tracks from the previous baseline (`library-state.yaml`). */
  previousDevice: Record<string, T>
}

/**
 * Merge the post-sync reality with the previous baseline.
 *
 * For each track key:
 *  - **In sync** (present on both sides with matching fingerprints) → record the
 *    current reality. This is the only case that advances the baseline.
 *  - **Gone from both sides** → drop it from the baseline entirely.
 *  - **Still out of sync** (only one side has it, or fingerprints differ) → keep
 *    the previous baseline entry. The change is pending — its action was
 *    deselected, skipped, or left unresolved — so preserving the last settled
 *    state lets the next sync re-detect and re-propose it instead of silently
 *    undoing it. Reverting this case is what made deleted tracks reappear.
 */
export function mergeLibraryStateBaseline<T extends BaselineSnapshotLike>(
  input: BaselineMergeInput<T>,
): BaselineTrackMaps<T> {
  const { currentPc, currentDevice, previousPc, previousDevice } = input
  const pc: Record<string, T> = {}
  const device: Record<string, T> = {}

  const keys = new Set([
    ...Object.keys(currentPc),
    ...Object.keys(currentDevice),
    ...Object.keys(previousPc),
    ...Object.keys(previousDevice),
  ])

  for (const key of keys) {
    const pcNow = currentPc[key]
    const deviceNow = currentDevice[key]

    if (pcNow && deviceNow && pcNow.fingerprint === deviceNow.fingerprint) {
      // Settled on both sides → advance the baseline to the current reality.
      pc[key] = pcNow
      device[key] = deviceNow
    } else if (!pcNow && !deviceNow) {
      // Removed everywhere → leave it out of the baseline.
      continue
    } else {
      // Pending change → keep the last settled state so it is re-proposed.
      if (previousPc[key]) pc[key] = previousPc[key]
      if (previousDevice[key]) device[key] = previousDevice[key]
    }
  }

  return { pc, device }
}
