import { BrowserWindow, dialog } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { DbFolder, DbLibraryMirrorAction, DbLibraryMirrorRun } from '@shared/types/db'
import type {
  AddLocalLibraryLocationRequest,
  AddOneDriveLibraryLocationRequest,
  BackupDiffEntry,
  BackupPlanDetails,
  LibraryBackupStatePayload,
  PickFolderResult,
} from '@shared/types/ipc-contract'
import type { BackupProgressPhase, LibraryLocation, LibraryRole } from '@shared/types/library-locations'
import { getOneDriveAuth } from '../cloud/OneDriveAuth'
import { getOneDriveClient } from '../cloud/OneDriveClient'
import { getOneDriveLibraryService } from '../cloud/OneDriveLibraryService'
import { getCloudManifestService } from '../cloud/CloudManifestService'
import { driveItemRemotePath } from '../cloud/cloudMetadata'
import { getDatabase } from '../db/database'
import { getRepos } from '../db/repositories'
import { toLibraryLocation } from '../db/repositories/FolderRepo'
import { getFolderWatcher } from '../library/FolderWatcher'
import { getImportService } from '../library/ImportService'
import { getLibraryReconciler } from '../library/LibraryReconciler'
import { canonicalLibraryRoot } from '../library/libraryRootGuards'
import { getLibraryMirrorService } from '../library-mirror/runtime'
import { assertLibraryLocationMigrationUnlocked } from '../library-migration/locationLocks'
import { getLyricsIndexService } from '../lyrics/LyricsIndexService'
import { getPathAuthorizationService } from '../security/PathAuthorizationService'
import { getLibraryBackup } from '../services/LibraryBackup'
import { broadcast } from './events'
import { secureIpcMain as ipcMain } from './secureIpc'
import { assertId, assertNonEmptyString } from './validation'

let removeProgressListener: (() => void) | null = null

function role(value: unknown): LibraryRole {
  if (value !== 'library' && value !== 'backup') throw new Error('Invalid library location role.')
  return value
}

function optionalSource(value: unknown, required: boolean): number | null {
  if (value == null && !required) return null
  return assertId(value, 'backup source folder id')
}

function localRequest(value: unknown): Required<Pick<AddLocalLibraryLocationRequest, 'token' | 'role'>> & {
  backupSourceFolderId: number | null
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid local library request.')
  const input = value as Record<string, unknown>
  const inputRole = role(input.role)
  return {
    token: assertNonEmptyString(input.token, 'folder authorization'),
    role: inputRole,
    backupSourceFolderId: optionalSource(input.backupSourceFolderId, inputRole === 'backup'),
  }
}

function oneDriveRequest(value: unknown): AddOneDriveLibraryLocationRequest & {
  role: LibraryRole
  backupSourceFolderId: number | null
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid OneDrive library request.')
  const input = value as Record<string, unknown>
  const inputRole = role(input.role)
  return {
    driveId: assertNonEmptyString(input.driveId, 'drive id'),
    itemId: assertNonEmptyString(input.itemId, 'item id'),
    name: assertNonEmptyString(input.name, 'folder name'),
    remotePath: typeof input.remotePath === 'string' ? input.remotePath : undefined,
    role: inputRole,
    backupSourceFolderId: optionalSource(input.backupSourceFolderId, inputRole === 'backup'),
  }
}

async function confirmReclassification(event: Electron.IpcMainInvokeEvent, folder: DbFolder): Promise<void> {
  if (folder.role !== 'library') return
  if (!getRepos().folders.hasTracks(folder.id)) return
  const window = BrowserWindow.fromWebContents(event.sender)
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Usar biblioteca como backup',
    message: `¿Convertir “${folder.name}” en backup?`,
    detail: 'Se quitará del catálogo, pero sus archivos no se modificarán. Si el destino tiene contenido propio, Crate pausará el primer lote para revisarlo.',
    buttons: ['Cancelar', 'Convertir en backup'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  if (result.response !== 1) throw new Error('La conversión a backup fue cancelada.')
}

function locationPayload(folder: DbFolder): LibraryLocation & { available: boolean } {
  return {
    ...toLibraryLocation(folder),
    available: folder.provider === 'onedrive' || existsSync(folder.path),
  }
}

/**
 * Stop producers that can still publish catalog or portable-state work for a
 * location. Cloud writes are awaited before the role change so an in-flight
 * manifest cannot race the reclassification transaction.
 */
async function quiesceLibraryLocation(folder: DbFolder): Promise<void> {
  getFolderWatcher().stop(folder.id)
  getLibraryBackup().cancelForFolder(folder.id)
  getLyricsIndexService().cancelForFolder(folder.id)
  const cloudManifest = getCloudManifestService()
  if (folder.provider === 'onedrive') {
    await cloudManifest.cancelAndWaitForFolder(folder.id)
  } else {
    cloudManifest.cancelForFolder(folder.id)
  }
}

function startLocationWatcher(folder: DbFolder): void {
  if (folder.provider === 'local') getFolderWatcher().start(folder.id, folder.path)
}

function restoreLibraryLocation(folderId: number): void {
  const folder = getRepos().folders.getById(folderId)
  if (!folder || folder.role !== 'library') return
  startLocationWatcher(folder)
  if (folder.provider === 'local') {
    getLibraryBackup().scheduleWriteForFolder(folder.id)
    getLyricsIndexService().scheduleWriteForFolder(folder.id)
  } else {
    getCloudManifestService().scheduleWriteForFolder(folder.id)
  }
}

async function reclassifyExistingBackup(
  event: Electron.IpcMainInvokeEvent,
  sourceFolderId: number,
  destination: DbFolder,
): Promise<DbFolder> {
  const folders = getRepos().folders
  // Validate before asking for confirmation or stopping any services. The
  // repository repeats the validation in the assignment transaction.
  folders.validateBackupAssignment(sourceFolderId, destination.id)
  await confirmReclassification(event, destination)
  try {
    await quiesceLibraryLocation(destination)
    const assigned = folders.assignBackup(sourceFolderId, destination.id)
    startLocationWatcher(assigned)
    return assigned
  } catch (error) {
    restoreLibraryLocation(destination.id)
    throw error
  }
}

function beginMirror(backupFolderId: number, trigger: 'link' | 'manual' | 'resume'): void {
  void getLibraryMirrorService().sync(backupFolderId, { trigger }).catch(error => {
    console.warn(`[library-mirror] ${trigger} failed for ${backupFolderId}:`, (error as Error).message)
  })
}

function beginResume(runId: string): void {
  void getLibraryMirrorService().resume(runId).catch(error => {
    console.warn(`[library-mirror] resume failed for ${runId}:`, (error as Error).message)
  })
}

function beginApproval(runId: string): void {
  void getLibraryMirrorService().approve(runId).catch(error => {
    console.warn(`[library-mirror] approved run ${runId} failed:`, (error as Error).message)
  })
}

function latestRun(backupFolderId: number): DbLibraryMirrorRun | undefined {
  return getDatabase().prepare<[number], DbLibraryMirrorRun>(`
    SELECT * FROM library_mirror_runs WHERE backup_folder_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(backupFolderId)
}

function runActions(runId: string): DbLibraryMirrorAction[] {
  return getDatabase().prepare<[string], DbLibraryMirrorAction>(`
    SELECT * FROM library_mirror_actions WHERE run_id = ? ORDER BY ordinal ASC
  `).all(runId)
}

function actionEntry(action: DbLibraryMirrorAction): BackupDiffEntry {
  let hasDestination = false
  try {
    const payload = action.entry_json ? JSON.parse(action.entry_json) as { destinationBefore?: unknown } : null
    hasDestination = payload?.destinationBefore != null
  } catch { /* malformed journal data is surfaced by the run, not IPC */ }
  return {
    path: action.relative_path,
    action: action.kind.startsWith('delete_') ? 'delete' : hasDestination ? 'update' : 'create',
    reason: null,
  }
}

function phaseForRun(run: DbLibraryMirrorRun, actions: readonly DbLibraryMirrorAction[]): BackupProgressPhase | null {
  if (run.status === 'planning' || run.status === 'pending') return 'planning'
  if (run.status === 'awaiting_approval') return 'awaiting_approval'
  if (run.status === 'paused') return 'paused'
  if (run.status === 'completed') return 'done'
  if (run.status === 'failed' || run.status === 'cancelled') return 'error'
  const current = actions.find(action => action.status === 'running')
    ?? actions.find(action => action.status === 'pending')
  if (!current) return 'verifying'
  if (current.kind === 'create_directory') return 'creating_directories'
  if (current.kind === 'copy_file') return 'copying'
  return 'deleting'
}

function backupState(backup: DbFolder): LibraryBackupStatePayload {
  if (backup.role !== 'backup' || backup.backup_source_folder_id == null) {
    throw new Error(`Folder ${backup.id} is not a backup.`)
  }
  const mirror = getLibraryMirrorService()
  const run = latestRun(backup.id)
  if (!run) {
    return {
      backupFolderId: backup.id,
      sourceFolderId: backup.backup_source_folder_id,
      runId: null,
      status: 'idle',
      phase: null,
      completedActions: 0,
      totalActions: 0,
      completedBytes: 0,
      totalBytes: null,
      relativePath: null,
      message: null,
      error: null,
      lastRunAt: null,
      plan: null,
    }
  }
  const actions = runActions(run.id)
  const summary = mirror.getRunSummary(run.id)
  const divergences = mirror.getDivergences(run.id)
  const entries: BackupDiffEntry[] = [
    ...actions.map(actionEntry),
    ...divergences.map(divergence => ({
      path: divergence.relativePath,
      action: 'conflict' as const,
      reason: divergence.reason,
    })),
  ]
  const plan: BackupPlanDetails | null = summary ? { ...summary, entries } : null
  const current = actions.find(action => action.status === 'running')
    ?? (run.status === 'running' ? actions.find(action => action.status === 'pending') : undefined)
  return {
    backupFolderId: backup.id,
    sourceFolderId: backup.backup_source_folder_id,
    runId: run.id,
    status: run.status,
    phase: phaseForRun(run, actions),
    completedActions: actions.filter(action => action.status === 'completed').length,
    totalActions: actions.length,
    completedBytes: actions.reduce((sum, action) => sum + action.bytes_completed, 0),
    totalBytes: actions.reduce((sum, action) => sum + action.bytes_total, 0),
    relativePath: current?.relative_path ?? null,
    message: null,
    error: run.error,
    lastRunAt: run.completed_at ?? run.updated_at,
    plan,
  }
}

async function indexPromoted(folder: DbFolder): Promise<void> {
  if (folder.provider === 'local') {
    getFolderWatcher().start(folder.id, folder.path)
    void getImportService().scan(folder.id, folder.path).catch(error => {
      console.error(`[library] promoted folder ${folder.id} import failed:`, error)
    })
  } else {
    void getOneDriveLibraryService().resyncFolder(folder.id).catch(error => {
      console.error(`[cloud] promoted folder ${folder.id} import failed:`, error)
    })
  }
  broadcast('library:changed', { reason: 'backup-promoted', folderId: folder.id })
}

export function registerLibraryLocationsChannel(): void {
  const repos = getRepos()
  const mirror = getLibraryMirrorService()
  removeProgressListener?.()
  removeProgressListener = mirror.onProgress(event => broadcast('library-backups:progress', event))

  ipcMain.handle('library-locations:list', () => repos.folders.listAll().map(locationPayload))

  ipcMain.handle('library-locations:pick-local', async (): Promise<PickFolderResult> => {
    const result = await dialog.showOpenDialog({
      title: 'Elegir ubicación de biblioteca',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, token: null, displayPath: null }
    }
    const displayPath = resolve(result.filePaths[0])
    const token = getPathAuthorizationService().issue(displayPath, ['library:location'])
    return { canceled: false, token, displayPath }
  })

  ipcMain.handle('library-locations:add-local', async (event, value: unknown) => {
    const request = localRequest(value)
    const folderPath = getPathAuthorizationService().resolve(
      request.token,
      'library:location',
      { consume: true },
    )
    if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
      throw new Error('La carpeta elegida no está disponible.')
    }
    const canonicalPath = await canonicalLibraryRoot(folderPath)
    if (request.role === 'backup') {
      const existing = repos.folders.getByPath(canonicalPath)
      const assigned = existing
        ? await reclassifyExistingBackup(event, request.backupSourceFolderId!, existing)
        : repos.folders.addLocalBackup(
          request.backupSourceFolderId!,
          canonicalPath,
          basename(canonicalPath) || canonicalPath,
        )
      startLocationWatcher(assigned)
      beginMirror(assigned.id, 'link')
      broadcast('library:changed', { reason: 'backup-assigned', folderId: assigned.id })
      return locationPayload(assigned)
    }
    const result = await getImportService().addFolder(canonicalPath)
    getFolderWatcher().start(result.folder.id, result.folder.path)
    getLibraryReconciler().scheduleFolderScan(result.folder.id, 'import', 0)
    broadcast('library:changed', { reason: 'folder-add', folderId: result.folder.id })
    return locationPayload(result.folder)
  })

  ipcMain.handle('library-locations:add-onedrive', async (event, value: unknown) => {
    const request = oneDriveRequest(value)
    const account = await getOneDriveAuth().getAccount()
    if (!account) throw new Error('Conectá OneDrive antes de agregar una biblioteca cloud.')
    const item = await getOneDriveClient().getItem(request.driveId, request.itemId)
    if (!item.folder) throw new Error('La ubicación elegida en OneDrive no es una carpeta.')
    const trustedName = item.name?.trim() || request.name
    const trustedRemotePath = driveItemRemotePath(item)

    if (request.role === 'library') {
      const ref = await getOneDriveLibraryService().addCloudFolder(
        request.driveId,
        request.itemId,
        trustedName,
        { accountId: account.homeAccountId, remotePath: trustedRemotePath },
      )
      return locationPayload(repos.folders.getById(ref.folderId)!)
    }

    const stablePath = `onedrive://${request.driveId}/${request.itemId}`
    const existing = repos.folders.getByPath(stablePath)
    const assigned = existing
      ? await reclassifyExistingBackup(event, request.backupSourceFolderId!, existing)
      : repos.folders.addOneDriveBackup(request.backupSourceFolderId!, {
        accountId: account.homeAccountId,
        driveId: request.driveId,
        itemId: request.itemId,
        name: trustedName,
        remotePath: trustedRemotePath,
      })
    beginMirror(assigned.id, 'link')
    broadcast('library:changed', { reason: 'backup-assigned', folderId: assigned.id })
    return locationPayload(assigned)
  })

  ipcMain.handle('library-locations:update-presentation', (_event, rawId: unknown, value: unknown) => {
    const folderId = assertId(rawId, 'folder id')
    assertLibraryLocationMigrationUnlocked(folderId, 'la edición de su presentación')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid presentation update.')
    const input = value as Record<string, unknown>
    const name = assertNonEmptyString(input.name, 'location name')
    const displayIcon = input.displayIcon == null
      ? null
      : assertNonEmptyString(input.displayIcon, 'location icon')
    return locationPayload(repos.folders.updatePresentation(folderId, { name, displayIcon }))
  })

  ipcMain.handle('library-locations:remove', (_event, value: unknown) => {
    const folderId = assertId(value, 'folder id')
    const folder = repos.folders.getById(folderId)
    if (!folder) return
    if (folder.role === 'backup') throw new Error('Desvinculá el backup antes de quitar esta ubicación.')
    getFolderWatcher().stop(folderId)
    getLibraryBackup().cancelForFolder(folderId)
    getCloudManifestService().cancelForFolder(folderId)
    repos.folders.remove(folderId)
    broadcast('library:changed', { reason: 'folder-remove', folderId })
  })

  ipcMain.handle('library-backups:list', () => mirror.listBackups().map(backupState))

  ipcMain.handle('library-backups:assign', async (event, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid backup assignment.')
    const input = value as Record<string, unknown>
    const sourceFolderId = assertId(input.sourceFolderId, 'source folder id')
    const backupFolderId = assertId(input.backupFolderId, 'backup folder id')
    const destination = repos.folders.getById(backupFolderId)
    if (!destination) throw new Error('La ubicación de backup no existe.')
    const assigned = await reclassifyExistingBackup(event, sourceFolderId, destination)
    beginMirror(assigned.id, 'link')
    broadcast('library:changed', { reason: 'backup-assigned', folderId: assigned.id })
    return backupState(assigned)
  })

  ipcMain.handle('library-backups:remove', async (_event, value: unknown) => {
    const backupFolderId = assertId(value, 'backup folder id')
    const folder = await mirror.unlinkBackup(backupFolderId)
    await indexPromoted(folder)
  })

  ipcMain.handle('library-backups:promote', async (_event, value: unknown) => {
    const backupFolderId = assertId(value, 'backup folder id')
    const folder = await mirror.promoteBackup(backupFolderId)
    await indexPromoted(folder)
    return locationPayload(folder)
  })

  ipcMain.handle('library-backups:start', (_event, value: unknown) => {
    const backupFolderId = assertId(value, 'backup folder id')
    const backup = repos.folders.getById(backupFolderId)
    if (!backup) throw new Error('El backup no existe.')
    beginMirror(backupFolderId, 'manual')
    return backupState(backup)
  })

  ipcMain.handle('library-backups:pause', (_event, value: unknown) => {
    const backupFolderId = assertId(value, 'backup folder id')
    const backup = repos.folders.getById(backupFolderId)
    const run = latestRun(backupFolderId)
    if (!backup || !run) throw new Error('No hay una ejecución activa para pausar.')
    mirror.pause(run.id)
    return backupState(backup)
  })

  ipcMain.handle('library-backups:resume', (_event, value: unknown) => {
    const backupFolderId = assertId(value, 'backup folder id')
    const backup = repos.folders.getById(backupFolderId)
    const run = latestRun(backupFolderId)
    if (!backup || !run || (run.status !== 'paused' && run.status !== 'failed')) {
      throw new Error('No hay una ejecución pausada o fallida recuperable para reanudar.')
    }
    beginResume(run.id)
    return backupState(backup)
  })

  ipcMain.handle('library-backups:approve-diff', (_event, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid approval request.')
    const input = value as Record<string, unknown>
    const backupFolderId = assertId(input.backupFolderId, 'backup folder id')
    const runId = assertNonEmptyString(input.runId, 'run id')
    const run = mirror.getRun(runId)
    const backup = repos.folders.getById(backupFolderId)
    if (!run || run.backup_folder_id !== backupFolderId || !backup) throw new Error('El lote no pertenece a este backup.')
    beginApproval(runId)
    return backupState(backup)
  })
}

export function disposeLibraryLocationsChannel(): void {
  removeProgressListener?.()
  removeProgressListener = null
}
