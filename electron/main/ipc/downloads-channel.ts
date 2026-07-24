import { secureIpcMain as ipcMain } from './secureIpc'
import { BrowserWindow } from 'electron'
import { getDownloadManager } from '../downloads/DownloadManager'
import { getRepos } from '../db/repositories'
import { getLocalFileAccessService } from '../security/localFileAccessRuntime'
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
  const provider = assertProvider(payload.provider)
  const credential = (field: unknown, label: string, max = 16_384): string | undefined => {
    if (field == null || field === '') return undefined
    if (typeof field !== 'string' || field.trim().length === 0 || field.length > max) {
      throw new Error(`Invalid ${label}`)
    }
    return field.trim()
  }
  if (provider === 'qobuz') {
    const qobuz = payload as Extract<ProviderCredentialsPayload, { provider: 'qobuz' }>
    return {
      provider,
      appId: credential(qobuz.appId, 'Qobuz app id'),
      appSecret: credential(qobuz.appSecret, 'Qobuz app secret'),
      userAuthToken: credential(qobuz.userAuthToken, 'Qobuz user token'),
      source: 'manual',
      importedAt: Date.now(),
    }
  }
  const tidal = payload as Extract<ProviderCredentialsPayload, { provider: 'tidal' }>
  const countryCode = credential(tidal.countryCode, 'TIDAL country code', 2)
  if (countryCode && !/^[A-Za-z]{2}$/.test(countryCode)) throw new Error('Invalid TIDAL country code')
  return {
    provider,
    clientId: credential(tidal.clientId, 'TIDAL client id'),
    clientSecret: credential(tidal.clientSecret, 'TIDAL client secret'),
    accessToken: credential(tidal.accessToken, 'TIDAL access token'),
    refreshToken: credential(tidal.refreshToken, 'TIDAL refresh token'),
    webToken: credential(tidal.webToken, 'TIDAL web token'),
    countryCode: countryCode?.toUpperCase(),
    source: 'manual',
    importedAt: Date.now(),
  }
}

function assertPathList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Invalid HAR file list')
  if (value.length > 8) throw new Error('Too many HAR files')
  return value.map(path => {
    const result = assertNonEmptyString(path, 'HAR file path')
    if (result.length > 4096) throw new Error('HAR file path is too long')
    return result
  })
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
  const query = assertNonEmptyString(payload.query, 'search query')
  if (query.length > 500) throw new Error('Search query is too long')
  return {
    provider: assertProvider(payload.provider),
    query,
    limit: typeof payload.limit === 'number' ? Math.max(1, Math.min(50, Math.round(payload.limit))) : undefined,
  }
}

function assertEnqueueRequest(value: unknown): EnqueueDownloadRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid enqueue request')
  const payload = value as EnqueueDownloadRequest
  if (!Array.isArray(payload.providerTrackIds)) throw new Error('Invalid provider track ids')
  if (payload.providerTrackIds.length === 0 || payload.providerTrackIds.length > 100) {
    throw new Error('Invalid provider track id count')
  }
  return {
    provider: assertProvider(payload.provider),
    providerTrackIds: payload.providerTrackIds.map(id => {
      const trackId = assertNonEmptyString(id, 'provider track id')
      if (trackId.length > 256) throw new Error('Provider track id is too long')
      return trackId
    }),
    folderId: payload.folderId == null ? null : assertId(payload.folderId, 'folder id'),
    quality: assertQuality(payload.quality),
  }
}

export function registerDownloadsChannel(): void {
  const manager = getDownloadManager()
  const repos = getRepos()

  const withDownloadDestination = async <T>(
    event: Electron.IpcMainInvokeEvent,
    folderId: number | null,
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (folderId == null) return operation()
    const folder = repos.folders.getById(folderId)
    if (!folder || folder.provider !== 'local' || folder.role !== 'library') {
      throw new Error('La biblioteca de descargas ya no está disponible.')
    }
    return getLocalFileAccessService().runWithAccess(folder.path, 'write', operation, {
      owner: BrowserWindow.fromWebContents(event.sender) ?? undefined,
      retryOnce: false,
    })
  }

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
  ipcMain.handle('downloads:enqueue', (event, payload: unknown) => {
    const request = assertEnqueueRequest(payload)
    const folderId = request.folderId ?? manager.getSettings().folderId
    return withDownloadDestination(event, folderId, () => manager.enqueue(request))
  })
  ipcMain.handle('downloads:jobs', () => manager.jobs())
  ipcMain.handle('downloads:cancel', (_, jobId: unknown) =>
    manager.cancel(assertNonEmptyString(jobId, 'job id')),
  )
  ipcMain.handle('downloads:retry', (event, jobId: unknown) => {
    const id = assertNonEmptyString(jobId, 'job id')
    const job = manager.jobs().find(item => item.id === id)
    return withDownloadDestination(event, job?.folderId ?? null, () => manager.retry(id))
  })
}
