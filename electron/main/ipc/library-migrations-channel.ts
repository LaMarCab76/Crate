import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { BrowserWindow } from 'electron'
import type { DbFolder } from '@shared/types/db'
import type {
  CreateLibraryMigrationRequest,
  LibraryMigrationSourceDisposition,
  LibraryMigrationTarget,
  UnifiedBackupChoice,
} from '@shared/types/library-locations'
import { getOneDriveAuth } from '../cloud/OneDriveAuth'
import { getOneDriveClient } from '../cloud/OneDriveClient'
import { driveItemRemotePath } from '../cloud/cloudMetadata'
import { getRepos } from '../db/repositories'
import { canonicalLibraryRoot } from '../library/libraryRootGuards'
import {
  getLibraryMigrationService,
  type ResolvedMigrationTarget,
  type ResolvedUnifiedBackup,
} from '../library-migration'
import { getPathAuthorizationService } from '../security/PathAuthorizationService'
import { getLocalFileAccessService } from '../security/localFileAccessRuntime'
import { broadcast } from './events'
import { secureIpcMain as ipcMain } from './secureIpc'
import { assertId, assertNonEmptyString } from './validation'

let removeProgressListener: (() => void) | null = null

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`)
  return value as Record<string, unknown>
}

function mode(value: unknown): 'relocate' | 'merge' {
  if (value !== 'relocate' && value !== 'merge') throw new Error('Invalid library migration mode.')
  return value
}

function disposition(value: unknown): LibraryMigrationSourceDisposition {
  if (value !== 'keep' && value !== 'trash') throw new Error('Invalid source disposition.')
  return value
}

function localFolder(path: string, role: 'library' | 'backup', name?: string): DbFolder {
  const timestamp = new Date().toISOString()
  return {
    id: 0,
    name: name?.trim() || basename(path) || path,
    path,
    track_count: 0,
    date_added: timestamp,
    date_updated: timestamp,
    bookmark_data: null,
    provider: 'local',
    role,
    backup_source_folder_id: null,
    account_id: null,
    drive_id: null,
    item_id: null,
    remote_path: null,
    delta_cursor: null,
    display_icon: null,
  }
}

async function oneDriveFolder(
  value: { driveId: string; itemId: string; name: string },
  role: 'library' | 'backup',
): Promise<DbFolder> {
  const account = await getOneDriveAuth().getAccount()
  if (!account) throw new Error('Conectá OneDrive antes de elegir un destino cloud.')
  const item = await getOneDriveClient().getItem(value.driveId, value.itemId)
  if (!item.folder) throw new Error('El destino OneDrive debe ser una carpeta.')
  const timestamp = new Date().toISOString()
  return {
    id: 0,
    name: item.name?.trim() || value.name,
    path: `onedrive://${value.driveId}/${value.itemId}`,
    track_count: 0,
    date_added: timestamp,
    date_updated: timestamp,
    bookmark_data: null,
    provider: 'onedrive',
    role,
    backup_source_folder_id: null,
    account_id: account.homeAccountId,
    drive_id: value.driveId,
    item_id: value.itemId,
    remote_path: driveItemRemotePath(item),
    delta_cursor: null,
    display_icon: null,
  }
}

function parseCloudTarget(value: Record<string, unknown>): {
  driveId: string
  itemId: string
  name: string
} {
  return {
    driveId: assertNonEmptyString(value.driveId, 'drive id'),
    itemId: assertNonEmptyString(value.itemId, 'item id'),
    name: assertNonEmptyString(value.name, 'folder name'),
  }
}

async function resolveLocalToken(token: unknown): Promise<string> {
  const path = getPathAuthorizationService().resolve(
    assertNonEmptyString(token, 'folder authorization'),
    'library:location',
    { consume: true },
  )
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error('La carpeta elegida no está disponible.')
  return canonicalLibraryRoot(path)
}

async function resolveTarget(value: unknown): Promise<ResolvedMigrationTarget> {
  const input = object(value, 'migration target')
  if (input.kind === 'existing-library') {
    const folderId = assertId(input.folderId, 'target folder id')
    const folder = getRepos().folders.getById(folderId)
    if (!folder) throw new Error('La biblioteca destino ya no existe.')
    return { folder, existingFolderId: folderId }
  }
  if (input.kind === 'new-local') {
    return { folder: localFolder(await resolveLocalToken(input.token), 'library'), existingFolderId: null }
  }
  if (input.kind === 'new-onedrive') {
    return { folder: await oneDriveFolder(parseCloudTarget(input), 'library'), existingFolderId: null }
  }
  throw new Error('Invalid library migration target.')
}

async function resolveUnifiedBackup(value: unknown): Promise<ResolvedUnifiedBackup> {
  if (value == null) return { kind: 'none' }
  const input = object(value, 'unified backup choice')
  if (input.kind === 'none') return { kind: 'none' }
  if (input.kind === 'existing') return { kind: 'existing', folderId: assertId(input.folderId, 'backup folder id') }
  if (input.kind === 'new-local') {
    return { kind: 'new', folder: localFolder(await resolveLocalToken(input.token), 'backup') }
  }
  if (input.kind === 'new-onedrive') {
    return { kind: 'new', folder: await oneDriveFolder(parseCloudTarget(input), 'backup') }
  }
  throw new Error('Invalid unified backup choice.')
}

async function request(value: unknown): Promise<{
  sourceFolderId: number
  mode: 'relocate' | 'merge'
  target: ResolvedMigrationTarget
  sourceDisposition: LibraryMigrationSourceDisposition
  unifiedBackup: ResolvedUnifiedBackup
  targetDisplayName?: string
}> {
  const input = object(value, 'library migration request')
  const targetDisplayName = input.targetDisplayName == null
    ? undefined
    : assertNonEmptyString(input.targetDisplayName, 'target display name')
  return {
    sourceFolderId: assertId(input.sourceFolderId, 'source folder id'),
    mode: mode(input.mode),
    target: await resolveTarget(input.target as LibraryMigrationTarget),
    sourceDisposition: disposition(input.sourceDisposition),
    unifiedBackup: await resolveUnifiedBackup(input.unifiedBackup as UnifiedBackupChoice | undefined),
    targetDisplayName,
  }
}

async function ensureMigrationPathAccess(
  event: Electron.IpcMainInvokeEvent,
  folder: DbFolder,
  accessMode: 'read' | 'write',
): Promise<void> {
  if (folder.provider !== 'local') return
  await getLocalFileAccessService().runWithAccess(folder.path, accessMode, async () => undefined, {
    owner: BrowserWindow.fromWebContents(event.sender) ?? undefined,
    retryOnce: false,
  })
}

export function registerLibraryMigrationsChannel(): void {
  const migrations = getLibraryMigrationService()
  removeProgressListener?.()
  removeProgressListener = migrations.onProgress(event => broadcast('library-migrations:progress', event))

  ipcMain.handle('library-migrations:list', () => migrations.list())
  ipcMain.handle('library-migrations:create', async (event, value: CreateLibraryMigrationRequest | unknown) => {
    const resolved = await request(value)
    const source = getRepos().folders.getById(resolved.sourceFolderId)
    if (!source) throw new Error('La biblioteca de origen ya no existe.')
    await ensureMigrationPathAccess(event, source, resolved.sourceDisposition === 'trash' ? 'write' : 'read')
    await ensureMigrationPathAccess(event, resolved.target.folder, 'write')
    if (resolved.unifiedBackup.kind === 'new') {
      await ensureMigrationPathAccess(event, resolved.unifiedBackup.folder, 'write')
    } else if (resolved.unifiedBackup.kind === 'existing') {
      const backup = getRepos().folders.getById(resolved.unifiedBackup.folderId)
      if (!backup) throw new Error('La ubicación de backup ya no existe.')
      await ensureMigrationPathAccess(event, backup, 'write')
    }
    return migrations.create(resolved)
  })
  ipcMain.handle('library-migrations:approve', async (event, value: unknown) => {
    const runId = assertNonEmptyString(value, 'migration run id')
    const run = migrations.list().find(item => item.runId === runId)
    if (!run) throw new Error('La migración ya no existe.')
    const source = getRepos().folders.getById(run.sourceFolderId)
    if (source) await ensureMigrationPathAccess(event, source, run.sourceDisposition === 'trash' ? 'write' : 'read')
    const target = run.targetFolderId == null ? null : getRepos().folders.getById(run.targetFolderId)
    if (target) await ensureMigrationPathAccess(event, target, 'write')
    return migrations.approve(runId)
  })
  ipcMain.handle('library-migrations:pause', (_event, value: unknown) => (
    migrations.pause(assertNonEmptyString(value, 'migration run id'))
  ))
  ipcMain.handle('library-migrations:resume', async (event, value: unknown) => {
    const runId = assertNonEmptyString(value, 'migration run id')
    const run = migrations.list().find(item => item.runId === runId)
    if (!run) throw new Error('La migración ya no existe.')
    const source = getRepos().folders.getById(run.sourceFolderId)
    if (source) await ensureMigrationPathAccess(event, source, run.sourceDisposition === 'trash' ? 'write' : 'read')
    const target = run.targetFolderId == null ? null : getRepos().folders.getById(run.targetFolderId)
    if (target) await ensureMigrationPathAccess(event, target, 'write')
    return migrations.resume(runId)
  })
  ipcMain.handle('library-migrations:cancel', (_event, value: unknown) => (
    migrations.cancel(assertNonEmptyString(value, 'migration run id'))
  ))
  ipcMain.handle('library-migrations:retry-cleanup', async (event, value: unknown) => {
    const runId = assertNonEmptyString(value, 'migration run id')
    const run = migrations.list().find(item => item.runId === runId)
    if (!run) throw new Error('La migración ya no existe.')
    const source = getRepos().folders.getById(run.sourceFolderId)
    if (source) await ensureMigrationPathAccess(event, source, 'write')
    return migrations.retryCleanup(runId)
  })
}

export function disposeLibraryMigrationsChannel(): void {
  removeProgressListener?.()
  removeProgressListener = null
}
