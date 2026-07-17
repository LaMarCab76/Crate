import type { Database as BetterSqliteDatabase } from 'better-sqlite3'
import type { BackupAlbum, BackupArtist, BackupFile, BackupTrack } from '@shared/types/library-backup'
import type { DbFolder } from '@shared/types/db'
import { getDatabase } from '../db/database'
import { getRepos } from '../db/repositories'
import { broadcast } from '../ipc/events'
import { mergedPortableTrackState, portableTrackState } from '../services/libraryBackupSafety'
import { CloudHttpError, getOneDriveClient, type DriveItem, type OneDriveClient } from './OneDriveClient'
import {
  cloudRelativePath,
  isSafePortablePath,
  parsePortableLibraryManifest,
  stringifyPortableLibraryManifest,
} from './cloudPortableManifest'
import { samePortableLibraryState } from './cloudManifestState'
import { isLibraryLocationMigrationLocked } from '../library-migration/locationLocks'

const STATE_DIR = '.crate'
const MANIFEST_NAME = 'library.yaml'
const LEGACY_MANIFEST_NAME = 'crate-manifest.json'
const WRITE_DEBOUNCE_MS = 2_000

interface PortableTrackRow {
  id: number
  item_id: string | null
  remote_path: string | null
  play_count: number
  last_played_date: string | null
  is_favorite: number
  rating: number | null
  state_updated_at: number | null
}

interface LegacyCloudManifest {
  version: number
  tracks?: Array<{
    cloudItemId?: string
    isFavorite?: boolean
    playCount?: number
    rating?: number | null
    lastPlayedDate?: string | null
  }>
}

type PortableRead =
  | { status: 'missing'; stateFolder: DriveItem | null; manifestItem: DriveItem | null }
  | { status: 'invalid'; stateFolder: DriveItem; manifestItem: DriveItem }
  | { status: 'ready'; stateFolder: DriveItem; manifestItem: DriveItem; manifest: BackupFile }

export class CloudManifestService {
  private readonly client: OneDriveClient
  private readonly timers = new Map<number, NodeJS.Timeout>()
  private readonly writes = new Map<number, Promise<boolean>>()
  private readonly writeControllers = new Map<number, AbortController>()
  private readonly writeGenerations = new Map<number, number>()

  constructor(client = getOneDriveClient()) {
    this.client = client
  }

  private get db(): BetterSqliteDatabase {
    return getDatabase()
  }

  async importManifest(folderId: number): Promise<'missing' | 'invalid' | 'imported' | 'legacy'> {
    const folder = this.cloudLibrary(folderId)
    if (!folder) return 'missing'
    const portable = await this.readPortable(folder)
    if (portable.status === 'invalid') {
      console.warn(`[cloud] refusing invalid ${STATE_DIR}/${MANIFEST_NAME} for folder ${folderId}`)
      return 'invalid'
    }
    if (portable.status === 'ready') {
      const restored = this.mergePortable(folder, portable.manifest)
      if (restored > 0) broadcast('library:changed', { reason: 'cloud-manifest-import' })
      return 'imported'
    }

    const legacy = await this.client.downloadChildText(
      folder.drive_id!,
      folder.item_id!,
      LEGACY_MANIFEST_NAME,
    )
    if (!legacy) return 'missing'
    const restored = this.mergeLegacy(folder, legacy)
    if (restored > 0) broadcast('library:changed', { reason: 'cloud-manifest-import' })
    return restored >= 0 ? 'legacy' : 'invalid'
  }

  scheduleWriteForFolder(folderId: number): void {
    if (!this.cloudLibrary(folderId)) return
    const current = this.timers.get(folderId)
    if (current) clearTimeout(current)
    this.timers.set(folderId, setTimeout(() => {
      this.timers.delete(folderId)
      this.enqueueWrite(folderId)
    }, WRITE_DEBOUNCE_MS))
  }

  scheduleWriteForTrack(trackId: number): void {
    const row = this.db.prepare<[number], { folder_id: number; provider: string }>(`
      SELECT folder_id, provider FROM tracks WHERE id = ?
    `).get(trackId)
    if (row?.provider === 'onedrive') this.scheduleWriteForFolder(row.folder_id)
  }

  scheduleWriteForArtist(artistId: number): void {
    const rows = this.db.prepare<[number], { folder_id: number }>(`
      SELECT DISTINCT t.folder_id FROM tracks t JOIN folders f ON f.id = t.folder_id
      WHERE t.artist_id = ? AND t.provider = 'onedrive' AND f.role = 'library'
    `).all(artistId)
    for (const row of rows) this.scheduleWriteForFolder(row.folder_id)
  }

  scheduleWriteForAlbum(albumId: number): void {
    const rows = this.db.prepare<[number], { folder_id: number }>(`
      SELECT DISTINCT t.folder_id FROM tracks t JOIN folders f ON f.id = t.folder_id
      WHERE t.album_id = ? AND t.provider = 'onedrive' AND f.role = 'library'
    `).all(albumId)
    for (const row of rows) this.scheduleWriteForFolder(row.folder_id)
  }

  cancelForFolder(folderId: number): void {
    const timer = this.timers.get(folderId)
    if (timer) clearTimeout(timer)
    this.timers.delete(folderId)
    this.writeGenerations.set(folderId, this.writeGeneration(folderId) + 1)
    this.writeControllers.get(folderId)?.abort()
  }

  /** Reclassification calls can await this to guarantee that a manifest upload
   * has observed cancellation before the folder becomes a backup. */
  async cancelAndWaitForFolder(folderId: number): Promise<void> {
    this.cancelForFolder(folderId)
    const active = this.writes.get(folderId)
    if (active) await Promise.allSettled([active])
  }

  async flushAll(): Promise<void> {
    const folderIds = [...this.timers.keys()]
    for (const folderId of folderIds) {
      clearTimeout(this.timers.get(folderId)!)
      this.timers.delete(folderId)
      this.enqueueWrite(folderId)
    }
    await Promise.allSettled([...this.writes.values()])
  }

  private enqueueWrite(folderId: number): void {
    void this.writeManifest(folderId).catch(error => {
      if ((error as Error).name === 'AbortError') return
      console.warn(`[cloud] portable state write failed for folder ${folderId}:`, (error as Error).message)
    })
  }

  private writeGeneration(folderId: number): number {
    return this.writeGenerations.get(folderId) ?? 0
  }

  async writeManifest(folderId: number): Promise<boolean> {
    const generation = this.writeGeneration(folderId)
    const previous = this.writes.get(folderId) ?? Promise.resolve(false)
    const next = previous
      .catch(() => false)
      .then(async () => {
        if (generation !== this.writeGeneration(folderId)) return false
        const controller = new AbortController()
        this.writeControllers.set(folderId, controller)
        try {
          return await this.performWriteManifest(folderId, controller.signal, generation)
        } finally {
          if (this.writeControllers.get(folderId) === controller) {
            this.writeControllers.delete(folderId)
          }
        }
      })
      .finally(() => {
        if (this.writes.get(folderId) === next) this.writes.delete(folderId)
      })
    this.writes.set(folderId, next)
    return next
  }

  private async performWriteManifest(
    folderId: number,
    signal: AbortSignal,
    generation: number,
  ): Promise<boolean> {
    const folder = this.cloudLibrary(folderId)
    if (!folder) return false

    let portable = await this.readPortable(folder, signal)
    if (portable.status === 'invalid') {
      // Preserve unrecognized bytes for manual recovery instead of silently
      // replacing them with the local DB view.
      console.warn(`[cloud] not overwriting invalid ${STATE_DIR}/${MANIFEST_NAME}`)
      return false
    }

    let stateFolder = portable.stateFolder
    if (!stateFolder) {
      stateFolder = await this.ensureStateFolder(folder, signal)
      portable = { status: 'missing', stateFolder, manifestItem: null }
    }

    signal.throwIfAborted()
    if (generation !== this.writeGeneration(folderId)) return false
    const currentFolder = this.cloudLibrary(folderId)
    if (
      !currentFolder ||
      currentFolder.drive_id !== folder.drive_id ||
      currentFolder.item_id !== folder.item_id
    ) return false

    const now = new Date().toISOString()
    const existing = portable.status === 'ready' ? portable.manifest : null
    const candidate = this.buildPortable(
      currentFolder,
      existing?.createdAt ?? now,
      existing?.updatedAt ?? now,
    )
    if (existing && samePortableLibraryState(existing, candidate)) return false
    const manifest = this.buildPortable(
      currentFolder,
      portable.status === 'ready' ? portable.manifest.createdAt : now,
      now,
    )
    // The role/provider check is intentionally adjacent to the upload. The
    // AbortSignal closes the remaining race if reclassification starts now.
    signal.throwIfAborted()
    const uploadFolder = this.cloudLibrary(folderId)
    if (
      generation !== this.writeGeneration(folderId) ||
      !uploadFolder ||
      uploadFolder.drive_id !== currentFolder.drive_id ||
      uploadFolder.item_id !== currentFolder.item_id
    ) return false
    await this.client.uploadBuffer({
      driveId: uploadFolder.drive_id!,
      parentItemId: stateFolder.id,
      itemId: portable.manifestItem?.id,
      filename: MANIFEST_NAME,
      buffer: Buffer.from(stringifyPortableLibraryManifest(manifest), 'utf8'),
      conflictBehavior: 'replace',
      ifMatch: portable.manifestItem?.eTag ?? portable.manifestItem?.cTag,
      signal,
    })
    return true
  }

  private cloudLibrary(folderId: number): DbFolder | null {
    if (isLibraryLocationMigrationLocked(folderId)) return null
    const folder = getRepos().folders.getById(folderId)
    if (
      !folder ||
      folder.provider !== 'onedrive' ||
      folder.role !== 'library' ||
      !folder.drive_id ||
      !folder.item_id
    ) return null
    return folder
  }

  private async readPortable(folder: DbFolder, signal?: AbortSignal): Promise<PortableRead> {
    const children = await this.client.listChildren(folder.drive_id!, folder.item_id!, signal)
    const stateFolder = children.find(item => item.name === STATE_DIR && item.folder) ?? null
    if (!stateFolder) return { status: 'missing', stateFolder: null, manifestItem: null }

    const stateChildren = await this.client.listChildren(folder.drive_id!, stateFolder.id, signal)
    const manifestItem = stateChildren.find(item => item.name === MANIFEST_NAME && item.file) ?? null
    if (!manifestItem) return { status: 'missing', stateFolder, manifestItem: null }
    const text = await this.client.downloadChildText(
      folder.drive_id!,
      stateFolder.id,
      MANIFEST_NAME,
      signal,
    )
    const manifest = text == null ? null : parsePortableLibraryManifest(text)
    return manifest
      ? { status: 'ready', stateFolder, manifestItem, manifest }
      : { status: 'invalid', stateFolder, manifestItem }
  }

  private async ensureStateFolder(folder: DbFolder, signal?: AbortSignal): Promise<DriveItem> {
    try {
      return await this.client.createFolder({
        driveId: folder.drive_id!,
        parentItemId: folder.item_id!,
        name: STATE_DIR,
        conflictBehavior: 'fail',
        signal,
      })
    } catch (error) {
      if (!(error instanceof CloudHttpError) || error.status !== 409) throw error
      const children = await this.client.listChildren(folder.drive_id!, folder.item_id!, signal)
      const existing = children.find(item => item.name === STATE_DIR && item.folder)
      if (!existing) throw error
      return existing
    }
  }

  private buildPortable(folder: DbFolder, createdAt: string, updatedAt: string): BackupFile {
    const rows = this.db.prepare<[number], PortableTrackRow>(`
      SELECT id, item_id, remote_path, play_count, last_played_date,
             is_favorite, rating, state_updated_at
      FROM tracks
      WHERE folder_id = ? AND provider = 'onedrive'
    `).all(folder.id)

    const tracks: Record<string, BackupTrack> = {}
    for (const row of rows) {
      if (!row.remote_path) continue
      const relative = cloudRelativePath(folder.remote_path ?? '/', row.remote_path)
      const state = portableTrackState(row)
      if (relative && state) tracks[relative] = state
    }

    const artists: Record<string, BackupArtist> = {}
    const artistRows = this.db.prepare<
      [number],
      { name: string; is_favorite: number; state_updated_at: number | null }
    >(`
      SELECT DISTINCT a.name, a.is_favorite, a.state_updated_at
      FROM artists a JOIN tracks t ON t.artist_id = a.id
      WHERE t.folder_id = ? AND t.provider = 'onedrive'
    `).all(folder.id)
    for (const artist of artistRows) {
      if (!artist.is_favorite && !artist.state_updated_at) continue
      const state: BackupArtist = {}
      if (artist.state_updated_at) {
        state.favorite = Boolean(artist.is_favorite)
        state.stateUpdatedAt = new Date(artist.state_updated_at).toISOString()
      } else if (artist.is_favorite) state.favorite = true
      artists[artist.name] = state
    }

    const albums: Record<string, BackupAlbum> = {}
    const albumRows = this.db.prepare<
      [number],
      {
        title: string
        album_artist: string | null
        year: string | null
        is_favorite: number
        state_updated_at: number | null
      }
    >(`
      SELECT DISTINCT a.title, a.album_artist, a.year, a.is_favorite, a.state_updated_at
      FROM albums a JOIN tracks t ON t.album_id = a.id
      WHERE t.folder_id = ? AND t.provider = 'onedrive'
    `).all(folder.id)
    for (const album of albumRows) {
      if (!album.is_favorite && !album.state_updated_at) continue
      const state: BackupAlbum = {}
      if (album.state_updated_at) {
        state.favorite = Boolean(album.is_favorite)
        state.stateUpdatedAt = new Date(album.state_updated_at).toISOString()
      } else if (album.is_favorite) state.favorite = true
      albums[JSON.stringify([album.title, album.album_artist, album.year])] = state
    }

    return { version: 1, appName: 'Crate', createdAt, updatedAt, tracks, artists, albums }
  }

  private mergePortable(folder: DbFolder, manifest: BackupFile): number {
    const rows = this.db.prepare<[number], PortableTrackRow>(`
      SELECT id, item_id, remote_path, play_count, last_played_date,
             is_favorite, rating, state_updated_at
      FROM tracks
      WHERE folder_id = ? AND provider = 'onedrive'
    `).all(folder.id)
    const byRelative = new Map<string, PortableTrackRow>()
    for (const row of rows) {
      if (!row.remote_path) continue
      const relative = cloudRelativePath(folder.remote_path ?? '/', row.remote_path)
      if (relative) byRelative.set(relative, row)
    }

    const update = this.db.prepare(`
      UPDATE tracks
      SET play_count = ?, last_played_date = ?, is_favorite = ?, rating = ?, state_updated_at = ?
      WHERE id = ?
    `)
    let restored = 0
    const transaction = this.db.transaction(() => {
      for (const [relative, state] of Object.entries(manifest.tracks)) {
        if (!isSafePortablePath(relative) || !state || typeof state !== 'object') continue
        const row = byRelative.get(relative)
        if (!row) continue
        update.run(...mergedPortableTrackState(row, state), row.id)
        restored += 1
      }
      this.mergeArtists(manifest.artists)
      this.mergeAlbums(manifest.albums)
    })
    transaction()
    return restored
  }

  private mergeLegacy(folder: DbFolder, text: string): number {
    let manifest: LegacyCloudManifest
    try {
      manifest = JSON.parse(text) as LegacyCloudManifest
    } catch {
      return -1
    }
    if (manifest.version !== 1 || !Array.isArray(manifest.tracks)) return -1
    const find = this.db.prepare<
      [number, string, string],
      PortableTrackRow
    >(`
      SELECT id, item_id, remote_path, play_count, last_played_date,
             is_favorite, rating, state_updated_at
      FROM tracks
      WHERE folder_id = ? AND drive_id = ? AND item_id = ? AND provider = 'onedrive'
    `)
    const update = this.db.prepare(`
      UPDATE tracks
      SET play_count = ?, last_played_date = ?, is_favorite = ?, rating = ?, state_updated_at = ?
      WHERE id = ?
    `)
    let restored = 0
    const transaction = this.db.transaction(() => {
      for (const state of manifest.tracks ?? []) {
        if (!state.cloudItemId) continue
        const row = find.get(folder.id, folder.drive_id!, state.cloudItemId)
        if (!row) continue
        const portable: BackupTrack = {
          favorite: state.isFavorite,
          playCount: state.playCount,
          rating: state.rating,
          lastPlayedAt: state.lastPlayedDate,
        }
        update.run(...mergedPortableTrackState(row, portable), row.id)
        restored += 1
      }
    })
    transaction()
    return restored
  }

  private mergeArtists(artists: Record<string, BackupArtist>): void {
    const find = this.db.prepare<
      [string],
      { id: number; is_favorite: number; state_updated_at: number | null }
    >(`SELECT id, is_favorite, state_updated_at FROM artists WHERE name = ?`)
    const update = this.db.prepare(`UPDATE artists SET is_favorite = ?, state_updated_at = ? WHERE id = ?`)
    for (const [name, state] of Object.entries(artists)) {
      const row = find.get(name)
      if (!row || !state || typeof state !== 'object') continue
      const timestamp = state.stateUpdatedAt ? Date.parse(state.stateUpdatedAt) || 0 : 0
      if (timestamp > (row.state_updated_at ?? 0) && state.favorite !== undefined) {
        update.run(state.favorite ? 1 : 0, timestamp, row.id)
      }
    }
  }

  private mergeAlbums(albums: Record<string, BackupAlbum>): void {
    const find = this.db.prepare<
      [string, string | null, string | null],
      { id: number; is_favorite: number; state_updated_at: number | null }
    >(`
      SELECT id, is_favorite, state_updated_at FROM albums
      WHERE title = ? AND album_artist IS ? AND year IS ?
    `)
    const update = this.db.prepare(`UPDATE albums SET is_favorite = ?, state_updated_at = ? WHERE id = ?`)
    for (const [key, state] of Object.entries(albums)) {
      if (!state || typeof state !== 'object') continue
      let identity: unknown
      try { identity = JSON.parse(key) } catch { continue }
      if (!Array.isArray(identity) || typeof identity[0] !== 'string') continue
      const artist = identity[1] == null ? null : String(identity[1])
      const year = identity[2] == null ? null : String(identity[2])
      const row = find.get(identity[0], artist, year)
      if (!row) continue
      const timestamp = state.stateUpdatedAt ? Date.parse(state.stateUpdatedAt) || 0 : 0
      if (timestamp > (row.state_updated_at ?? 0) && state.favorite !== undefined) {
        update.run(state.favorite ? 1 : 0, timestamp, row.id)
      }
    }
  }
}

let instance: CloudManifestService | null = null

export function getCloudManifestService(): CloudManifestService {
  if (!instance) instance = new CloudManifestService()
  return instance
}
