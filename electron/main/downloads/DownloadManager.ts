import { existsSync } from 'node:fs'
import { link, mkdir, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  DownloadJob,
  DownloadProvider,
  DownloadQuality,
  DownloadSearchRequest,
  DownloadSettings,
  EnqueueDownloadRequest,
  HarImportPreview,
  OnlineTrackResult,
  ProviderAuthState,
  ProviderCredentialsPayload,
  ServiceTutorialState,
} from '@shared/types/downloads'
import { getRepos } from '../db/repositories'
import { getImportService } from '../library/ImportService'
import { readTrackMetadata } from '../library/MetadataExtractor'
import { broadcast } from '../ipc/events'
import { getCredentialStore } from './CredentialStore'
import { HarCredentialExtractor } from './HarCredentialExtractor'
import { getProviderRegistry } from './ProviderRegistry'
import { ProviderDownloadUnavailableError } from './types'
import { transferResponseToPart } from './DownloadTransfer'
import { downloadPartPath, requireLocalLibraryDownloadPath, sanitizePathPart } from './DownloadPaths'
import { proxyArtworkUrl } from './RemoteArtwork'
import { assertLibraryLocationMigrationUnlocked } from '../library-migration/locationLocks'

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'unavailable', 'already_exists'])
const HAR_PREVIEW_TTL_MS = 5 * 60 * 1000

function qualityFromMaybe(value: DownloadQuality | undefined, fallback: DownloadQuality): DownloadQuality {
  return value === 'best' || value === 'hires' || value === 'lossless' || value === 'mp3-320'
    ? value
    : fallback
}

function providerFolder(provider: DownloadProvider): string {
  return provider === 'qobuz' ? 'Qobuz' : 'TIDAL'
}

function abortErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class DownloadManager {
  private repos = getRepos()
  private store = getCredentialStore()
  private registry = getProviderRegistry()
  private harExtractor = new HarCredentialExtractor()
  private harPreviews = new Map<string, {
    provider: DownloadProvider
    payload: ProviderCredentialsPayload
    canApply: boolean
    expiresAt: number
  }>()
  private active = new Map<string, AbortController>()
  private activeTasks = new Map<string, Promise<void>>()
  private processing = false
  private started = false
  private disposing = false
  private startPromise: Promise<void> | null = null

  start(): Promise<void> {
    if (this.started) return Promise.resolve()
    if (this.startPromise) return this.startPromise
    this.startPromise = (async () => {
      this.disposing = false
      const interrupted = this.repos.downloadJobs.recoverInterrupted()
      await Promise.all(interrupted.map(job => {
        if (!job.path || !this.isJobPathAllowed(job, job.path)) return Promise.resolve()
        return unlink(downloadPartPath(job.path, job.id)).catch(() => undefined)
      }))
      this.started = true
      if (interrupted.length > 0) this.broadcastJobs()
      this.processQueue()
    })().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async dispose(): Promise<void> {
    if (this.startPromise) await this.startPromise
    if (this.disposing) {
      await Promise.allSettled([...this.activeTasks.values()])
      return
    }
    this.started = false
    this.disposing = true
    for (const controller of this.active.values()) controller.abort()
    await Promise.allSettled([...this.activeTasks.values()])
    this.harPreviews.clear()
    this.processing = false
    this.disposing = false
  }

  getSettings(): DownloadSettings {
    return this.store.getSettings()
  }

  setSettings(patch: Partial<DownloadSettings>): DownloadSettings {
    if (patch.folderId != null) this.requireLocalLibraryDestination(patch.folderId)
    const settings = this.store.setSettings(patch)
    this.processQueue()
    return settings
  }

  getTutorialState(): ServiceTutorialState {
    return this.store.getTutorialState()
  }

  setTutorialState(patch: Partial<ServiceTutorialState>): ServiceTutorialState {
    return this.store.setTutorialState(patch)
  }

  jobs(): DownloadJob[] {
    return this.repos.downloadJobs.list()
  }

  async authState(provider: DownloadProvider): Promise<ProviderAuthState> {
    return this.registry.get(provider).authState()
  }

  saveCredentials(payload: ProviderCredentialsPayload): void {
    this.store.saveCredentials(payload)
    this.registry.invalidateCredentials(payload.provider)
  }

  clearCredentials(provider: DownloadProvider): void {
    this.store.clearCredentials(provider)
    this.registry.invalidateCredentials(provider)
  }

  inspectHar(provider: DownloadProvider, paths: string[]): HarImportPreview {
    const now = Date.now()
    for (const [id, preview] of this.harPreviews) {
      if (preview.expiresAt <= now) this.harPreviews.delete(id)
    }
    const result = this.harExtractor.inspect(provider, paths)
    this.harPreviews.set(result.preview.previewId, {
      provider,
      payload: result.payload,
      canApply: result.preview.canApply,
      expiresAt: now + HAR_PREVIEW_TTL_MS,
    })
    return result.preview
  }

  applyHarImport(provider: DownloadProvider, previewId: string): void {
    const preview = this.harPreviews.get(previewId)
    if (!preview || preview.provider !== provider || preview.expiresAt <= Date.now()) {
      if (preview) this.harPreviews.delete(previewId)
      throw new Error('HAR preview expired. Import the HAR again.')
    }
    if (!preview.canApply) {
      throw new Error('No supported credentials were found in that HAR.')
    }
    this.store.saveCredentials(preview.payload)
    this.registry.invalidateCredentials(provider)
    this.harPreviews.delete(previewId)
  }

  async search(payload: DownloadSearchRequest): Promise<OnlineTrackResult[]> {
    const query = payload.query.trim()
    if (!query) return []
    const results = await this.registry.get(payload.provider).search(query, payload.limit ?? 25)
    return results.map(track => ({ ...track, artworkUrl: proxyArtworkUrl(track.artworkUrl) }))
  }

  async enqueue(payload: EnqueueDownloadRequest): Promise<DownloadJob[]> {
    if (this.disposing) throw new Error('Downloads are shutting down.')
    const settings = this.getSettings()
    const folderId = payload.folderId ?? settings.folderId
    if (folderId != null) this.requireLocalLibraryDestination(folderId)
    const quality = qualityFromMaybe(payload.quality, settings.quality)
    const provider = this.registry.get(payload.provider)
    const ids = [...new Set(payload.providerTrackIds.map(id => id.trim()).filter(Boolean))]
    const jobs: DownloadJob[] = []

    for (const providerTrackId of ids) {
      const providerTrack = await provider.getTrack(providerTrackId)
      const track = { ...providerTrack, artworkUrl: proxyArtworkUrl(providerTrack.artworkUrl) }
      const reservation = this.repos.downloadJobs.reserve(track, {
        id: randomUUID(),
        folderId,
        quality,
      })
      jobs.push(reservation.job)
    }

    this.broadcastJobs()
    this.processQueue()
    return jobs
  }

  async cancel(jobId: string): Promise<void> {
    const active = this.active.get(jobId)
    if (active) {
      active.abort()
      return
    }
    const job = this.repos.downloadJobs.getById(jobId)
    if (!job || TERMINAL_STATUSES.has(job.status)) return
    this.updateStatus(jobId, 'cancelled', 'Cancelled by user.')
  }

  async retry(jobId: string): Promise<DownloadJob | null> {
    const job = this.repos.downloadJobs.resetForRetry(jobId)
    this.broadcastJobs()
    this.processQueue()
    return job
  }

  private processQueue(): void {
    if (!this.started || this.disposing || this.processing) return
    this.processing = true
    queueMicrotask(() => {
      try {
        if (!this.started || this.disposing) return
        const settings = this.getSettings()
        const slots = Math.max(0, settings.concurrency - this.active.size)
        if (slots <= 0) return
        const queued = this.repos.downloadJobs.queued().slice(0, slots)
        for (const job of queued) {
          const task = this.runJob(job.id)
          this.activeTasks.set(job.id, task)
          const clearTask = (): void => {
            if (this.activeTasks.get(job.id) === task) this.activeTasks.delete(job.id)
          }
          void task.then(clearTask, clearTask)
        }
      } finally {
        this.processing = false
      }
    })
  }

  private async runJob(jobId: string): Promise<void> {
    if (this.active.has(jobId)) return
    const controller = new AbortController()
    this.active.set(jobId, controller)
    let partPath: string | null = null
    let publishedPath: string | null = null

    try {
      const startJob = this.repos.downloadJobs.claimQueued(jobId)
      if (!startJob) return
      this.broadcastJob(startJob)

      const provider = this.registry.get(startJob.provider)
      const auth = await provider.authState()
      if (!auth.canDownload) {
        this.updateStatus(jobId, 'unavailable', auth.reason ?? 'Provider does not allow file downloads for this account.')
        return
      }

      this.updateStatus(jobId, 'resolving')
      const track = await provider.getTrack(startJob.providerTrackId, controller.signal)
      if (track.availability !== 'downloadable') {
        this.updateStatus(jobId, 'unavailable', track.unavailableReason ?? 'This track is not downloadable.')
        return
      }
      const resolution = await provider.resolveDownload(track, startJob.quality, controller.signal)
      const job = this.repos.downloadJobs.getById(jobId)
      if (!job) return

      if (job.path && this.isJobPathAllowed(job, job.path) && existsSync(job.path)) {
        await this.verifyDownloadedFile(job.path, null, resolution.track)
        await this.importExistingIfNeeded(job, job.path)
        this.updateStatus(jobId, 'already_exists', null)
        return
      }

      const preferredPath = await this.destinationPath(job, resolution.track, resolution.extension)
      this.updatePath(jobId, preferredPath)

      if (existsSync(preferredPath)) {
        await this.verifyDownloadedFile(preferredPath, null, resolution.track)
        await this.importExistingIfNeeded(job, preferredPath)
        this.updateStatus(jobId, 'already_exists', null)
        return
      }

      const finalPath = this.uniquePath(preferredPath)
      if (finalPath !== preferredPath) this.updatePath(jobId, finalPath)
      partPath = downloadPartPath(finalPath, jobId)
      await mkdir(dirname(finalPath), { recursive: true })
      const received = await this.downloadToPart(
        resolution.url,
        partPath,
        jobId,
        controller.signal,
        resolution.bytesTotal,
      )
      this.updateStatus(jobId, 'verifying')
      await this.verifyDownloadedFile(partPath, received, resolution.track)
      // A hard link publishes the verified file atomically without replacing a
      // destination that may have appeared while the request was in flight.
      this.requireCurrentDownloadDestination(jobId, job.folderId, finalPath)
      await link(partPath, finalPath)
      try {
        // The asynchronous link may have overlapped a destination
        // reclassification. Never leave the just-published link in a backup.
        this.requireCurrentDownloadDestination(jobId, job.folderId, finalPath)
      } catch (err) {
        await unlink(finalPath).catch(() => undefined)
        throw err
      }
      publishedPath = finalPath
      try {
        await unlink(partPath)
        partPath = null
      } catch (err) {
        console.warn('[downloads] failed to remove published part file:', abortErrorMessage(err))
      }

      this.updateStatus(jobId, 'tagging')
      this.updateStatus(jobId, 'importing')
      const importJob = this.requireCurrentDownloadDestination(jobId, job.folderId, finalPath)
      await getImportService().importFile(importJob.folderId!, finalPath)
      publishedPath = null
      this.updateStatus(jobId, 'completed')
    } catch (err) {
      const job = this.repos.downloadJobs.getById(jobId)
      if (
        publishedPath &&
        (!job || job.path !== publishedPath || !this.isJobPathAllowed(job, publishedPath))
      ) {
        // This run created the hard link, so it is safe to retire when the
        // destination changed while metadata import was yielding. Existing
        // files take other branches and are never removed here.
        await unlink(publishedPath).catch(() => undefined)
        publishedPath = null
      }
      if (controller.signal.aborted) {
        if (this.disposing) this.updateStatus(jobId, 'queued', null)
        else this.updateStatus(jobId, 'cancelled', 'Cancelled by user.')
      } else if (err instanceof ProviderDownloadUnavailableError) {
        this.updateStatus(jobId, 'unavailable', err.message)
      } else if (job && !TERMINAL_STATUSES.has(job.status)) {
        this.updateStatus(jobId, 'failed', abortErrorMessage(err))
      }
    } finally {
      if (partPath) await unlink(partPath).catch(() => undefined)
      this.active.delete(jobId)
      this.processQueue()
    }
  }

  private async destinationPath(job: DownloadJob, track: OnlineTrackResult, extension: string): Promise<string> {
    if (!job.folderId) throw new Error('Choose a destination library before downloading.')
    const folder = this.repos.folders.getById(job.folderId)
    if (!folder) throw new Error('Destination library no longer exists.')
    if (folder.provider !== 'local' || folder.role !== 'library') {
      throw new Error('Downloads require a local library destination.')
    }
    const artist = sanitizePathPart(track.artist || job.artist, 'Unknown Artist')
    const album = sanitizePathPart(track.album || job.album, 'Unknown Album')
    const title = sanitizePathPart(track.title || job.title, 'Unknown Title')
    const ext = sanitizePathPart(extension.startsWith('.') ? extension.slice(1) : extension, 'bin')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 8) || 'bin'
    const base = join(folder.path, 'Crate Downloads', providerFolder(job.provider), artist, album)
    const providerTrackId = sanitizePathPart(track.providerTrackId, 'track')
    let stem = `${title} [${job.provider}-${providerTrackId}]`.slice(0, 150).replace(/[. ]+$/g, '')
    let destination = join(base, `${stem}.${ext}`)
    if (process.platform === 'win32' && destination.length > 240) {
      const overflow = destination.length - 240
      stem = stem.slice(0, Math.max(16, stem.length - overflow)).replace(/[. ]+$/g, '')
      destination = join(base, `${stem}.${ext}`)
      if (destination.length > 240) {
        throw new Error('Destination library path is too long for a safe Windows download path.')
      }
    }
    return destination
  }

  private uniquePath(filePath: string): string {
    if (!existsSync(filePath) && !this.repos.tracks.getByPath(filePath)) return filePath
    const dir = dirname(filePath)
    const ext = extname(filePath)
    const stem = basename(filePath, ext)
    for (let i = 2; i < 100; i++) {
      const candidate = join(dir, `${stem} ${i}${ext}`)
      if (!existsSync(candidate) && !this.repos.tracks.getByPath(candidate)) return candidate
    }
    return join(dir, `${stem} ${Date.now()}${ext}`)
  }

  private async importExistingIfNeeded(job: DownloadJob, path: string): Promise<void> {
    if (!job.folderId) return
    const current = this.requireCurrentDownloadDestination(job.id, job.folderId, path)
    if (this.repos.tracks.getByPath(path)) return
    // Re-read once more at the exact import boundary. This is intentionally
    // synchronous with the call below, so no reclassification can interleave.
    this.requireCurrentDownloadDestination(job.id, job.folderId, path)
    await getImportService().importFile(current.folderId!, path)
  }

  private isJobPathAllowed(job: DownloadJob, path: string): boolean {
    if (!job.folderId) return false
    try {
      requireLocalLibraryDownloadPath(this.repos.folders.getById(job.folderId), path)
      return true
    } catch {
      return false
    }
  }

  private requireCurrentDownloadDestination(
    jobId: string,
    expectedFolderId: number | null,
    path: string,
  ): DownloadJob {
    const current = this.repos.downloadJobs.getById(jobId)
    if (!current || !expectedFolderId || current.folderId !== expectedFolderId) {
      throw new Error('Download destination changed while the transfer was running.')
    }
    if (current.path !== path) {
      throw new Error('Download path changed while the transfer was running.')
    }
    requireLocalLibraryDownloadPath(this.repos.folders.getById(current.folderId), path)
    return current
  }

  private requireLocalLibraryDestination(folderId: number) {
    assertLibraryLocationMigrationUnlocked(folderId, 'las descargas hacia ella')
    const folder = this.repos.folders.getById(folderId)
    if (!folder || folder.provider !== 'local' || folder.role !== 'library') {
      throw new Error('Downloads require a local library destination.')
    }
    return folder
  }

  private async downloadToPart(
    url: string,
    partPath: string,
    jobId: string,
    signal: AbortSignal,
    providerBytesTotal: number | null,
  ): Promise<number> {
    await unlink(partPath).catch(() => undefined)
    this.updateStatus(jobId, 'downloading')
    const response = await fetch(url, { signal })
    return transferResponseToPart({
      response,
      partPath,
      signal,
      providerBytesTotal,
      onProgress: (received, total) => this.updateProgress(jobId, received, total),
    })
  }

  private async verifyDownloadedFile(
    path: string,
    expectedBytes: number | null,
    track: OnlineTrackResult,
  ): Promise<void> {
    const metadata = await readTrackMetadata(path, { artwork: false })
    if (!metadata.fileSize || metadata.fileSize <= 0) throw new Error('Downloaded audio file is empty.')
    if (expectedBytes != null && metadata.fileSize !== expectedBytes) {
      throw new Error(`Downloaded file size changed during verification (${metadata.fileSize} != ${expectedBytes}).`)
    }
    if (!Number.isFinite(metadata.duration) || metadata.duration <= 0) {
      throw new Error('Downloaded file does not contain valid audio metadata.')
    }
    if (track.durationSec && track.durationSec > 0) {
      const tolerance = Math.max(8, track.durationSec * 0.1)
      if (Math.abs(metadata.duration - track.durationSec) > tolerance) {
        throw new Error('Downloaded audio duration does not match the selected track.')
      }
    }
  }

  private updateStatus(jobId: string, status: DownloadJob['status'], error: string | null = null): DownloadJob | null {
    const job = this.repos.downloadJobs.setStatus(jobId, status, error)
    if (job) this.broadcastJob(job)
    return job
  }

  private updatePath(jobId: string, path: string): void {
    const job = this.repos.downloadJobs.setPath(jobId, path)
    if (job) this.broadcastJob(job)
  }

  private updateProgress(jobId: string, bytesReceived: number, bytesTotal: number | null): void {
    const job = this.repos.downloadJobs.setProgress(jobId, bytesReceived, Number.isFinite(bytesTotal) ? bytesTotal : null)
    if (job) this.broadcastJob(job)
  }

  private broadcastJob(job: DownloadJob): void {
    broadcast('downloads:progress', { job })
    this.broadcastJobs()
  }

  private broadcastJobs(): void {
    broadcast('downloads:jobs-changed', { jobs: this.jobs() })
  }
}

let instance: DownloadManager | null = null
export function getDownloadManager(): DownloadManager {
  if (!instance) instance = new DownloadManager()
  return instance
}
