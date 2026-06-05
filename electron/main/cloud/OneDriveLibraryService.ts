import { shell } from 'electron'
import { readFile, unlink } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { Repos } from '../db/repositories'
import { getRepos } from '../db/repositories'
import { getOneDriveClient, type DriveItem } from './OneDriveClient'
import { getOneDriveCredentialStore } from './OneDriveCredentialStore'
import { getCloudManifestService } from './CloudManifestService'
import { audioFacetToMetadata } from './cloudMetadata'
import { buildTrackInsert, isAudioPath } from '../library/ImportService'
import { readTrackMetadataFromBuffer } from '../library/MetadataExtractor'
import { parseArtistName } from '../library/ArtistNameParser'
import { broadcast } from '../ipc/events'
import { lufsFromReplayGain } from '@shared/constants/leveler'
import type { DbTrack, DbTrackInsert } from '@shared/types/db'
import type {
  CloudFolderRef,
  CloudMoveDisposition,
  CloudMoveProgressEvent,
  CloudSyncProgressEvent,
} from '@shared/types/cloud'

const POLL_INTERVAL_MS = 5 * 60_000
const INSERT_BATCH = 100
// How many header bytes to pull for accurate tag parsing. Tag/STREAMINFO blocks
// live near the start for FLAC/MP3/OGG; some M4A keep atoms at the end, where a
// prefix parse may come back empty — we skip those rather than download the file.
const ENRICH_PREFIX_BYTES = 2 * 1024 * 1024

// Build a cloud-sourced track row: reuse the local builder, then overwrite the
// source/path/cloud fields and the filename (the synthetic path has no real name).
function buildCloudTrackInsert(
  item: DriveItem,
  folderId: number,
  driveId: string,
  albumId: number,
  artistId: number,
  genreId: number | null,
): DbTrackInsert {
  const path = `onedrive://${driveId}/${item.id}`
  const md = audioFacetToMetadata(item)
  const base = buildTrackInsert(md, path, folderId, albumId, artistId, genreId)
  return {
    ...base,
    filename: item.name ?? base.filename,
    source: 'onedrive',
    cloud_drive_id: driveId,
    cloud_item_id: item.id,
    cloud_etag: item.eTag ?? item.cTag ?? null,
    cloud_remote_path: item.parentReference?.path
      ? `${item.parentReference.path}/${item.name ?? ''}`
      : (item.name ?? null),
  }
}

function isAudioDriveItem(item: DriveItem): boolean {
  if (item.folder || !item.file) return false
  const name = item.name ?? ''
  return isAudioPath(name) || (item.file.mimeType ?? '').startsWith('audio/')
}

export class OneDriveLibraryService {
  private repos: Repos
  private syncing = new Set<number>()
  private pollTimer: NodeJS.Timeout | null = null

  constructor() {
    this.repos = getRepos()
  }

  // Register a OneDrive folder and kick off its first delta sync. After indexing,
  // import any existing in-folder manifest (to restore favorites/plays from
  // another machine) and then write a fresh manifest reflecting the merged state.
  async addCloudFolder(driveId: string, itemId: string, name: string): Promise<CloudFolderRef> {
    const folder = this.repos.folders.addCloud(driveId, itemId, name)
    void (async () => {
      await this.syncCloudFolder(folder.id)
      await getCloudManifestService().importManifest(folder.id)
      await getCloudManifestService().writeManifest(folder.id)
    })().catch(err => console.error('[cloud] initial folder setup failed:', (err as Error).message))
    return { folderId: folder.id, driveId, itemId, name }
  }

  // Sync a folder and then persist the manifest (used by manual sync + polling).
  async resyncFolder(folderId: number): Promise<void> {
    await this.syncCloudFolder(folderId)
    await getCloudManifestService().writeManifest(folderId).catch(err =>
      console.warn('[cloud] manifest write failed:', (err as Error).message),
    )
  }

  // Enumerate (or incrementally re-enumerate) a cloud folder via the delta API,
  // indexing new/changed audio items and removing deleted ones. Persists the new
  // deltaLink so the next run is cheap.
  async syncCloudFolder(folderId: number): Promise<void> {
    const folder = this.repos.folders.getById(folderId)
    if (!folder || folder.source !== 'onedrive' || !folder.cloud_drive_id || !folder.cloud_item_id) return
    if (this.syncing.has(folderId)) return
    this.syncing.add(folderId)

    const driveId = folder.cloud_drive_id
    const startToken = folder.cloud_delta_link ?? folder.cloud_item_id
    const client = getOneDriveClient()
    const batch: DbTrackInsert[] = []
    const flush = (): void => {
      if (batch.length) this.repos.tracks.insertBatch(batch.splice(0))
    }

    let scanned = 0
    let imported = 0
    let newDeltaLink: string | null = null

    try {
      this.emitProgress({ folderId, phase: 'enumerating', scanned: 0, imported: 0, total: null })

      for await (const page of client.listDelta(driveId, startToken)) {
        for (const item of page.items) {
          if (item.deleted) {
            const existing = this.repos.tracks.getByCloudItem(driveId, item.id)
            if (existing) this.repos.tracks.deleteById(existing.id)
            continue
          }
          if (!isAudioDriveItem(item)) continue
          scanned++

          const existing = this.repos.tracks.getByCloudItem(driveId, item.id)
          if (existing) {
            const etag = item.eTag ?? item.cTag ?? null
            if (etag && existing.cloud_etag !== etag) this.repos.tracks.updateCloudEtag(existing.id, etag)
            continue
          }

          const row = this.buildRow(item, folderId, driveId)
          if (row) {
            batch.push(row)
            imported++
            if (batch.length >= INSERT_BATCH) {
              flush()
              this.emitProgress({ folderId, phase: 'indexing', scanned, imported, total: null })
            }
          }
        }
        if (page.deltaLink) newDeltaLink = page.deltaLink
      }

      flush()
      if (newDeltaLink) this.repos.folders.setDeltaLink(folderId, newDeltaLink)
      this.repos.folders.updateTrackCount(folderId, this.repos.tracks.countByFolder(folderId))

      this.emitProgress({ folderId, phase: 'done', scanned, imported, total: scanned })
      broadcast('library:changed', { reason: 'cloud-sync' })

      // Background pass: refine codec/sample-rate/bit-depth from real tags. Runs
      // after the (fast, facet-based) sync returns so playback isn't blocked on it.
      void this.enrichCloudFolderMetadata(folderId).catch(err =>
        console.warn('[cloud] metadata enrichment sweep failed:', (err as Error).message),
      )
    } catch (err) {
      this.emitProgress({
        folderId,
        phase: 'error',
        scanned,
        imported,
        total: null,
        message: (err as Error).message,
      })
      throw err
    } finally {
      this.syncing.delete(folderId)
    }
  }

  // Move a local track up to OneDrive: upload its bytes, repoint the existing DB
  // row to the cloud (keeping its id + all state), then dispose of the local
  // original per the user's preference. The repoint must succeed before any
  // local deletion so a failed upload never loses the only copy.
  async moveTrackToCloud(
    trackId: number,
    targetFolderId: number,
    dispositionOverride?: CloudMoveDisposition,
  ): Promise<void> {
    const track = this.repos.tracks.getById(trackId)
    if (!track) throw new Error(`Track ${trackId} not found.`)
    if (track.source !== 'local') throw new Error('Track is not a local file.')

    const target = this.repos.folders.getById(targetFolderId)
    if (!target || target.source !== 'onedrive' || !target.cloud_drive_id || !target.cloud_item_id) {
      throw new Error('Target is not a OneDrive folder.')
    }
    const driveId = target.cloud_drive_id
    const parentItemId = target.cloud_item_id
    const oldFolderId = track.folder_id
    const localPath = resolve(track.path)
    const filename = track.filename || basename(localPath)

    try {
      this.emitMoveProgress({ trackId, phase: 'reading', uploaded: 0, total: 0 })
      const buffer = await readFile(localPath)
      const total = buffer.byteLength

      this.emitMoveProgress({ trackId, phase: 'uploading', uploaded: 0, total })
      const uploaded = await getOneDriveClient().uploadFile({
        driveId,
        parentItemId,
        filename,
        buffer,
        onProgress: (u, t) => this.emitMoveProgress({ trackId, phase: 'uploading', uploaded: u, total: t }),
      })

      this.emitMoveProgress({ trackId, phase: 'finalizing', uploaded: total, total })
      this.repos.tracks.repointToCloud({
        id: trackId,
        path: `onedrive://${driveId}/${uploaded.id}`,
        folderId: targetFolderId,
        cloudDriveId: driveId,
        cloudItemId: uploaded.id,
        cloudEtag: uploaded.etag,
        cloudRemotePath: uploaded.name || filename,
        fileSize: uploaded.size || total,
      })
      this.repos.folders.updateTrackCount(targetFolderId, this.repos.tracks.countByFolder(targetFolderId))
      if (oldFolderId !== targetFolderId) {
        this.repos.folders.updateTrackCount(oldFolderId, this.repos.tracks.countByFolder(oldFolderId))
      }

      // Only now — repoint committed — touch the local original.
      const disposition = dispositionOverride ?? getOneDriveCredentialStore().getPrefs().moveDisposition
      await this.disposeLocalOriginal(localPath, disposition)

      this.emitMoveProgress({ trackId, phase: 'done', uploaded: total, total })
      broadcast('library:changed', { reason: 'cloud-move' })
    } catch (err) {
      this.emitMoveProgress({ trackId, phase: 'error', uploaded: 0, total: 0, message: (err as Error).message })
      throw err
    }
  }

  private async disposeLocalOriginal(localPath: string, disposition: CloudMoveDisposition): Promise<void> {
    try {
      if (disposition === 'trash') await shell.trashItem(localPath)
      else if (disposition === 'delete') await unlink(localPath)
      // 'keep' (and an unresolved 'ask') leave the original on disk.
    } catch (err) {
      console.warn('[cloud] failed to dispose local original:', (err as Error).message)
    }
  }

  private emitMoveProgress(event: CloudMoveProgressEvent): void {
    broadcast('cloud:move:progress', event)
  }

  // Refine the technical metadata of cloud tracks that were indexed from the
  // Graph audio facet only (codec/sample-rate/bit-depth unknown). Pulls just the
  // file header into RAM and re-parses real tags. Chunked with event-loop yields.
  private async enrichCloudFolderMetadata(folderId: number): Promise<void> {
    const pending = this.repos.tracks
      .getByFolder(folderId)
      .filter(t => t.source === 'onedrive' && (t.codec == null || t.sample_rate == null))
    let enriched = 0
    for (const track of pending) {
      try {
        if (await this.enrichCloudTrack(track)) enriched++
      } catch (err) {
        console.warn(`[cloud] enrich failed for ${track.filename}:`, (err as Error).message)
      }
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    if (enriched) broadcast('library:changed', { reason: 'cloud-enrich' })
  }

  private async enrichCloudTrack(track: DbTrack): Promise<boolean> {
    if (!track.cloud_drive_id || !track.cloud_item_id) return false
    const { buffer } = await getOneDriveClient().fetchPrefix(
      track.cloud_drive_id,
      track.cloud_item_id,
      ENRICH_PREFIX_BYTES,
    )
    const md = await readTrackMetadataFromBuffer(buffer, {
      filename: track.filename,
      fileSize: track.file_size,
      options: { artwork: false },
    })
    // The prefix didn't yield real technical info (e.g. trailing-atom M4A) — leave
    // the facet-derived values in place rather than overwrite them with nulls.
    if (md.sampleRate == null && md.codec == null) return false
    this.repos.tracks.updateTechnical({
      id: track.id,
      format: md.format || track.format,
      codec: md.codec ?? track.codec,
      bitrate: md.bitrate ?? track.bitrate,
      sampleRate: md.sampleRate ?? track.sample_rate,
      channels: md.channels ?? track.channels,
      bitDepth: md.bitDepth ?? track.bit_depth,
      duration: md.duration > 0 ? md.duration : track.duration,
      loudness: lufsFromReplayGain(md.replayGainTrack),
    })
    return true
  }

  private buildRow(item: DriveItem, folderId: number, driveId: string): DbTrackInsert | null {
    try {
      const md = audioFacetToMetadata(item)
      const parsedArtist = parseArtistName(md.artist)
      const artist = this.repos.artists.getOrCreate(parsedArtist.primary || md.artist)
      const album = this.repos.albums.getOrCreate(md.album, md.albumArtist ?? null, md.year || null)
      const genre = md.genre ? this.repos.genres.getOrCreate(md.genre) : null
      return buildCloudTrackInsert(item, folderId, driveId, album.id, artist.id, genre?.id ?? null)
    } catch (err) {
      console.warn(`[cloud] skip ${item.name}:`, (err as Error).message)
      return null
    }
  }

  // Periodic incremental re-sync of every registered cloud folder. Replaces the
  // chokidar watch (which only understands local paths) for cloud sources.
  startPolling(intervalMs = POLL_INTERVAL_MS): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => void this.syncAllCloudFolders(), intervalMs)
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  async syncAllCloudFolders(): Promise<void> {
    for (const folder of this.repos.folders.list()) {
      if (folder.source !== 'onedrive') continue
      try {
        await this.resyncFolder(folder.id)
      } catch (err) {
        console.warn(`[cloud] poll sync failed for folder ${folder.id}:`, (err as Error).message)
      }
    }
  }

  private emitProgress(event: CloudSyncProgressEvent): void {
    broadcast('cloud:sync:progress', event)
  }
}

let instance: OneDriveLibraryService | null = null
export function getOneDriveLibraryService(): OneDriveLibraryService {
  if (!instance) instance = new OneDriveLibraryService()
  return instance
}
