import chokidar, { type FSWatcher } from 'chokidar'
import { getRepos } from '../db/repositories'
import { getLibraryReconciler } from './LibraryReconciler'
import { isAudioPath } from './ImportService'

export class FolderWatcher {
  private watchers = new Map<number, FSWatcher>()

  startAll(): void {
    const repos = getRepos()
    for (const folder of repos.folders.list()) {
      // Cloud folders have synthetic onedrive:// paths that chokidar can't watch;
      // the OneDrive delta poller handles their change detection instead.
      if (folder.source === 'onedrive') continue
      this.start(folder.id, folder.path)
    }
  }

  start(folderId: number, folderPath: string): void {
    if (this.watchers.has(folderId)) return
    const watcher = chokidar.watch(folderPath, {
      ignoreInitial: true,
      persistent: true,
      depth: 99,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
      ignored: /(^|[\/\\])\../, // dotfiles
    })

    watcher.on('add', path => {
      if (isAudioPath(path)) this.scheduleScan(folderId)
    })
    watcher.on('change', path => {
      if (isAudioPath(path)) this.scheduleScan(folderId)
    })
    watcher.on('unlink', path => {
      if (isAudioPath(path)) this.scheduleScan(folderId)
    })
    watcher.on('unlinkDir', () => {
      this.scheduleScan(folderId)
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
}

let instance: FolderWatcher | null = null
export function getFolderWatcher(): FolderWatcher {
  if (!instance) instance = new FolderWatcher()
  return instance
}
