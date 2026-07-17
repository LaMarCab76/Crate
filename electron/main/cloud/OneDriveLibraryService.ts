import { shell } from 'electron'
import { open, unlink } from 'node:fs/promises'
import { basename, posix } from 'node:path'
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { DbFolder, DbTrack, DbTrackInsert } from '@shared/types/db'
import type {
  CloudFolderRef,
  CloudMoveDisposition,
  CloudMoveProgressEvent,
  CloudSyncProgressEvent,
} from '@shared/types/cloud'
import { getDatabase } from '../db/database'
import type { Repos } from '../db/repositories'
import { getRepos } from '../db/repositories'
import { broadcast } from '../ipc/events'
import { buildTrackInsert, isAudioPath } from '../library/ImportService'
import { parseArtistName } from '../library/ArtistNameParser'
import { requireLocalLibraryTrackPath } from '../library/localLibraryTrackGuard'
import { scheduleMirrorForBackupDestination } from '../library-mirror/runtime'
import { assertLibraryLocationMigrationUnlocked } from '../library-migration/locationLocks'
import { getCloudManifestService } from './CloudManifestService'
import { audioFacetToMetadata, driveItemRemotePath } from './cloudMetadata'
import { cloudRelativePath } from './cloudPortableManifest'
import { assertCloudMoveAuthority } from './cloudMoveSafety'
import {
  CloudHttpError,
  getOneDriveClient,
  type DriveItem,
  type OneDriveClient,
  type UploadedItem,
} from './OneDriveClient'
import { getOneDriveCredentialStore } from './OneDriveCredentialStore'
import { getLibraryBackup } from '../services/LibraryBackup'

const POLL_INTERVAL_MS = 5 * 60_000

interface ExistingCloudTrack {
  id: number
  item_id: string
  etag: string | null
}

type AuthorizedOneDriveFolder = DbFolder & {
  provider: 'onedrive'
  drive_id: string
  item_id: string
}

export interface CloudSyncResult {
  folderId: number
  scanned: number
  imported: number
  removed: number
  reset: boolean
  deltaCursor: string
}

export type CloudSyncCompleteListener = (result: CloudSyncResult) => void | Promise<void>

function isAudioDriveItem(item: DriveItem): boolean {
  if (!item.file || item.folder || item.deleted) return false
  return isAudioPath(item.name ?? '') || (item.file.mimeType ?? '').startsWith('audio/')
}

function isMigrationStagingItem(folder: DbFolder, item: DriveItem): boolean {
  if (!folder.remote_path) return false
  const relative = cloudRelativePath(folder.remote_path, driveItemRemotePath(item))
  return relative === '.crate/migrations' || relative?.startsWith('.crate/migrations/') === true
}

function normalizedRemotePath(value: string): string {
  return posix.normalize(value.startsWith('/') ? value : `/${value}`)
}

function remotePathsOverlap(left: string, right: string): boolean {
  const a = normalizedRemotePath(left)
  const b = normalizedRemotePath(right)
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function cloudTrackInsert(
  item: DriveItem,
  folderId: number,
  driveId: string,
  albumId: number,
  artistId: number,
  genreId: number | null,
): DbTrackInsert {
  const path = `onedrive://${driveId}/${item.id}`
  const base = buildTrackInsert(
    audioFacetToMetadata(item),
    path,
    folderId,
    albumId,
    artistId,
    genreId,
  )
  return {
    ...base,
    filename: item.name ?? base.filename,
    provider: 'onedrive',
    drive_id: driveId,
    item_id: item.id,
    etag: item.eTag ?? item.cTag ?? null,
    remote_path: driveItemRemotePath(item),
    quickxor_hash: item.file?.hashes?.quickXorHash ?? null,
  }
}

export class OneDriveLibraryService {
  private readonly repos: Repos
  private readonly db: BetterSqliteDatabase
  private readonly client: OneDriveClient
  private readonly syncing = new Map<number, Promise<CloudSyncResult>>()
  private readonly folderOperations = new Map<number, Promise<unknown>>()
  private readonly syncCompleteListeners = new Set<CloudSyncCompleteListener>()
  private pollTimer: NodeJS.Timeout | null = null

  constructor(options: {
    repos?: Repos
    db?: BetterSqliteDatabase
    client?: OneDriveClient
  } = {}) {
    this.repos = options.repos ?? getRepos()
    this.db = options.db ?? getDatabase()
    this.client = options.client ?? getOneDriveClient()
  }

  /** Startup wiring can subscribe here and trigger the mirror assigned to this
   * source with the `cloud_delta` reason. Listener failures never fail indexing. */
  onSyncComplete(listener: CloudSyncCompleteListener): () => void {
    this.syncCompleteListeners.add(listener)
    return () => this.syncCompleteListeners.delete(listener)
  }

  async addCloudFolder(
    driveId: string,
    itemId: string,
    name: string,
    options: { accountId: string; remotePath: string },
  ): Promise<CloudFolderRef> {
    const accountId = options.accountId.trim()
    if (!accountId) throw new Error('OneDrive account id is required.')
    const remotePath = normalizedRemotePath(options.remotePath)
    for (const existing of this.repos.folders.listAll()) {
      if (
        existing.provider === 'onedrive' &&
        existing.drive_id === driveId &&
        existing.remote_path &&
        remotePathsOverlap(existing.remote_path, remotePath)
      ) {
        if (existing.item_id === itemId) {
          return { folderId: existing.id, driveId, itemId, name: existing.name }
        }
        throw new Error(`The OneDrive folder overlaps library "${existing.name}".`)
      }
    }

    const folder = this.repos.folders.addOneDrive({
      accountId,
      driveId,
      itemId,
      name,
      remotePath,
    })
    await this.syncCloudFolder(folder.id)
    const manifest = await getCloudManifestService().importManifest(folder.id)
    if (manifest === 'missing' || manifest === 'legacy') {
      await getCloudManifestService().writeManifest(folder.id)
    }
    return { folderId: folder.id, driveId, itemId, name: folder.name }
  }

  async resyncFolder(folderId: number): Promise<CloudSyncResult> {
    const result = await this.syncCloudFolder(folderId)
    const manifest = await getCloudManifestService().importManifest(folderId)
    if (manifest === 'missing' || manifest === 'legacy') {
      await getCloudManifestService().writeManifest(folderId)
    }
    return result
  }

  syncCloudFolder(folderId: number): Promise<CloudSyncResult> {
    assertLibraryLocationMigrationUnlocked(folderId, 'la sincronización de OneDrive')
    const active = this.syncing.get(folderId)
    if (active) return active
    const operation = this.withFolderLock(folderId, () => this.performSync(folderId))
      .finally(() => this.syncing.delete(folderId))
    this.syncing.set(folderId, operation)
    return operation
  }

  async waitForFolderIdle(folderId: number): Promise<void> {
    const pending = this.folderOperations.get(folderId) ?? this.syncing.get(folderId)
    if (pending) await Promise.allSettled([pending])
  }

  private withFolderLock<T>(folderId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.folderOperations.get(folderId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.folderOperations.set(folderId, next)
    void next.finally(() => {
      if (this.folderOperations.get(folderId) === next) this.folderOperations.delete(folderId)
    }).catch(() => undefined)
    return next
  }

  private async performSync(folderId: number): Promise<CloudSyncResult> {
    let folder = await this.refreshOneDriveRoot(folderId, 'library')

    let scanned = 0
    let imported = 0
    let removed = 0
    let reset = folder.delta_cursor == null
    let deltaCursor: string | null = null
    const changes = new Map<string, DriveItem>()

    try {
      this.emitSync({ folderId, phase: 'enumerating', scanned: 0, imported: 0, total: null })
      for await (const page of this.client.listDelta(
        folder.drive_id,
        folder.item_id,
        folder.delta_cursor,
      )) {
        if (page.reset) {
          // Discard any incremental pages observed before the expired cursor was
          // rejected. From this point on Graph is supplying the replacement
          // full inventory, which must be the only basis for reconciliation.
          changes.clear()
          reset = true
        }
        for (const item of page.items) changes.set(item.id, item)
        if (page.deltaLink) deltaCursor = page.deltaLink
      }
      if (!deltaCursor) {
        throw new Error('OneDrive inventory completed without a delta cursor.')
      }

      const currentFolder = this.repos.folders.getById(folderId)
      if (
        !currentFolder ||
        currentFolder.provider !== 'onedrive' ||
        currentFolder.role !== 'library' ||
        currentFolder.drive_id !== folder.drive_id ||
        currentFolder.item_id !== folder.item_id
      ) throw new Error(`Library ${folderId} stopped being an indexable OneDrive library.`)
      folder = {
        ...currentFolder,
        provider: 'onedrive',
        drive_id: currentFolder.drive_id,
        item_id: currentFolder.item_id,
      }

      const audioChanges = [...changes.values()].filter(item => (
        isAudioDriveItem(item) && !isMigrationStagingItem(folder, item)
      )).length
      this.emitSync({
        folderId,
        phase: 'indexing',
        scanned: 0,
        imported: 0,
        total: audioChanges,
      })

      const transaction = this.db.transaction(() => {
        const existing = this.db.prepare<[number], ExistingCloudTrack>(`
          SELECT id, item_id, etag FROM tracks
          WHERE folder_id = ? AND provider = 'onedrive' AND item_id IS NOT NULL
        `).all(folderId)
        const byItemId = new Map(existing.map(row => [row.item_id, row]))
        const fullInventoryAudioIds = new Set<string>()
        const removedTrackIds = new Set<number>()

        for (const item of changes.values()) {
          const row = byItemId.get(item.id)
          if (item.deleted || isMigrationStagingItem(folder, item) || (item.file && !isAudioDriveItem(item))) {
            if (row) {
              this.repos.tracks.deleteById(row.id)
              removedTrackIds.add(row.id)
              removed += 1
            }
            continue
          }
          if (!isAudioDriveItem(item)) continue
          scanned += 1
          fullInventoryAudioIds.add(item.id)
          const entityIds = this.resolveEntities(item)
          if (row) {
            this.updateCloudTrack(row.id, item, folder, entityIds)
          } else {
            const inserted = this.repos.tracks.insert(cloudTrackInsert(
              item,
              folder.id,
              folder.drive_id!,
              entityIds.albumId,
              entityIds.artistId,
              entityIds.genreId,
            ))
            if (inserted > 0) imported += 1
          }
        }

        if (reset) {
          for (const row of existing) {
            if (!fullInventoryAudioIds.has(row.item_id) && !removedTrackIds.has(row.id)) {
              this.repos.tracks.deleteById(row.id)
              removed += 1
            }
          }
        }
        this.repos.folders.setDeltaCursor(folder.id, deltaCursor)
        this.repos.folders.updateTrackCount(folder.id, this.repos.tracks.countByFolder(folder.id))
      })
      transaction.immediate()

      const result: CloudSyncResult = {
        folderId,
        scanned,
        imported,
        removed,
        reset,
        deltaCursor,
      }
      this.emitSync({ folderId, phase: 'done', scanned, imported, total: scanned })
      broadcast('library:changed', { reason: 'cloud-sync', folderId })
      if (changes.size > 0) this.notifySyncComplete(result)
      return result
    } catch (error) {
      this.emitSync({
        folderId,
        phase: 'error',
        scanned,
        imported,
        total: null,
        message: (error as Error).message,
      })
      throw error
    }
  }

  private resolveEntities(item: DriveItem): {
    albumId: number
    artistId: number
    genreId: number | null
  } {
    const metadata = audioFacetToMetadata(item)
    const parsed = parseArtistName(metadata.artist)
    const artist = this.repos.artists.getOrCreate(parsed.primary || metadata.artist)
    const album = this.repos.albums.getOrCreate(
      metadata.album,
      metadata.albumArtist,
      metadata.year || null,
    )
    const genre = metadata.genre ? this.repos.genres.getOrCreate(metadata.genre) : null
    return { albumId: album.id, artistId: artist.id, genreId: genre?.id ?? null }
  }

  private updateCloudTrack(
    trackId: number,
    item: DriveItem,
    folder: DbFolder,
    entities: { albumId: number; artistId: number; genreId: number | null },
  ): void {
    const metadata = audioFacetToMetadata(item)
    this.db.prepare(`
      UPDATE tracks SET
        path = @path, filename = @filename, title = @title, artist = @artist,
        album = @album, duration = @duration, format = @format,
        file_size = @fileSize, date_modified = @dateModified,
        album_artist = @albumArtist, composer = @composer, genre = @genre, year = @year,
        track_number = @trackNumber, total_tracks = @totalTracks,
        disc_number = @discNumber, total_discs = @totalDiscs,
        bitrate = @bitrate, album_id = @albumId, artist_id = @artistId, genre_id = @genreId,
        provider = 'onedrive', drive_id = @driveId, item_id = @itemId,
        etag = @etag, remote_path = @remotePath, quickxor_hash = @quickXorHash
      WHERE id = @id
    `).run({
      id: trackId,
      path: `onedrive://${folder.drive_id}/${item.id}`,
      filename: item.name ?? item.id,
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
      duration: metadata.duration,
      format: metadata.format,
      fileSize: metadata.fileSize,
      dateModified: metadata.dateModified,
      albumArtist: metadata.albumArtist,
      composer: metadata.composer,
      genre: metadata.genre,
      year: metadata.year,
      trackNumber: metadata.trackNumber,
      totalTracks: metadata.totalTracks,
      discNumber: metadata.discNumber,
      totalDiscs: metadata.totalDiscs,
      bitrate: metadata.bitrate,
      albumId: entities.albumId,
      artistId: entities.artistId,
      genreId: entities.genreId,
      driveId: folder.drive_id,
      itemId: item.id,
      etag: item.eTag ?? item.cTag ?? null,
      remotePath: driveItemRemotePath(item),
      quickXorHash: item.file?.hashes?.quickXorHash ?? null,
    })
  }

  async moveTrackToCloud(
    trackId: number,
    targetFolderId: number,
    dispositionOverride?: CloudMoveDisposition,
  ): Promise<void> {
    return this.withFolderLock(targetFolderId, () =>
      this.performMoveTrackToCloud(trackId, targetFolderId, dispositionOverride))
  }

  private async performMoveTrackToCloud(
    trackId: number,
    targetFolderId: number,
    dispositionOverride?: CloudMoveDisposition,
  ): Promise<void> {
    const track = this.repos.tracks.getById(trackId)
    if (!track) throw new Error(`Track ${trackId} does not exist.`)
    if (track.provider !== 'local') throw new Error('Only a local track can be moved to OneDrive.')
    const source = this.repos.folders.getById(track.folder_id)
    const target = this.repos.folders.getById(targetFolderId)
    if (
      !target ||
      target.provider !== 'onedrive' ||
      target.role !== 'library' ||
      !target.drive_id ||
      !target.item_id
    ) throw new Error('The destination must be a normal OneDrive library, not a backup.')
    const targetDriveId = target.drive_id

    assertCloudMoveAuthority({
      originalTrack: track,
      currentTrack: track,
      currentSource: source,
      originalTarget: target,
      currentTarget: target,
    })
    const localPath = requireLocalLibraryTrackPath({
      track,
      folder: source,
      expectedPath: track.path,
      label: 'Cloud move source',
    })
    const filename = track.filename || basename(localPath)
    const oldFolderId = track.folder_id
    let uploaded: UploadedItem | null = null
    let sourceSize = 0
    let recoveryHandled = false
    let moveCommitted = false
    try {
      this.emitMove({ trackId, phase: 'reading', uploaded: 0, total: 0 })
      const handle = await open(localPath, 'r')
      try {
        const before = await handle.stat()
        sourceSize = before.size
        if (sourceSize <= 0) throw new Error('Cannot move an empty audio file to OneDrive.')
        this.emitMove({ trackId, phase: 'uploading', uploaded: 0, total: sourceSize })
        const session = await this.client.createUploadSession({
          driveId: target.drive_id,
          parentItemId: target.item_id,
          filename,
          conflictBehavior: 'rename',
        })
        uploaded = await this.client.uploadResumable({
          uploadUrl: session.uploadUrl,
          sizeBytes: sourceSize,
          readChunk: async (offset, length) => {
            const buffer = Buffer.allocUnsafe(length)
            const { bytesRead } = await handle.read(buffer, 0, length, offset)
            return buffer.subarray(0, bytesRead)
          },
          onProgress: (uploadedBytes, total) => this.emitMove({
            trackId,
            phase: 'uploading',
            uploaded: uploadedBytes,
            total,
          }),
        })
        const after = await handle.stat()
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          throw new Error('The local source changed while it was being uploaded.')
        }
      } finally {
        await handle.close()
      }
      if (!uploaded) throw new Error('OneDrive upload completed without an item identity.')
      const uploadedItem = uploaded

      this.emitMove({
        trackId,
        phase: 'finalizing',
        uploaded: sourceSize,
        total: sourceSize,
      })

      const currentTrack = this.repos.tracks.getById(trackId)
      const currentSource = currentTrack
        ? this.repos.folders.getById(currentTrack.folder_id)
        : null
      const currentTarget = this.repos.folders.getById(targetFolderId)
      assertCloudMoveAuthority({
        originalTrack: track,
        currentTrack,
        currentSource,
        originalTarget: target,
        currentTarget,
      })
      if (
        !currentTrack ||
        !currentSource ||
        !currentTarget ||
        !currentTarget.drive_id ||
        !currentTarget.item_id
      ) throw new Error('Cloud move authority was lost before commit.')
      requireLocalLibraryTrackPath({
        track: currentTrack,
        folder: currentSource,
        expectedPath: track.path,
        label: 'Cloud move source',
      })

      const updateMove = this.db.transaction(() => {
        const result = this.db.prepare(`
          UPDATE tracks SET
            path = ?, filename = ?, folder_id = ?, file_size = ?, provider = 'onedrive',
            drive_id = ?, item_id = ?, etag = ?, remote_path = ?, quickxor_hash = ?
          WHERE id = ? AND provider = 'local' AND folder_id = ? AND path = ?
            AND EXISTS (
              SELECT 1 FROM folders source
              WHERE source.id = tracks.folder_id
                AND source.provider = 'local' AND source.role = 'library'
            )
            AND EXISTS (
              SELECT 1 FROM folders destination
              WHERE destination.id = ? AND destination.provider = 'onedrive'
                AND destination.role = 'library'
                AND destination.drive_id = ? AND destination.item_id = ?
            )
        `).run(
          `onedrive://${currentTarget.drive_id}/${uploadedItem.id}`,
          uploadedItem.name || filename,
          currentTarget.id,
          uploadedItem.size || sourceSize,
          currentTarget.drive_id,
          uploadedItem.id,
          uploadedItem.etag,
          posix.join(currentTarget.remote_path ?? '/', uploadedItem.name || filename),
          uploadedItem.quickXorHash,
          trackId,
          oldFolderId,
          track.path,
          currentTarget.id,
          currentTarget.drive_id,
          currentTarget.item_id,
        )
        if (result.changes !== 1) {
          throw new Error('The local track or destination changed before the move could commit.')
        }
        this.repos.folders.updateTrackCount(
          currentTarget.id,
          this.repos.tracks.countByFolder(currentTarget.id),
        )
        this.repos.folders.updateTrackCount(oldFolderId, this.repos.tracks.countByFolder(oldFolderId))
      })
      updateMove.immediate()

      const disposition = dispositionOverride ?? getOneDriveCredentialStore().getPrefs().moveDisposition
      try {
        await this.disposeLocalOriginal(localPath, disposition)
      } catch (disposalError) {
        recoveryHandled = true
        let rollbackError: Error | null = null
        try {
          this.rollbackCloudMove(track, currentTarget, uploadedItem)
        } catch (error) {
          rollbackError = error as Error
        }

        let cleanupError: Error | null = null
        if (!rollbackError) {
          try {
            await this.cleanupUploadedItem(currentTarget.drive_id, uploadedItem)
          } catch (error) {
            cleanupError = error as Error
          }
        }
        const details = [
          `The local original could not be ${disposition === 'trash' ? 'moved to Trash' : 'deleted'}: ${(disposalError as Error).message}.`,
          rollbackError
            ? `Database rollback failed; the cloud row and uploaded item were preserved for recovery: ${rollbackError.message}.`
            : 'The track was restored as local in the catalog.',
          cleanupError
            ? `The uploaded OneDrive item could not be recycled and requires manual cleanup: ${cleanupError.message}.`
            : rollbackError ? '' : 'The uploaded OneDrive item was moved to the recycle bin.',
        ].filter(Boolean).join(' ')
        throw new Error(details, { cause: disposalError })
      }
      moveCommitted = true
      getLibraryBackup().scheduleWriteForFolder(oldFolderId)
      getCloudManifestService().scheduleWriteForFolder(currentTarget.id)
      this.emitMove({
        trackId,
        phase: 'done',
        uploaded: sourceSize,
        total: sourceSize,
      })
      broadcast('library:changed', { reason: 'cloud-move', trackId })
    } catch (error) {
      if (uploaded && !moveCommitted && !recoveryHandled) {
        try {
          await this.cleanupUploadedItem(targetDriveId, uploaded)
        } catch (cleanupError) {
          error = new Error(
            `${(error as Error).message} The uploaded OneDrive item could not be recycled: ${(cleanupError as Error).message}`,
            { cause: error },
          )
        }
      }
      this.emitMove({
        trackId,
        phase: 'error',
        uploaded: 0,
        total: 0,
        message: (error as Error).message,
      })
      throw error
    }
  }

  private async disposeLocalOriginal(path: string, disposition: CloudMoveDisposition): Promise<void> {
    if (disposition === 'trash') await shell.trashItem(path)
    else if (disposition === 'delete') await unlink(path)
    else if (disposition === 'ask') throw new Error('A local-file disposition must be selected first.')
  }

  private rollbackCloudMove(track: DbTrack, target: DbFolder, uploaded: UploadedItem): void {
    const rollback = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE tracks SET
          path = ?, filename = ?, folder_id = ?, file_size = ?, provider = ?,
          drive_id = ?, item_id = ?, etag = ?, remote_path = ?, quickxor_hash = ?
        WHERE id = ? AND provider = 'onedrive' AND folder_id = ?
          AND drive_id = ? AND item_id = ?
      `).run(
        track.path,
        track.filename,
        track.folder_id,
        track.file_size,
        track.provider,
        track.drive_id,
        track.item_id,
        track.etag,
        track.remote_path,
        track.quickxor_hash,
        track.id,
        target.id,
        target.drive_id,
        uploaded.id,
      )
      if (result.changes !== 1) {
        throw new Error('The cloud catalog row changed before rollback.')
      }
      this.repos.folders.updateTrackCount(track.folder_id, this.repos.tracks.countByFolder(track.folder_id))
      this.repos.folders.updateTrackCount(target.id, this.repos.tracks.countByFolder(target.id))
    })
    rollback.immediate()
  }

  private async cleanupUploadedItem(driveId: string, uploaded: UploadedItem): Promise<void> {
    try {
      await this.client.deleteItem({
        driveId,
        itemId: uploaded.id,
        ifMatch: uploaded.etag ?? undefined,
      })
    } catch (error) {
      if (error instanceof CloudHttpError && error.status === 404) return
      throw error
    }
  }

  startPolling(intervalMs = POLL_INTERVAL_MS): void {
    if (this.pollTimer) return
    void this.syncAllCloudFolders()
    this.pollTimer = setInterval(() => void this.syncAllCloudFolders(), intervalMs)
  }

  stopPolling(): void {
    if (!this.pollTimer) return
    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  async syncAllCloudFolders(): Promise<void> {
    for (const folder of this.repos.folders.listAll()) {
      if (folder.provider !== 'onedrive') continue
      try {
        if (folder.role === 'library') await this.resyncFolder(folder.id)
        else await this.pollBackupFolder(folder.id)
      } catch (error) {
        console.warn(`[cloud] sync failed for ${folder.role} ${folder.id}:`, (error as Error).message)
      }
    }
  }

  /** Advances a backup destination's delta cursor without ever indexing its
   * contents. Any destination-side change asks the mirror to run a fresh
   * three-way comparison, so independent edits become an approval batch. */
  async pollBackupFolder(folderId: number): Promise<boolean> {
    assertLibraryLocationMigrationUnlocked(folderId, 'el polling del backup OneDrive')
    return this.withFolderLock(folderId, async () => {
      const folder = await this.refreshOneDriveRoot(folderId, 'backup')
      let deltaCursor: string | null = null
      let changed = false
      let reset = false
      for await (const page of this.client.listDelta(
        folder.drive_id!,
        folder.item_id!,
        folder.delta_cursor,
      )) {
        if (page.items.length > 0) changed = true
        if (page.reset) reset = true
        if (page.deltaLink) deltaCursor = page.deltaLink
      }
      if (!deltaCursor) throw new Error('OneDrive backup inventory completed without a delta cursor.')

      const current = this.repos.folders.getById(folderId)
      if (
        !current ||
        current.provider !== 'onedrive' ||
        current.role !== 'backup' ||
        current.drive_id !== folder.drive_id ||
        current.item_id !== folder.item_id
      ) throw new Error(`Location ${folderId} stopped being a OneDrive backup during polling.`)
      const cursorUpdate = this.db.prepare(`
        UPDATE folders SET delta_cursor = ?, date_updated = datetime('now')
        WHERE id = ? AND provider = 'onedrive' AND role = 'backup'
          AND drive_id = ? AND item_id = ?
      `).run(deltaCursor, folderId, folder.drive_id, folder.item_id)
      if (cursorUpdate.changes !== 1) {
        throw new Error(`OneDrive backup ${folderId} changed before its cursor could be saved.`)
      }
      if (changed || reset) scheduleMirrorForBackupDestination(folderId, 'cloud_delta', 0)
      return changed || reset
    })
  }

  private async refreshOneDriveRoot(
    folderId: number,
    role: DbFolder['role'],
  ): Promise<AuthorizedOneDriveFolder> {
    const folder = this.repos.folders.getById(folderId)
    if (
      !folder ||
      folder.provider !== 'onedrive' ||
      folder.role !== role ||
      !folder.drive_id ||
      !folder.item_id
    ) throw new Error(`Location ${folderId} is not a OneDrive ${role}.`)

    const root = await this.client.getItem(folder.drive_id, folder.item_id)
    const current = this.repos.folders.getById(folderId)
    if (
      !current ||
      current.provider !== 'onedrive' ||
      current.role !== role ||
      current.drive_id !== folder.drive_id ||
      current.item_id !== folder.item_id
    ) throw new Error(`OneDrive ${role} ${folderId} changed while refreshing its root.`)
    const remotePath = normalizedRemotePath(driveItemRemotePath(root))
    if (current.remote_path !== remotePath) {
      const update = this.db.prepare(`
        UPDATE folders SET remote_path = ?, date_updated = datetime('now')
        WHERE id = ? AND provider = 'onedrive' AND role = ?
          AND drive_id = ? AND item_id = ?
      `).run(remotePath, folderId, role, folder.drive_id, folder.item_id)
      if (update.changes !== 1) {
        throw new Error(`OneDrive ${role} ${folderId} changed before its root path could be saved.`)
      }
    }
    return {
      ...current,
      provider: 'onedrive',
      drive_id: current.drive_id,
      item_id: current.item_id,
      remote_path: remotePath,
    }
  }

  private emitSync(event: CloudSyncProgressEvent): void {
    broadcast('cloud:sync:progress', event)
  }

  private emitMove(event: CloudMoveProgressEvent): void {
    broadcast('cloud:move:progress', event)
  }

  private notifySyncComplete(result: CloudSyncResult): void {
    for (const listener of this.syncCompleteListeners) {
      void Promise.resolve(listener(result)).catch(error =>
        console.warn('[cloud] post-sync hook failed:', (error as Error).message),
      )
    }
  }
}

let instance: OneDriveLibraryService | null = null

export function getOneDriveLibraryService(): OneDriveLibraryService {
  if (!instance) instance = new OneDriveLibraryService()
  return instance
}
