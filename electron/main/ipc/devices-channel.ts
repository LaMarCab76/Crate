import { ipcMain } from 'electron'
import { getDeviceSyncService } from '../devices/DeviceSyncService'
import { assertNonEmptyString } from './validation'
import type {
  DeviceConnectPayload,
  DeviceSettingsUpdate,
  DeviceSyncPlanRequest,
} from '@shared/types/device-sync'

function assertConnectPayload(value: unknown): DeviceConnectPayload {
  if (!value || typeof value !== 'object') throw new Error('Invalid device payload')
  const payload = value as DeviceConnectPayload
  return {
    ...payload,
    rootPath: assertNonEmptyString(payload.rootPath, 'device root path'),
  }
}

function assertPlanRequest(value: unknown): DeviceSyncPlanRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid sync request')
  const payload = value as DeviceSyncPlanRequest
  return {
    ...payload,
    deviceId: assertNonEmptyString(payload.deviceId, 'device id'),
  }
}

function assertSettingsUpdate(value: unknown): DeviceSettingsUpdate {
  if (!value || typeof value !== 'object') throw new Error('Invalid device settings')
  const payload = value as DeviceSettingsUpdate
  if (payload.artworkMaxEdge !== undefined && typeof payload.artworkMaxEdge !== 'number') {
    throw new Error('Invalid artwork limit')
  }
  if (payload.defaultMode !== undefined) {
    if (
      payload.defaultMode !== 'pc_to_device' &&
      payload.defaultMode !== 'device_to_pc' &&
      payload.defaultMode !== 'bidirectional_safe'
    ) {
      throw new Error('Invalid sync mode')
    }
  }
  if (payload.pcTargetPath !== undefined && typeof payload.pcTargetPath !== 'string') {
    throw new Error('Invalid PC target path')
  }
  if (payload.sourceLibraryIds !== undefined) {
    if (
      !Array.isArray(payload.sourceLibraryIds) ||
      payload.sourceLibraryIds.some(id => typeof id !== 'number')
    ) {
      throw new Error('Invalid source libraries')
    }
  }
  return payload
}

function assertPathList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Invalid file list')
  return value.map(path => assertNonEmptyString(path, 'file path'))
}

export function registerDevicesChannel(): void {
  const service = getDeviceSyncService()

  ipcMain.handle('devices:detectCandidates', () => service.detectCandidates())
  ipcMain.handle('devices:volumes', () => service.volumeSnapshot())
  ipcMain.handle('devices:volumes:ignore', (_, rootPath: unknown) =>
    service.ignoreVolume(assertNonEmptyString(rootPath, 'volume root path')),
  )
  ipcMain.handle('devices:pickRoot', () => service.pickRoot())
  ipcMain.handle('devices:connect', (_, payload: unknown) => service.connect(assertConnectPayload(payload)))
  ipcMain.handle('devices:updateSettings', (_, deviceId: unknown, settings: unknown) =>
    service.updateSettings(
      assertNonEmptyString(deviceId, 'device id'),
      assertSettingsUpdate(settings),
    ),
  )
  ipcMain.handle('devices:list', () => service.listDevices())
  ipcMain.handle('devices:scan', (_, deviceId: unknown) =>
    service.scan(assertNonEmptyString(deviceId, 'device id')),
  )
  ipcMain.handle('devices:library', (_, deviceId: unknown) =>
    service.deviceLibrary(assertNonEmptyString(deviceId, 'device id')),
  )
  ipcMain.handle('devices:planSync', (_, payload: unknown) =>
    service.planSync(assertPlanRequest(payload)),
  )
  ipcMain.handle('devices:applySync', (_, planId: unknown) =>
    service.applySync(assertNonEmptyString(planId, 'plan id')),
  )
  ipcMain.handle('devices:rockboxThemes:install', (_, deviceId: unknown, paths: unknown) =>
    service.installRockboxThemes(
      assertNonEmptyString(deviceId, 'device id'),
      assertPathList(paths),
    ),
  )
  ipcMain.handle('devices:listPendingJournals', () => service.listPendingJournals())
  ipcMain.handle('devices:resumeJournal', (_, journalId: unknown) =>
    service.resumeJournal(assertNonEmptyString(journalId, 'journal id')),
  )
  ipcMain.handle('devices:discardJournal', (_, journalId: unknown) =>
    service.discardJournal(assertNonEmptyString(journalId, 'journal id')),
  )
}
