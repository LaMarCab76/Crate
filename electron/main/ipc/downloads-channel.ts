import { ipcMain } from 'electron'
import { getDownloadManager } from '../downloads/DownloadManager'
import { assertId, assertNonEmptyString } from './validation'
import type {
  DownloadProvider,
  DownloadQuality,
  DownloadSearchRequest,
  DownloadSettings,
  EnqueueDownloadRequest,
  ProviderCredentialsPayload,
  ServiceTutorialState,
} from '@shared/types/downloads'

function assertProvider(value: unknown): DownloadProvider {
  if (value !== 'qobuz' && value !== 'tidal') throw new Error('Invalid download provider')
  return value
}

function assertQuality(value: unknown): DownloadQuality | undefined {
  if (value == null) return undefined
  if (value !== 'best' && value !== 'hires' && value !== 'lossless' && value !== 'mp3-320') {
    throw new Error('Invalid download quality')
  }
  return value
}

function assertSettingsPatch(value: unknown): Partial<DownloadSettings> {
  if (!value || typeof value !== 'object') throw new Error('Invalid download settings')
  const input = value as Partial<DownloadSettings>
  return {
    folderId: input.folderId == null ? null : assertId(input.folderId, 'folder id'),
    quality: assertQuality(input.quality),
    concurrency: input.concurrency,
  }
}

function assertCredentialsPayload(value: unknown): ProviderCredentialsPayload {
  if (!value || typeof value !== 'object') throw new Error('Invalid credentials payload')
  const payload = value as ProviderCredentialsPayload
  return { ...payload, provider: assertProvider(payload.provider) } as ProviderCredentialsPayload
}

function assertPathList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Invalid HAR file list')
  return value.map(path => assertNonEmptyString(path, 'HAR file path'))
}

function assertTutorialPatch(value: unknown): Partial<ServiceTutorialState> {
  if (!value || typeof value !== 'object') throw new Error('Invalid tutorial state')
  const input = value as Partial<ServiceTutorialState>
  return {
    seen: typeof input.seen === 'boolean' ? input.seen : undefined,
    lastShownAt: input.lastShownAt == null ? null : typeof input.lastShownAt === 'number' ? input.lastShownAt : undefined,
  }
}

function assertSearchRequest(value: unknown): DownloadSearchRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid search request')
  const payload = value as DownloadSearchRequest
  return {
    provider: assertProvider(payload.provider),
    query: assertNonEmptyString(payload.query, 'search query'),
    limit: typeof payload.limit === 'number' ? Math.max(1, Math.min(50, Math.round(payload.limit))) : undefined,
  }
}

function assertEnqueueRequest(value: unknown): EnqueueDownloadRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid enqueue request')
  const payload = value as EnqueueDownloadRequest
  if (!Array.isArray(payload.providerTrackIds)) throw new Error('Invalid provider track ids')
  return {
    provider: assertProvider(payload.provider),
    providerTrackIds: payload.providerTrackIds.map(id => assertNonEmptyString(id, 'provider track id')),
    folderId: payload.folderId == null ? null : assertId(payload.folderId, 'folder id'),
    quality: assertQuality(payload.quality),
  }
}

export function registerDownloadsChannel(): void {
  const manager = getDownloadManager()

  ipcMain.handle('downloads:settings:get', () => manager.getSettings())
  ipcMain.handle('downloads:settings:set', (_, patch: unknown) =>
    manager.setSettings(assertSettingsPatch(patch)),
  )
  ipcMain.handle('downloads:auth:get', (_, provider: unknown) =>
    manager.authState(assertProvider(provider)),
  )
  ipcMain.handle('downloads:credentials:save', (_, payload: unknown) => {
    manager.saveCredentials(assertCredentialsPayload(payload))
  })
  ipcMain.handle('downloads:credentials:clear', (_, provider: unknown) => {
    manager.clearCredentials(assertProvider(provider))
  })
  ipcMain.handle('downloads:har:inspect', (_, provider: unknown, paths: unknown) =>
    manager.inspectHar(assertProvider(provider), assertPathList(paths)),
  )
  ipcMain.handle('downloads:har:apply', (_, provider: unknown, previewId: unknown) => {
    manager.applyHarImport(
      assertProvider(provider),
      assertNonEmptyString(previewId, 'HAR preview id'),
    )
  })
  ipcMain.handle('downloads:tutorial:get', () => manager.getTutorialState())
  ipcMain.handle('downloads:tutorial:set', (_, patch: unknown) =>
    manager.setTutorialState(assertTutorialPatch(patch)),
  )
  ipcMain.handle('downloads:search', (_, payload: unknown) =>
    manager.search(assertSearchRequest(payload)),
  )
  ipcMain.handle('downloads:enqueue', (_, payload: unknown) =>
    manager.enqueue(assertEnqueueRequest(payload)),
  )
  ipcMain.handle('downloads:jobs', () => manager.jobs())
  ipcMain.handle('downloads:cancel', (_, jobId: unknown) =>
    manager.cancel(assertNonEmptyString(jobId, 'job id')),
  )
  ipcMain.handle('downloads:retry', (_, jobId: unknown) =>
    manager.retry(assertNonEmptyString(jobId, 'job id')),
  )
}
