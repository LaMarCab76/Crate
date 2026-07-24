import type { DuplicateSummary } from '@shared/types/duplicates'
import { getDatabase } from '../db/database'
import { getRepos } from '../db/repositories/index'
import { broadcast, onMainEvent } from '../ipc/events'
import { getLocalFileAccessService } from '../security/localFileAccessRuntime'
import { getDuplicateDecisionPortableService } from './DuplicateDecisionPortableService'
import {
  DuplicateAnalysisUnavailableError,
  DuplicateDetectionService,
} from './DuplicateDetectionService'
import { DuplicateRepository } from './DuplicateRepository'
import { createDuplicateRootPreflight } from './DuplicateRootPreflight'
import type { FingerprintProvider } from './fingerprint'
import { getMusicBrainzDuplicateEnricher } from './MusicBrainzDuplicateEnricher'
import { createChromaprintFingerprintProvider } from './native'

const SCHEDULE_DELAY_MS = 750

interface LibraryChangedPayload {
  reason?: string
  folderId?: number
  trackId?: number
}

const RELEVANT_LIBRARY_REASONS = new Set([
  'cloud-sync',
  'cloud-enrich',
  'cloud-move',
  'device-sync',
  'folder-add',
  'folder-remove',
  'track-metadata-update',
  'track-refresh',
  'metadata-completion',
  'track-album-move',
  'track-trash',
  'backup-promoted',
  'library-migration',
  'import',
  'import-file',
  'library-scan',
  'local-access-restored',
])

export class DuplicateRuntime {
  private readonly repo: DuplicateRepository
  private readonly detection: DuplicateDetectionService
  private readonly queuedTrackIds = new Set<number>()
  private readonly queuedFolderIds = new Set<number>()
  private queuedAll = false
  private forceNext = false
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private disposed = false
  private activeController: AbortController | null = null
  private readonly unsubscribeProgress: () => void
  private readonly unsubscribeLibrary: () => void

  constructor(provider: FingerprintProvider = createChromaprintFingerprintProvider()) {
    this.repo = new DuplicateRepository(getDatabase())
    this.detection = new DuplicateDetectionService(
      this.repo,
      provider,
      getMusicBrainzDuplicateEnricher(),
      {
        preflight: createDuplicateRootPreflight({
          getFolder: folderId => getRepos().folders.getById(folderId),
          inspect: rootPath => getLocalFileAccessService().inspect(rootPath),
        }),
      },
    )
    this.unsubscribeProgress = this.detection.onProgress(progress => {
      broadcast('duplicates:progress', progress)
    })
    this.unsubscribeLibrary = onMainEvent('library:changed', raw => {
      const payload = raw && typeof raw === 'object' ? raw as LibraryChangedPayload : {}
      if (!payload.reason || !RELEVANT_LIBRARY_REASONS.has(payload.reason)) return
      if (Number.isInteger(payload.trackId) && (payload.trackId ?? 0) > 0) {
        this.scheduleTracks([payload.trackId!])
      } else if (Number.isInteger(payload.folderId) && (payload.folderId ?? 0) > 0) {
        this.scheduleFolder(payload.folderId!)
      } else {
        this.scheduleAll()
      }
    })
  }

  summary(): DuplicateSummary {
    return this.detection.getSummary()
  }

  get service(): DuplicateDetectionService {
    return this.detection
  }

  scheduleAll(options: { force?: boolean; delayMs?: number } = {}): void {
    if (this.disposed) return
    this.queuedAll = true
    this.queuedTrackIds.clear()
    if (options.force) this.forceNext = true
    this.arm(options.delayMs)
  }

  scheduleFolder(folderId: number, options: { force?: boolean; delayMs?: number } = {}): void {
    if (this.disposed || !Number.isInteger(folderId) || folderId <= 0) return
    this.queuedFolderIds.add(folderId)
    if (options.force) this.forceNext = true
    this.arm(options.delayMs)
  }

  scheduleTracks(trackIds: readonly number[], options: { force?: boolean; delayMs?: number } = {}): void {
    if (this.disposed) return
    for (const id of trackIds) if (Number.isInteger(id) && id > 0) this.queuedTrackIds.add(id)
    if (options.force) this.forceNext = true
    this.arm(options.delayMs)
  }

  private arm(delayMs = SCHEDULE_DELAY_MS): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
    }, Math.max(0, delayMs))
  }

  private async drain(): Promise<void> {
    if (this.running || this.disposed) return
    this.running = (async () => {
      while (!this.disposed && (this.queuedAll || this.queuedTrackIds.size > 0 || this.queuedFolderIds.size > 0)) {
        const all = this.queuedAll
        const force = this.forceNext
        const folderIds = [...this.queuedFolderIds]
        this.queuedAll = false
        this.forceNext = false
        this.queuedFolderIds.clear()
        const trackIds = new Set(this.queuedTrackIds)
        this.queuedTrackIds.clear()

        const portable = getDuplicateDecisionPortableService()
        const foldersToImport = all
          ? this.repo.listEligibleTracks().map(track => track.folderId)
          : folderIds
        for (const folderId of new Set(foldersToImport)) {
          try { await portable.importForFolder(folderId) } catch (error) {
            console.warn(`[duplicates] portable decisions for folder ${folderId} could not be imported:`, error)
          }
        }
        if (!all && folderIds.length > 0) {
          const placeholders = folderIds.map(() => '?').join(',')
          const rows = getDatabase().prepare<unknown[], { id: number }>(`
            SELECT id FROM tracks WHERE folder_id IN (${placeholders})
          `).all(...folderIds)
          for (const row of rows) trackIds.add(row.id)
        }

        try {
          const controller = new AbortController()
          this.activeController = controller
          const result = await this.detection.analyze({
            trackIds: all ? undefined : [...trackIds],
            force,
            signal: controller.signal,
          })
          // A DB rebuild imports portable decisions before acoustic identities
          // exist. If this pass created them, import once more so moved paths or
          // providers can re-bind by an unambiguous digest, then reconcile the
          // already-cached candidates immediately (no second app launch).
          if (result.fingerprintsCreated > 0) {
            let importedPortableDecision = false
            for (const folderId of new Set(foldersToImport)) {
              try {
                importedPortableDecision = await portable.importForFolder(folderId) === 'imported'
                  || importedPortableDecision
              } catch (error) {
                console.warn(`[duplicates] post-analysis portable import for folder ${folderId} failed:`, error)
              }
            }
            if (importedPortableDecision) {
              await this.detection.analyze({
                trackIds: all ? undefined : [...trackIds],
                force: false,
                signal: controller.signal,
              })
            }
          }
        } catch (error) {
          if ((error as Error)?.name === 'AbortError' && this.disposed) break
          if (error instanceof DuplicateAnalysisUnavailableError) {
            console.info(`[duplicates] analysis waiting: ${error.message}`)
          } else {
            console.error('[duplicates] analysis failed:', error)
          }
        } finally {
          this.activeController = null
        }
        broadcast('duplicates:changed', { reason: 'analysis', summary: this.detection.getSummary() })
      }
    })().finally(() => { this.running = null })
    await this.running
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.drain()
    if (this.running) await this.running
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.activeController?.abort()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.unsubscribeProgress()
    this.unsubscribeLibrary()
    if (this.running) await this.running
  }
}

let runtime: DuplicateRuntime | null = null

export function getDuplicateRuntime(): DuplicateRuntime {
  runtime ??= new DuplicateRuntime()
  return runtime
}
