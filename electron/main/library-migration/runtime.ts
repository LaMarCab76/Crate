import { shell } from 'electron'
import type { DbFolder, DbLibraryMigrationRun } from '@shared/types/db'
import { getCloudManifestService } from '../cloud/CloudManifestService'
import { getOneDriveClient } from '../cloud/OneDriveClient'
import { getOneDriveLibraryService } from '../cloud/OneDriveLibraryService'
import { getDatabase } from '../db/database'
import { getRepos } from '../db/repositories'
import { broadcast } from '../ipc/events'
import { getFolderWatcher } from '../library/FolderWatcher'
import { getImportService } from '../library/ImportService'
import { getLibraryReconciler } from '../library/LibraryReconciler'
import { LocalMirrorAdapter } from '../library-mirror/LocalMirrorAdapter'
import { OneDriveMirrorAdapter } from '../library-mirror/OneDriveMirrorAdapter'
import { getLibraryMirrorService } from '../library-mirror/runtime'
import { getLyricsIndexService } from '../lyrics/LyricsIndexService'
import { getLibraryBackup } from '../services/LibraryBackup'
import { LibraryMigrationService } from './LibraryMigrationService'

let service: LibraryMigrationService | null = null

async function suspendLocations(folders: readonly DbFolder[]): Promise<void> {
  const cloud = getOneDriveLibraryService()
  for (const folder of folders) {
    getFolderWatcher().stop(folder.id)
    getLibraryBackup().cancelForFolder(folder.id)
    getLyricsIndexService().cancelForFolder(folder.id)
    await getCloudManifestService().cancelAndWaitForFolder(folder.id)
    await cloud.waitForFolderIdle(folder.id)
    await getLibraryReconciler().waitForFolderIdle(folder.id)
    await getImportService().waitForFolderIdle(folder.id)
    await getLibraryMirrorService().waitForLocationIdle(folder.id)
  }
}

async function restoreLocations(folderIds: readonly number[]): Promise<void> {
  for (const folderId of folderIds) {
    const folder = getRepos().folders.getById(folderId)
    if (!folder) continue
    if (folder.provider === 'local') getFolderWatcher().start(folder.id, folder.path)
  }
}

async function afterCommit(run: DbLibraryMigrationRun, resultingFolderId: number): Promise<void> {
  const folder = getRepos().folders.getById(resultingFolderId)
  if (!folder) return
  broadcast('library:changed', { reason: 'library-migration', folderId: resultingFolderId })
  if (folder.role === 'backup') {
    void getLibraryMirrorService().sync(folder.id, { trigger: 'manual' }).catch(error => {
      console.warn(`[library-migration] backup ${folder.id} post-migration sync failed:`, (error as Error).message)
    })
    return
  }
  if (folder.provider === 'local') {
    getLibraryReconciler().scheduleFolderScan(folder.id, 'import', 0)
    getLibraryBackup().scheduleWriteForFolder(folder.id)
    getLyricsIndexService().scheduleWriteForFolder(folder.id)
  } else {
    void getOneDriveLibraryService().resyncFolder(folder.id).catch(error => {
      console.warn(`[library-migration] cloud ${folder.id} post-migration sync failed:`, (error as Error).message)
    })
    getCloudManifestService().scheduleWriteForFolder(folder.id)
  }
  const unified = getRepos().folders.getBackupForSource(folder.id)
  if (unified) {
    void getLibraryMirrorService().sync(unified.id, { trigger: 'manual' }).catch(error => {
      console.warn(`[library-migration] unified backup ${unified.id} sync failed:`, (error as Error).message)
    })
  }
  void run
}

export function getLibraryMigrationService(): LibraryMigrationService {
  service ??= new LibraryMigrationService({
    db: getDatabase(),
    adapters: [new LocalMirrorAdapter(), new OneDriveMirrorAdapter()],
    oneDriveClient: getOneDriveClient(),
    trashLocalRoot: path => shell.trashItem(path),
    suspendLocations,
    restoreLocations,
    onCommitted: afterCommit,
  })
  return service
}

export async function stopLibraryMigrationRuntime(): Promise<void> {
  if (service) await service.dispose()
  service = null
}
