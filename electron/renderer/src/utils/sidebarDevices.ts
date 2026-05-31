import type { DeviceRecord } from '@shared/types/device-sync'

export function visibleSidebarDevices<T extends Pick<DeviceRecord, 'isAvailable'>>(devices: T[]): T[] {
  return devices.filter(device => device.isAvailable)
}
