import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, unlink } from 'node:fs/promises'
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

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'unavailable', 'already_exists'])

function sanitizePathPart(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .slice(0, 120)
    .trim()
  return cleaned || fallback
}

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
  private harPreviews = new Map<string, { provider: DownloadProvider; payload: ProviderCredentialsPayload; canApply: boolean }>()
  private active = new Map<string, AbortController>()
  private processing = false

  getSettings(): DownloadSettings {
    return this.store.getSettings()
  }

  setSettings(patch: Partial<DownloadSettings>): DownloadSettings {
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
  }

  clearCredentials(provider: DownloadProvider): void {
    this.store.clearCredentials(provider)
  }

  inspectHar(provider: DownloadProvider, paths: string[]): HarImportPreview {
    const result = this.harExtractor.inspect(provider, paths)
    this.harPreviews.set(result.preview.previewId, {
      provider,
      payload: result.payload,
      canApply: result.preview.canApply,
    })
    return result.preview
  }

  applyHarImport(provider: DownloadProvider, previewId: string): void {
    const preview = this.harPreviews.get(previewId)
    if (!preview || preview.provider !== provider) {
      throw new Error('HAR preview expired. Import the HAR again.')
    }
    if (!preview.canApply) {
      throw new Error('No supported credentials were found in that HAR.')
    }
    this.store.saveCredentials(preview.payload)
    this.harPreviews.delete(previewId)
  }

  async search(payload: DownloadSearchRequest): Promise<OnlineTrackResult[]> {
    const query = payload.query.trim()
    if (!query) return []
    return this.registry.get(payload.provider).search(query, payload.limit ?? 25)
  }

  async enqueue(payload: EnqueueDownloadRequest): Promise<DownloadJob[]> {
    const settings = this.getSettings()
    const folderId = payload.folderId ?? settings.folderId
    const quality = qualityFromMaybe(payload.quality, settings.quality)
    const provider = this.registry.get(payload.provider)
    const ids = [...new Set(payload.providerTrackIds.map(id => id.trim()).filter(Boolean))]
    const jobs: DownloadJob[] = []

    for (const providerTrackId of ids) {
      const track = await provider.getTrack(providerTrackId)
      jobs.push(this.repos.downloadJobs.insert(track, {
        id: randomUUID(),
        folderId,
        quality,
      }))
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
    if (this.processing) return
    this.processing = true
    queueMicrotask(() => {
      try {
        const settings = this.getSettings()
        const slots = Math.max(0, settings.concurrency - this.active.size)
        if (slots <= 0) return
        const queued = this.repos.downloadJobs.queued().slice(0, slots)
        for (const job of queued) {
          void this.runJob(job.id)
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

    try {
      const startJob = this.repos.downloadJobs.getById(jobId)
      if (!startJob) return
      this.updateStatus(jobId, 'authenticating')

      const provider = this.registry.get(startJob.provider)
      const auth = await provider.authState()
      if (!auth.canDownload) {
        this.updateStatus(jobId, 'unavailable', auth.reason ?? 'Provider does not allow file downloads for this account.')
        return
      }

      this.updateStatus(jobId, 'resolving')
      const track = await provider.getTrack(startJob.providerTrackId)
      if (track.availability !== 'downloadable') {
        this.updateStatus(jobId, 'unavailable', track.unavailableReason ?? 'This track is not downloadable.')
        return
      }
      const resolution = await provider.resolveDownload(track, startJob.quality, controller.signal)
      const job = this.repos.downloadJobs.getById(jobId)
      if (!job) return

      const preferredPath = await this.destinationPath(job, resolution.track, resolution.extension)
      this.updatePath(jobId, preferredPath)

      if (existsSync(preferredPath) || this.repos.tracks.getByPath(preferredPath)) {
        await this.importExistingIfNeeded(job, preferredPath)
        this.updateStatus(jobId, 'already_exists', null)
        return
      }

      const finalPath = this.uniquePath(preferredPath)
      if (finalPath !== preferredPath) this.updatePath(jobId, finalPath)
      const partPath = `${finalPath}.part`
      await mkdir(dirname(finalPath), { recursive: true })
      await this.downloadToPart(resolution.url, partPath, jobId, controller.signal)
      this.updateStatus(jobId, 'verifying')
      await rename(partPath, finalPath)
      await readTrackMetadata(finalPath)

      this.updateStatus(jobId, 'tagging')
      this.updateStatus(jobId, 'importing')
      await getImportService().importFile(job.folderId!, finalPath)
      this.updateStatus(jobId, 'completed')
    } catch (err) {
      const job = this.repos.downloadJobs.getById(jobId)
      if (controller.signal.aborted) {
        this.updateStatus(jobId, 'cancelled', 'Cancelled by user.')
      } else if (err instanceof ProviderDownloadUnavailableError) {
        this.updateStatus(jobId, 'unavailable', err.message)
      } else if (job && !TERMINAL_STATUSES.has(job.status)) {
        this.updateStatus(jobId, 'failed', abortErrorMessage(err))
      }
    } finally {
      this.active.delete(jobId)
      this.processQueue()
    }
  }

  private async destinationPath(job: DownloadJob, track: OnlineTrackResult, extension: string): Promise<string> {
    if (!job.folderId) throw new Error('Choose a destination library before downloading.')
    const folder = this.repos.folders.getById(job.folderId)
    if (!folder) throw new Error('Destination library no longer exists.')
    const artist = sanitizePathPart(track.artist || job.artist, 'Unknown Artist')
    const album = sanitizePathPart(track.album || job.album, 'Unknown Album')
    const title = sanitizePathPart(track.title || job.title, 'Unknown Title')
    const ext = extension.startsWith('.') ? extension.slice(1) : extension
    const base = join(folder.path, 'Crate Downloads', providerFolder(job.provider), artist, album)
    const stem = `${title} [${job.provider}-${track.providerTrackId}]`
    return join(base, `${stem}.${ext}`)
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
    if (!job.folderId || this.repos.tracks.getByPath(path)) return
    await getImportService().importFile(job.folderId, path)
  }

  private async downloadToPart(url: string, partPath: string, jobId: string, signal: AbortSignal): Promise<void> {
    await unlink(partPath).catch(() => undefined)
    this.updateStatus(jobId, 'downloading')
    const response = await fetch(url, { signal })
    if (!response.ok || !response.body) {
      throw new Error(`Download request failed (${response.status})`)
    }
    const totalHeader = response.headers.get('content-length')
    const total = totalHeader ? Number.parseInt(totalHeader, 10) : null
    const out = createWriteStream(partPath)
    const reader = response.body.getReader()
    let received = 0
    let lastEmit = 0

    try {
      while (true) {
        if (signal.aborted) throw new Error('Download aborted.')
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        received += value.byteLength
        if (!out.write(Buffer.from(value))) {
          await new Promise<void>((resolve, reject) => {
            out.once('drain', resolve)
            out.once('error', reject)
          })
        }
        if (Date.now() - lastEmit > 200) {
          lastEmit = Date.now()
          this.updateProgress(jobId, received, total)
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.once('error', reject)
        out.end(() => resolve())
      })
      this.updateProgress(jobId, received, total)
    } catch (err) {
      out.destroy()
      await unlink(partPath).catch(() => undefined)
      throw err
    } finally {
      reader.releaseLock()
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
