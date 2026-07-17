import type { BackupTrigger } from '@shared/types/library-locations'
import { getDatabase } from '../db/database'
import { getRepos } from '../db/repositories'
import { OneDriveMirrorAdapter } from './OneDriveMirrorAdapter'
import { LocalMirrorAdapter } from './LocalMirrorAdapter'
import { LibraryMirrorService } from './LibraryMirrorService'

const SOURCE_CHANGE_DEBOUNCE_MS = 1_500

interface SourceQueue {
  timer: NodeJS.Timeout | null
  pending: boolean
  running: boolean
  trigger: BackupTrigger
}

let service: LibraryMirrorService | null = null
const sourceQueues = new Map<number, SourceQueue>()
const backupQueues = new Map<number, SourceQueue>()

export function getLibraryMirrorService(): LibraryMirrorService {
  service ??= new LibraryMirrorService({
    db: getDatabase(),
    adapters: [new LocalMirrorAdapter(), new OneDriveMirrorAdapter()],
  })
  return service
}

/** Coalesces watcher/delta bursts and remembers a change that arrives during an
 * active transfer. That second pass is important: otherwise a source mutation
 * in the middle of a copy could fail the precondition and never be retried. */
export function scheduleMirrorsForSource(
  sourceFolderId: number,
  trigger: Extract<BackupTrigger, 'source_change' | 'cloud_delta'>,
  delayMs = SOURCE_CHANGE_DEBOUNCE_MS,
): void {
  let queue = sourceQueues.get(sourceFolderId)
  if (!queue) {
    queue = { timer: null, pending: false, running: false, trigger }
    sourceQueues.set(sourceFolderId, queue)
  }
  queue.pending = true
  queue.trigger = trigger
  if (queue.timer) clearTimeout(queue.timer)
  queue.timer = setTimeout(() => {
    queue!.timer = null
    void drainSourceQueue(sourceFolderId, queue!)
  }, Math.max(0, delayMs))
}

/** Destination changes are never applied in reverse. They only trigger a
 * fresh three-way comparison so independent edits become one approval batch. */
export function scheduleMirrorForBackupDestination(
  backupFolderId: number,
  trigger: Extract<BackupTrigger, 'source_change' | 'cloud_delta'>,
  delayMs = SOURCE_CHANGE_DEBOUNCE_MS,
): void {
  let queue = backupQueues.get(backupFolderId)
  if (!queue) {
    queue = { timer: null, pending: false, running: false, trigger }
    backupQueues.set(backupFolderId, queue)
  }
  queue.pending = true
  queue.trigger = trigger
  if (queue.timer) clearTimeout(queue.timer)
  queue.timer = setTimeout(() => {
    queue!.timer = null
    void drainBackupQueue(backupFolderId, queue!)
  }, Math.max(0, delayMs))
}

async function drainSourceQueue(sourceFolderId: number, queue: SourceQueue): Promise<void> {
  if (queue.running) return
  queue.running = true
  try {
    while (queue.pending) {
      queue.pending = false
      const backup = getRepos().folders.getBackupForSource(sourceFolderId)
      if (!backup) break
      try {
        await getLibraryMirrorService().sync(backup.id, { trigger: queue.trigger })
      } catch (error) {
        console.warn(`[library-mirror] source ${sourceFolderId} sync failed:`, (error as Error).message)
      }
    }
  } finally {
    queue.running = false
    if (!queue.pending && !queue.timer) sourceQueues.delete(sourceFolderId)
  }
}

async function drainBackupQueue(backupFolderId: number, queue: SourceQueue): Promise<void> {
  if (queue.running) return
  queue.running = true
  try {
    while (queue.pending) {
      queue.pending = false
      const backup = getRepos().folders.getById(backupFolderId)
      if (!backup || backup.role !== 'backup') break
      try {
        await getLibraryMirrorService().sync(backup.id, { trigger: queue.trigger })
      } catch (error) {
        console.warn(`[library-mirror] destination ${backupFolderId} check failed:`, (error as Error).message)
      }
    }
  } finally {
    queue.running = false
    if (!queue.pending && !queue.timer) backupQueues.delete(backupFolderId)
  }
}

export async function stopLibraryMirrorRuntime(): Promise<void> {
  for (const queue of sourceQueues.values()) {
    if (queue.timer) clearTimeout(queue.timer)
  }
  for (const queue of backupQueues.values()) {
    if (queue.timer) clearTimeout(queue.timer)
  }
  sourceQueues.clear()
  backupQueues.clear()
  if (service) await service.dispose()
}
