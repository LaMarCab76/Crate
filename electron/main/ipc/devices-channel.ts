import { ipcMain } from 'electron'
import { isAbsolute } from 'node:path'
import { getDeviceSyncService } from '../devices/DeviceSyncService'
import { assertNonEmptyString } from './validation'
import {
  DEVICE_ARTWORK_EDGE_MAX,
  DEVICE_ARTWORK_EDGE_MIN,
} from '@shared/constants/device-sync'
import type {
  DeviceConnectPayload,
  DeviceArtworkOptimizationSelection,
  DeviceSettingsUpdate,
  DeviceSyncApplySelection,
  DeviceSyncActionKind,
  DeviceSyncPlanRequest,
} from '@shared/types/device-sync'

function assertSafePath(value: unknown, label: string): string {
  const str = assertNonEmptyString(value, label)
  if (!isAbsolute(str)) throw new Error(`Invalid ${label}: must be absolute`)
  const segments = str.split(/[\\/]/)
  if (segments.some(seg => seg === '..')) {
    throw new Error(`Invalid ${label}: path traversal not allowed`)
  }
  return str
}

function assertArtworkEdge(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('Invalid artwork limit')
  }
  if (value < DEVICE_ARTWORK_EDGE_MIN || value > DEVICE_ARTWORK_EDGE_MAX) {
    throw new Error(
      `Invalid artwork limit: must be between ${DEVICE_ARTWORK_EDGE_MIN} and ${DEVICE_ARTWORK_EDGE_MAX}`,
    )
  }
  return value
}

function assertConnectPayload(value: unknown): DeviceConnectPayload {
  if (!value || typeof value !== 'object') throw new Error('Invalid device payload')
  const payload = value as DeviceConnectPayload
  if (payload.musicRoot !== undefined && typeof payload.musicRoot !== 'string') {
    throw new Error('Invalid device music root')
  }
  if (payload.pcTargetPath !== undefined) {
    if (typeof payload.pcTargetPath !== 'string') {
      throw new Error('Invalid PC target path')
    }
    if (payload.pcTargetPath.length > 0) {
      assertSafePath(payload.pcTargetPath, 'PC target path')
    }
  }
  if (payload.fetchMissingLyrics !== undefined && typeof payload.fetchMissingLyrics !== 'boolean') {
    throw new Error('Invalid fetchMissingLyrics flag')
  }
  if (payload.optimizeArtworkOnSync !== undefined && typeof payload.optimizeArtworkOnSync !== 'boolean') {
    throw new Error('Invalid optimizeArtworkOnSync flag')
  }
  if (payload.sourceLibraryIds !== undefined) {
    if (
      !Array.isArray(payload.sourceLibraryIds) ||
      payload.sourceLibraryIds.some(id => typeof id !== 'number')
    ) {
      throw new Error('Invalid source libraries')
    }
  }
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
  if (payload.artworkMaxEdge !== undefined) {
    assertArtworkEdge(payload.artworkMaxEdge)
  }
  if (payload.fetchMissingLyrics !== undefined && typeof payload.fetchMissingLyrics !== 'boolean') {
    throw new Error('Invalid fetchMissingLyrics flag')
  }
  if (payload.optimizeArtworkOnSync !== undefined && typeof payload.optimizeArtworkOnSync !== 'boolean') {
    throw new Error('Invalid optimizeArtworkOnSync flag')
  }
  if (payload.musicRoot !== undefined && typeof payload.musicRoot !== 'string') {
    throw new Error('Invalid device music root')
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
  if (payload.syncBase !== undefined) {
    if (payload.syncBase !== 'pc' && payload.syncBase !== 'device' && payload.syncBase !== 'review') {
      throw new Error('Invalid sync base')
    }
  }
  if (payload.pcTargetPath !== undefined) {
    if (typeof payload.pcTargetPath !== 'string') {
      throw new Error('Invalid PC target path')
    }
    if (payload.pcTargetPath.length > 0) {
      assertSafePath(payload.pcTargetPath, 'PC target path')
    }
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

function assertArtworkOptimizationSelection(value: unknown): DeviceArtworkOptimizationSelection | undefined {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object') throw new Error('Invalid artwork optimization selection')
  const payload = value as DeviceArtworkOptimizationSelection
  if (!Array.isArray(payload.relativePaths)) {
    throw new Error('Invalid artwork optimization paths')
  }
  return {
    relativePaths: payload.relativePaths.map(path => assertNonEmptyString(path, 'artwork relative path')),
  }
}

function assertActionKind(value: unknown): DeviceSyncActionKind {
  if (
    value === 'copy_pc_to_device' ||
    value === 'copy_device_to_pc' ||
    value === 'replace_device' ||
    value === 'replace_pc' ||
    value === 'delete_device' ||
    value === 'delete_pc' ||
    value === 'skip_conflict'
  ) {
    return value
  }
  throw new Error('Invalid sync action kind')
}

function assertApplySelection(value: unknown): DeviceSyncApplySelection | undefined {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object') throw new Error('Invalid sync selection')
  const payload = value as DeviceSyncApplySelection
  const actionIds = payload.actionIds === undefined
    ? undefined
    : Array.isArray(payload.actionIds)
      ? payload.actionIds.map(id => assertNonEmptyString(id, 'sync action id'))
      : (() => { throw new Error('Invalid sync action ids') })()
  const conflictResolutions = payload.conflictResolutions === undefined
    ? undefined
    : Array.isArray(payload.conflictResolutions)
      ? payload.conflictResolutions.map(item => {
          if (!item || typeof item !== 'object') throw new Error('Invalid conflict resolution')
          return {
            actionId: assertNonEmptyString(item.actionId, 'conflict action id'),
            kind: assertActionKind(item.kind),
          }
        })
      : (() => { throw new Error('Invalid conflict resolutions') })()
  if (payload.optimizeArtwork !== undefined && typeof payload.optimizeArtwork !== 'boolean') {
    throw new Error('Invalid optimizeArtwork flag')
  }
  return { actionIds, conflictResolutions, optimizeArtwork: payload.optimizeArtwork }
}

export function registerDevicesChannel(): void {
  const service = getDeviceSyncService()

  ipcMain.handle('devices:detectCandidates', () => service.detectCandidates())
  ipcMain.handle('devices:volumes', () => service.volumeSnapshot())
  ipcMain.handle('devices:volumes:ignore', (_, rootPath: unknown) =>
    service.ignoreVolume(assertNonEmptyString(rootPath, 'volume root path')),
  )
  ipcMain.handle('devices:pickRoot', () => service.pickRoot())
  ipcMain.handle('devices:pickMusicRoot', (_, rootPath: unknown, currentMusicRoot: unknown) =>
    service.pickMusicRoot(
      assertNonEmptyString(rootPath, 'device root path'),
      currentMusicRoot === undefined ? undefined : assertNonEmptyString(currentMusicRoot, 'device music root'),
    ),
  )
  ipcMain.handle('devices:connect', (_, payload: unknown) => service.connect(assertConnectPayload(payload)))
  ipcMain.handle('devices:updateSettings', (_, deviceId: unknown, settings: unknown) =>
    service.updateSettings(
      assertNonEmptyString(deviceId, 'device id'),
      assertSettingsUpdate(settings),
    ),
  )
  ipcMain.handle('devices:list', () => service.listDevices())
  ipcMain.handle('devices:overview', (_, deviceId: unknown) =>
    service.overview(assertNonEmptyString(deviceId, 'device id')),
  )
  ipcMain.handle('devices:scan', (_, deviceId: unknown) =>
    service.scan(assertNonEmptyString(deviceId, 'device id')),
  )
  ipcMain.handle('devices:library', (_, deviceId: unknown) =>
    service.deviceLibrary(assertNonEmptyString(deviceId, 'device id')),
  )
  ipcMain.handle('devices:analyzeArtwork', (_, deviceId: unknown) =>
    service.analyzeDeviceArtwork(assertNonEmptyString(deviceId, 'device id')),
  )
  ipcMain.handle('devices:rockboxThemes', (_, deviceId: unknown) =>
    service.rockboxThemes(assertNonEmptyString(deviceId, 'device id')),
  )
  ipcMain.handle('devices:planSync', (_, payload: unknown) =>
    service.planSync(assertPlanRequest(payload)),
  )
  ipcMain.handle('devices:applySync', (_, planId: unknown, selection: unknown) =>
    service.applySync(assertNonEmptyString(planId, 'plan id'), assertApplySelection(selection)),
  )
  ipcMain.handle('devices:optimizeArtwork', (_, deviceId: unknown, selection: unknown) =>
    service.optimizeDeviceArtwork(
      assertNonEmptyString(deviceId, 'device id'),
      assertArtworkOptimizationSelection(selection),
    ),
  )
  ipcMain.handle('devices:rockboxThemes:install', (_, deviceId: unknown, paths: unknown) =>
    service.installRockboxThemes(
      assertNonEmptyString(deviceId, 'device id'),
      assertPathList(paths),
    ),
  )
  ipcMain.handle('devices:rockboxThemes:delete', (_, deviceId: unknown, themeId: unknown) =>
    service.deleteRockboxTheme(
      assertNonEmptyString(deviceId, 'device id'),
      assertNonEmptyString(themeId, 'theme id'),
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
