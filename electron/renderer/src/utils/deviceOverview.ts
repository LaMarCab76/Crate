import type {
  DeviceCapacitySummary,
  DeviceOverviewResult,
  DeviceScanResult,
  DeviceStorageSummary,
} from '@shared/types/device-sync'

export function capacityFromStorage(storage: DeviceStorageSummary): DeviceCapacitySummary {
  return {
    totalBytes: storage.totalBytes,
    usedBytes: storage.usedBytes,
    freeBytes: storage.freeBytes,
    scannedAt: storage.scannedAt,
    error: storage.error,
  }
}

export function isUsableDeviceCapacity(
  capacity: DeviceCapacitySummary | null | undefined,
): boolean {
  return Boolean(capacity && !capacity.error && capacity.totalBytes > 0)
}

function timestamp(value: string | null | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function selectDeviceDashboardCapacity({
  deviceId,
  overview,
  scanResult,
}: {
  deviceId: string | null | undefined
  overview: DeviceOverviewResult | null | undefined
  scanResult: DeviceScanResult | null | undefined
}): DeviceCapacitySummary | null {
  const candidates: DeviceCapacitySummary[] = []
  const currentOverview = overview
  const currentScanResult = scanResult
  if (currentOverview != null && currentOverview.device.id === deviceId) candidates.push(currentOverview.capacity)
  if (currentScanResult != null && currentScanResult.device.id === deviceId) {
    candidates.push(capacityFromStorage(currentScanResult.storage))
  }

  if (candidates.length === 0) return null

  const usable = candidates
    .filter(isUsableDeviceCapacity)
    .sort((a, b) => timestamp(b.scannedAt) - timestamp(a.scannedAt))
  if (usable.length > 0) return usable[0]

  return candidates
    .slice()
    .sort((a, b) => timestamp(b.scannedAt) - timestamp(a.scannedAt))[0] ?? null
}
