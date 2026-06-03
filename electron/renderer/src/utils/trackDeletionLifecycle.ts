export interface TrackDeletionLifecycleOptions<TResult> {
  visualDelayMs: number
  wait(ms: number): Promise<void>
  prepareBeforeDelete?: () => Promise<void> | void
  // Settles the UI optimistically once the collapse animation has played. Runs
  // BEFORE the disk deletion so the list never waits on the drive to confirm.
  settleUi(): void
  deleteTracks(): Promise<TResult>
  afterDelete?: (result: TResult) => Promise<void> | void
  // Reconciles the in-memory library with the real DB state once the disk
  // deletion settles. Runs in `finally`; it must restore any rows that failed
  // to delete. Errors here are swallowed so a failed reconcile never surfaces.
  reconcile(): Promise<void>
}

export interface TrackDeletionLifecycleHandle {
  // Resolves once the collapse animation has played and the UI has settled
  // optimistically. The disk deletion has NOT necessarily started yet.
  settled: Promise<void>
  // Resolves once the background disk deletion + reconciliation finish. Never
  // rejects: trash failures are reported out-of-band (e.g. the Activity Center)
  // and reconcile() restores whatever survived.
  completed: Promise<void>
}

// Orchestrates a track deletion so the visual phase is fully decoupled from the
// disk: play the collapse animation, settle the UI, then move the files to the
// trash in the background and reconcile against the database.
export function runTrackDeletionLifecycle<TResult>({
  visualDelayMs,
  wait,
  prepareBeforeDelete,
  settleUi,
  deleteTracks,
  afterDelete,
  reconcile,
}: TrackDeletionLifecycleOptions<TResult>): TrackDeletionLifecycleHandle {
  let resolveSettled!: () => void
  const settled = new Promise<void>(resolve => {
    resolveSettled = resolve
  })

  const completed = (async () => {
    try {
      await Promise.all([
        visualDelayMs > 0 ? wait(visualDelayMs) : Promise.resolve(),
        prepareBeforeDelete?.() ?? Promise.resolve(),
      ])
    } catch {
      // Playback shutdown failed; still settle and delete — the user asked to
      // remove the track and the UI must not stay stuck on the collapsed row.
    }

    settleUi()
    resolveSettled()

    try {
      const result = await deleteTracks()
      await afterDelete?.(result)
    } catch {
      // Disk deletion failed; reconcile() below restores the surviving rows.
    } finally {
      try {
        await reconcile()
      } catch {
        /* Keep the UI usable even if the reconcile refresh fails. */
      }
    }
  })()

  return { settled, completed }
}
