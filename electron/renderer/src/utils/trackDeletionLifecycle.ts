export interface TrackDeletionLifecycleOptions<TResult> {
  visualDelayMs: number
  wait(ms: number): Promise<void>
  prepareBeforeDelete?: () => Promise<void> | void
  deleteTracks(): Promise<TResult>
  afterDelete?: (result: TResult) => Promise<void> | void
  refresh(): Promise<void>
  cleanup(): void
}

export async function runTrackDeletionLifecycle<TResult>({
  visualDelayMs,
  wait,
  prepareBeforeDelete,
  deleteTracks,
  afterDelete,
  refresh,
  cleanup,
}: TrackDeletionLifecycleOptions<TResult>): Promise<TResult> {
  try {
    await Promise.all([
      visualDelayMs > 0 ? wait(visualDelayMs) : Promise.resolve(),
      prepareBeforeDelete?.() ?? Promise.resolve(),
    ])

    const result = await deleteTracks()
    await afterDelete?.(result)
    await refresh()
    return result
  } catch (err) {
    try {
      await refresh()
    } catch {
      /* Keep the original failure. */
    }
    throw err
  } finally {
    cleanup()
  }
}
