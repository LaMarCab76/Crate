import chokidar, { type FSWatcher } from 'chokidar'
import { getRepos } from '../db/repositories'
import { getLibraryReconciler } from './LibraryReconciler'
import { isAudioPath } from './ImportService'
import { scheduleMirrorForBackupDestination, scheduleMirrorsForSource } from '../library-mirror/runtime'
import { isLibraryLocationMigrationLocked } from '../library-migration/locationLocks'

export class FolderWatcher {
  private watchers = new Map<number, FSWatcher>()

  startAll(): void {
    const repos = getRepos()
    for (const folder of repos.folders.listAll()) {
      if (folder.provider !== 'local') continue
      this.start(folder.id, folder.path)
    }
  }

  start(folderId: number, folderPath: string): void {
    if (this.watchers.has(folderId)) return
    if (isLibraryLocationMigrationLocked(folderId)) return
    const folder = getRepos().folders.getById(folderId)
    if (!folder || folder.provider !== 'local' || folder.path !== folderPath) return
    const watcher = chokidar.watch(folderPath, {
      ignoreInitial: true,
      persistent: true,
      depth: 99,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
    })

    watcher.on('add', path => {
      this.scheduleChange(folderId, isAudioPath(path))
    })
    watcher.on('change', path => {
      this.scheduleChange(folderId, isAudioPath(path))
    })
    watcher.on('unlink', path => {
      this.scheduleChange(folderId, isAudioPath(path))
    })
    watcher.on('addDir', () => this.scheduleChange(folderId, false))
    watcher.on('unlinkDir', () => {
      this.scheduleChange(folderId, true)
    })
    watcher.on('error', err => {
      console.warn(`[watcher] folder ${folderId} error:`, err)
    })

    this.watchers.set(folderId, watcher)
  }

  stop(folderId: number): void {
    const w = this.watchers.get(folderId)
    if (w) {
      w.close()
      this.watchers.delete(folderId)
    }
  }

  stopAll(): void {
    for (const id of [...this.watchers.keys()]) this.stop(id)
  }

  private scheduleScan(folderId: number): void {
    getLibraryReconciler().scheduleFolderScan(folderId, 'watch')
  }

  private scheduleChange(folderId: number, mayAffectCatalog: boolean): void {
    if (isLibraryLocationMigrationLocked(folderId)) return
    const folder = getRepos().folders.getById(folderId)
    if (!folder || folder.provider !== 'local') return
    if (folder.role === 'library') {
      if (mayAffectCatalog) this.scheduleScan(folderId)
      scheduleMirrorsForSource(folderId, 'source_change')
      return
    }
    scheduleMirrorForBackupDestination(folderId, 'source_change')
  }
}

let instance: FolderWatcher | null = null
export function getFolderWatcher(): FolderWatcher {
  if (!instance) instance = new FolderWatcher()
  return instance
}
