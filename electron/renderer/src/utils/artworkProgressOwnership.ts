export function artworkOptimizationOwnsSyncProgress({
  optimizing,
  deviceId,
  syncProgressDeviceId,
  syncProgressPhase,
}: {
  optimizing: boolean
  deviceId: string
  syncProgressDeviceId?: string | null
  syncProgressPhase?: string | null
}): boolean {
  return optimizing && syncProgressDeviceId === deviceId && syncProgressPhase === 'optimizing_artwork'
}
