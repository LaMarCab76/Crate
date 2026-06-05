import { ipcMain } from 'electron'
import { getOneDriveAuth } from '../cloud/OneDriveAuth'
import { getOneDriveCredentialStore } from '../cloud/OneDriveCredentialStore'
import { getOneDriveClient, type DriveItem } from '../cloud/OneDriveClient'
import { getOneDriveLibraryService } from '../cloud/OneDriveLibraryService'
import { broadcast } from './events'
import { assertId, assertNonEmptyString } from './validation'
import type {
  CloudAccountStatus,
  CloudMoveDisposition,
  CloudPrefs,
  RemoteFolderEntry,
} from '@shared/types/cloud'

async function buildStatus(): Promise<CloudAccountStatus> {
  const auth = getOneDriveAuth()
  const store = getOneDriveCredentialStore()
  const clientIdConfigured = auth.isClientIdConfigured()
  let connected = false
  if (clientIdConfigured) {
    try {
      connected = await auth.isConnected()
    } catch {
      connected = false
    }
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

function assertPrefsPatch(value: unknown): Partial<CloudPrefs> {
  if (!value || typeof value !== 'object') throw new Error('Invalid cloud prefs')
  const d = (value as Partial<CloudPrefs>).moveDisposition
  return {
    moveDisposition:
      d === 'trash' || d === 'keep' || d === 'delete' || d === 'ask' ? d : undefined,
  }
}

async function broadcastStatus(): Promise<CloudAccountStatus> {
  const status = await buildStatus()
  broadcast('cloud:account:changed', status)
  return status
}

function toRemoteFolderEntry(driveId: string, item: DriveItem): RemoteFolderEntry {
  // parentReference.path looks like "/drive/root:/Music"; strip the noise so the
  // picker shows a clean "/Music/<name>".
  const parentPath = item.parentReference?.path?.replace(/^.*root:/, '') ?? ''
  return {
    driveId,
    itemId: item.id,
    name: item.name ?? '(untitled)',
    remotePath: `${parentPath}/${item.name ?? ''}`.replace(/\/+/g, '/'),
    childCount: item.folder?.childCount ?? 0,
  }
}

export function registerCloudChannel(): void {
  const auth = getOneDriveAuth()
  const store = getOneDriveCredentialStore()

  ipcMain.handle('cloud:account:status', () => buildStatus())

  ipcMain.handle('cloud:account:connect', async () => {
    await auth.connect()
    return broadcastStatus()
  })

  ipcMain.handle('cloud:account:disconnect', async () => {
    await auth.disconnect()
    return broadcastStatus()
  })

  ipcMain.handle('cloud:account:setClientId', async (_, clientId: unknown) => {
    store.setClientId(assertNonEmptyString(clientId, 'client id'))
    return broadcastStatus()
  })

  ipcMain.handle('cloud:prefs:get', () => store.getPrefs())
  ipcMain.handle('cloud:prefs:set', (_, patch: unknown) => store.setPrefs(assertPrefsPatch(patch)))

  ipcMain.handle('cloud:folders:listRemote', async (_, driveId: unknown, itemId: unknown) => {
    const client = getOneDriveClient()
    const d = typeof driveId === 'string' && driveId.trim() ? driveId : null
    const i = typeof itemId === 'string' && itemId.trim() ? itemId : null
    const effectiveDrive = d ?? (await client.getDefaultDriveId())
    const items = await client.listChildFolders(effectiveDrive, i)
    return items.map(item => toRemoteFolderEntry(effectiveDrive, item))
  })

  ipcMain.handle('cloud:folders:add', (_, driveId: unknown, itemId: unknown, name: unknown) =>
    getOneDriveLibraryService().addCloudFolder(
      assertNonEmptyString(driveId, 'drive id'),
      assertNonEmptyString(itemId, 'item id'),
      assertNonEmptyString(name, 'folder name'),
    ),
  )

  ipcMain.handle('cloud:folders:sync', (_, folderId: unknown) =>
    getOneDriveLibraryService().resyncFolder(assertId(folderId, 'folder id')),
  )

  ipcMain.handle('cloud:track:moveToCloud', (_, req: unknown) => {
    const { trackId, targetFolderId, disposition } = assertMoveRequest(req)
    return getOneDriveLibraryService().moveTrackToCloud(trackId, targetFolderId, disposition)
  })
}

function assertMoveRequest(value: unknown): {
  trackId: number
  targetFolderId: number
  disposition?: CloudMoveDisposition
} {
  if (!value || typeof value !== 'object') throw new Error('Invalid move request')
  const req = value as { trackId?: unknown; targetFolderId?: unknown; disposition?: unknown }
  const d = req.disposition
  return {
    trackId: assertId(req.trackId, 'track id'),
    targetFolderId: assertId(req.targetFolderId, 'target folder id'),
    disposition:
      d === 'trash' || d === 'keep' || d === 'delete' || d === 'ask' ? d : undefined,
  }
}
