import { secureIpcMain as ipcMain } from './secureIpc'
import { BrowserWindow } from 'electron'
import type {
  AddCloudFolderRequest,
  CloudAccountStatus,
  CloudMoveDisposition,
  CloudPrefs,
  ListRemoteFoldersRequest,
  MoveToCloudRequest,
  RemoteFolderEntry,
} from '@shared/types/cloud'
import { getOneDriveAuth } from '../cloud/OneDriveAuth'
import { getOneDriveClient, type DriveItem } from '../cloud/OneDriveClient'
import { getOneDriveCredentialStore } from '../cloud/OneDriveCredentialStore'
import { getOneDriveLibraryService } from '../cloud/OneDriveLibraryService'
import { driveItemRemotePath } from '../cloud/cloudMetadata'
import { broadcast } from './events'
import { assertId, assertNonEmptyString } from './validation'
import { getRepos } from '../db/repositories'
import { getLocalFileAccessService } from '../security/localFileAccessRuntime'

async function accountStatus(): Promise<CloudAccountStatus> {
  const auth = getOneDriveAuth()
  const store = getOneDriveCredentialStore()
  const clientIdConfigured = auth.isClientIdConfigured()
  let connected = false
  if (clientIdConfigured) {
    try { connected = await auth.isConnected() } catch { connected = false }
  }
  const account = store.getAccount()
  return {
    provider: 'onedrive',
    connected,
    displayName: account?.displayName ?? null,
    email: account?.email ?? null,
    clientIdConfigured,
  }
}

async function broadcastAccountStatus(): Promise<CloudAccountStatus> {
  const status = await accountStatus()
  broadcast('cloud:account:changed', status)
  return status
}

function prefsPatch(value: unknown): Partial<CloudPrefs> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid OneDrive preferences.')
  }
  const disposition = (value as { moveDisposition?: unknown }).moveDisposition
  if (disposition === undefined) return {}
  if (
    disposition !== 'trash' &&
    disposition !== 'keep' &&
    disposition !== 'delete' &&
    disposition !== 'ask'
  ) throw new Error('Invalid OneDrive move disposition.')
  return { moveDisposition: disposition }
}

function listRequest(value: unknown, legacyParentItemId?: unknown): ListRemoteFoldersRequest {
  // Keep the positional shape used by the existing preload while also accepting
  // the object request used by newer callers.
  if (value == null || typeof value === 'string') {
    return {
      driveId: typeof value === 'string' && value.trim() ? value.trim() : null,
      parentItemId: typeof legacyParentItemId === 'string' && legacyParentItemId.trim()
        ? legacyParentItemId.trim()
        : null,
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid remote folder request.')
  }
  const request = value as { driveId?: unknown; parentItemId?: unknown }
  return {
    driveId: typeof request.driveId === 'string' && request.driveId.trim()
      ? request.driveId.trim()
      : null,
    parentItemId: typeof request.parentItemId === 'string' && request.parentItemId.trim()
      ? request.parentItemId.trim()
      : null,
  }
}

function addRequest(
  value: unknown,
  legacyItemId?: unknown,
  legacyName?: unknown,
  legacyRemotePath?: unknown,
): AddCloudFolderRequest {
  if (typeof value === 'string') {
    return {
      driveId: assertNonEmptyString(value, 'drive id'),
      itemId: assertNonEmptyString(legacyItemId, 'item id'),
      name: typeof legacyName === 'string' && legacyName.trim() ? legacyName.trim() : undefined,
      remotePath: typeof legacyRemotePath === 'string' && legacyRemotePath.trim()
        ? legacyRemotePath.trim()
        : undefined,
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid OneDrive library request.')
  }
  const request = value as Record<string, unknown>
  return {
    driveId: assertNonEmptyString(request.driveId, 'drive id'),
    itemId: assertNonEmptyString(request.itemId, 'item id'),
    name: typeof request.name === 'string' && request.name.trim() ? request.name.trim() : undefined,
    remotePath: typeof request.remotePath === 'string' && request.remotePath.trim()
      ? request.remotePath.trim()
      : undefined,
  }
}

function moveRequest(value: unknown): MoveToCloudRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid move-to-OneDrive request.')
  }
  const request = value as { trackId?: unknown; targetFolderId?: unknown; disposition?: unknown }
  const disposition = request.disposition
  if (
    disposition !== undefined &&
    disposition !== 'trash' &&
    disposition !== 'keep' &&
    disposition !== 'delete' &&
    disposition !== 'ask'
  ) throw new Error('Invalid move disposition.')
  return {
    trackId: assertId(request.trackId, 'track id'),
    targetFolderId: assertId(request.targetFolderId, 'target folder id'),
    disposition: disposition as CloudMoveDisposition | undefined,
  }
}

function remoteFolder(driveId: string, item: DriveItem): RemoteFolderEntry {
  return {
    driveId,
    itemId: item.id,
    name: item.name ?? '(untitled)',
    remotePath: driveItemRemotePath(item),
    childCount: item.folder?.childCount ?? 0,
  }
}

export function registerCloudChannel(): void {
  const auth = getOneDriveAuth()
  const store = getOneDriveCredentialStore()

  ipcMain.handle('cloud:account:status', () => accountStatus())
  ipcMain.handle('cloud:account:connect', async () => {
    await auth.connect()
    return broadcastAccountStatus()
  })
  ipcMain.handle('cloud:account:disconnect', async () => {
    await auth.disconnect()
    return broadcastAccountStatus()
  })
  ipcMain.handle('cloud:account:setClientId', async (_event, clientId: unknown) => {
    store.setClientId(assertNonEmptyString(clientId, 'client id'))
    return broadcastAccountStatus()
  })

  ipcMain.handle('cloud:prefs:get', () => store.getPrefs())
  ipcMain.handle('cloud:prefs:set', (_event, value: unknown) => store.setPrefs(prefsPatch(value)))

  ipcMain.handle('cloud:folders:listRemote', async (
    _event,
    value: unknown,
    legacyParentItemId: unknown,
  ) => {
    const request = listRequest(value, legacyParentItemId)
    const client = getOneDriveClient()
    const driveId = request.driveId ?? await client.getDefaultDriveId()
    return (await client.listChildFolders(driveId, request.parentItemId ?? null))
      .map(item => remoteFolder(driveId, item))
  })

  ipcMain.handle('cloud:folders:add', async (
    _event,
    value: unknown,
    legacyItemId: unknown,
    legacyName: unknown,
    legacyRemotePath: unknown,
  ) => {
    const request = addRequest(value, legacyItemId, legacyName, legacyRemotePath)
    const account = await auth.getAccount()
    if (!account) throw new Error('Connect OneDrive before adding a cloud library.')
    let name = request.name
    let remotePath = request.remotePath
    if (!name || !remotePath) {
      const item = await getOneDriveClient().getItem(request.driveId, request.itemId)
      if (!item.folder) throw new Error('The selected OneDrive item is not a folder.')
      name ??= item.name ?? 'OneDrive'
      remotePath ??= driveItemRemotePath(item)
    }
    return getOneDriveLibraryService().addCloudFolder(
      request.driveId,
      request.itemId,
      name,
      { accountId: account.homeAccountId, remotePath },
    )
  })

  ipcMain.handle('cloud:folders:sync', (_event, folderId: unknown) =>
    getOneDriveLibraryService().resyncFolder(assertId(folderId, 'folder id')),
  )

  ipcMain.handle('cloud:track:moveToCloud', async (event, value: unknown) => {
    const request = moveRequest(value)
    const track = getRepos().tracks.getById(request.trackId)
    const folder = track ? getRepos().folders.getById(track.folder_id) : null
    const operation = () => getOneDriveLibraryService().moveTrackToCloud(
      request.trackId, request.targetFolderId, request.disposition,
    )
    if (track?.provider !== 'local' || folder?.provider !== 'local') return operation()
    return getLocalFileAccessService().runWithAccess(
      folder.path,
      request.disposition === 'keep' ? 'read' : 'write',
      operation,
      {
        owner: BrowserWindow.fromWebContents(event.sender) ?? undefined,
        retryOnce: false,
      },
    )
  })
}
