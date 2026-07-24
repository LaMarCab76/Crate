import { BrowserWindow, dialog, shell } from 'electron'
import { secureIpcMain as ipcMain } from './secureIpc'
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { getRepos, type Repos } from '../db/repositories'
import { getImportService } from '../library/ImportService'
import { getFolderWatcher } from '../library/FolderWatcher'
import { getLibraryReconciler } from '../library/LibraryReconciler'
import { parseArtistName } from '../library/ArtistNameParser'
import { readTrackMetadata, serializeTrackExtendedMetadata } from '../library/MetadataExtractor'
import { getMetadataCompletionService } from '../library/MetadataCompletionService'
import { getTrackAlbumMoveService } from '../library/TrackAlbumMoveService'
import { trashTrackBatch } from '../library/TrackTrashBatch'
import { writeTrackMetadata } from '../library/MetadataWriter'
import { getLibraryBackup } from '../services/LibraryBackup'
import { getCloudManifestService } from '../cloud/CloudManifestService'
import { getDuplicateDecisionPortableService } from '../duplicates/DuplicateDecisionPortableService'
import { getOneDriveLibraryService } from '../cloud/OneDriveLibraryService'
import { getPathAuthorizationService } from '../security/PathAuthorizationService'
import { getLocalFileAccessService } from '../security/localFileAccessRuntime'
import { sidecarPathFor } from '../lyrics/providers/SidecarLrcProvider'
import { broadcast } from './events'
import { assertId, assertNonEmptyString, sanitizeIds } from './validation'
import type { DbTrack } from '@shared/types/db'
import type {
  AddFolderResult,
  ListTracksOpts,
  PickFolderResult,
  RemoveFolderOptions,
  SearchResultsPayload,
  MetadataCompletionApplyRequest,
  TrackMetadataUpdatePayload,
  TrashTracksResult,
} from '@shared/types/ipc-contract'

function normText(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function resolveAlbumFromFolderHints(track: DbTrack, candidates: DbTrack[]): number | null {
  if (candidates.length === 0) return null

  const albumName = normText(track.album)
  const albumArtist = normText(track.album_artist) || normText(track.artist)

  const withMatchingAlbum = candidates.filter(c => normText(c.album) === albumName)
  const albumIds = new Set(withMatchingAlbum.map(t => t.album_id).filter((id): id is number => id != null))
  if (albumIds.size === 1) {
    const [singleId] = albumIds
    return singleId
  }

  const withMatchingAlbumAndArtist = withMatchingAlbum.filter(t => (normText(t.artist) === albumArtist))
  const albumArtistIds = new Set(withMatchingAlbumAndArtist.map(t => t.album_id).filter((id): id is number => id != null))
  if (albumArtistIds.size === 1) {
    const [singleId] = albumArtistIds
    return singleId
  }

  const counts = new Map<number, number>()
  for (const candidate of candidates) {
    if (candidate.album_id == null) continue
    counts.set(candidate.album_id, (counts.get(candidate.album_id) ?? 0) + 1)
  }
  if (counts.size === 0) return null

  let topId: number | null = null
  let topCount = 0
  let secondCount = 0

  for (const [albumId, count] of counts.entries()) {
    if (count > topCount) {
      secondCount = topCount
      topCount = count
      topId = albumId
    } else if (count > secondCount) {
      secondCount = count
    }
  }

  if (topId == null) return null
  return topCount > secondCount ? topId : null
}

async function refreshTrackMetadataInDb(repos: Repos, trackId: number): Promise<DbTrack | null> {
  const track = repos.tracks.getById(trackId)
  if (!track) return null
  if (track.provider !== 'local') throw new Error('Metadata operations are unavailable for cloud tracks')

  const md = await readTrackMetadata(track.path)
  const parsedArtist = parseArtistName(md.artist)
  const artist = repos.artists.getOrCreate(parsedArtist.primary || md.artist)
  const genre = md.genre ? repos.genres.getOrCreate(md.genre) : null

  const candidateRefs = repos.tracks.getByFolderWithAlbum(track.folder_id)
  const metadataHint = {
    ...track,
    album: md.album,
    artist: md.artist,
    album_artist: md.albumArtist,
  }
  const candidateAlbum = resolveAlbumFromFolderHints(metadataHint, candidateRefs)
  const resolvedAlbum = repos.albums.getOrCreate(md.album, md.albumArtist ?? null, md.year || null)
  repos.albums.enrichReleaseMetadata(resolvedAlbum.id, md)
  const targetAlbumId = candidateAlbum ?? resolvedAlbum.id

  repos.tracks.updateMetadata({
    id: track.id,
    title: md.title,
    artist: md.artist,
    album: md.album,
    albumArtist: md.albumArtist,
    composer: md.composer,
    genre: md.genre,
    year: md.year,
    trackNumber: md.trackNumber,
    totalTracks: md.totalTracks,
    discNumber: md.discNumber,
    totalDiscs: md.totalDiscs,
    compilation: md.isCompilation ? 1 : 0,
    releaseDate: md.releaseDate,
    originalReleaseDate: md.originalReleaseDate,
    mediaType: md.mediaType,
    extendedMetadata: serializeTrackExtendedMetadata(md),
    duration: md.duration,
    format: md.format,
    codec: md.codec,
    bitrate: md.bitrate,
    sampleRate: md.sampleRate,
    channels: md.channels,
    bitDepth: md.bitDepth,
    fileSize: md.fileSize,
    bpm: md.bpm,
    musicalKey: md.musicalKey,
    dateModified: md.dateModified,
    artworkPath: md.artwork?.filename ?? track.artwork_path,
    filename: basename(track.path),
    artistId: artist.id,
    albumId: targetAlbumId,
    genreId: genre?.id ?? null,
  })

  getLibraryBackup().scheduleWriteForTrack(track.id)
  return repos.tracks.getById(track.id) ?? track
}

export function registerLibraryChannel(): void {
  const repos = getRepos()
  const importer = getImportService()
  const watcher = getFolderWatcher()
  const reconciler = getLibraryReconciler()
  const metadataCompletion = getMetadataCompletionService()
  const albumMove = getTrackAlbumMoveService()

  ipcMain.handle('library:tracks', (_, opts: ListTracksOpts = {}) => repos.tracks.getAll(opts))
  ipcMain.handle('library:track:byId', (_, id: number) => repos.tracks.getById(id) ?? null)
  ipcMain.handle('library:track:count', () => repos.tracks.count())

  ipcMain.handle('library:albums', () => repos.albums.getAll())
  ipcMain.handle('library:album:byId', (_, id: number) => repos.albums.getById(id) ?? null)
  ipcMain.handle('library:album:tracks', (_, id: number) => repos.entityTracks.getTracksForAlbum(id))

  ipcMain.handle('library:artists', () => repos.artists.getAll())
  ipcMain.handle('library:artist:byId', (_, id: number) => repos.artists.getById(id) ?? null)
  ipcMain.handle('library:artist:tracks', (_, id: number) => repos.entityTracks.getTracksForArtist(id))

  ipcMain.handle('library:genres', () => repos.genres.getAll())
  ipcMain.handle('library:genre:tracks', (_, id: number) => repos.entityTracks.getTracksForGenre(id))

  ipcMain.handle('library:playlists', () => repos.playlists.list())
  ipcMain.handle('library:playlist:byId', (_, id: number) => repos.playlists.getById(id) ?? null)
  ipcMain.handle('library:playlist:tracks', (_, id: number) =>
    repos.entityTracks.getTracksForPlaylist(id),
  )
  ipcMain.handle('library:playlist:create', (_, p: { name: string; description?: string; isSmart?: boolean }) =>
    repos.playlists.create(p.name, p.description ?? null, p.isSmart === true),
  )
  ipcMain.handle('library:playlist:delete', (_, id: number) => {
    repos.playlists.delete(id)
    broadcast('library:changed', { reason: 'playlist-delete' })
  })
  ipcMain.handle('library:playlist:addTracks', (_, p: { playlistId: number; trackIds: number[] }) => {
    const playlistId = assertId(p?.playlistId, 'playlistId')
    const trackIds = sanitizeIds(p?.trackIds)
    if (trackIds.length === 0) return
    repos.playlists.addTracks(playlistId, trackIds)
    broadcast('library:changed', { reason: 'playlist-tracks' })
  })

  ipcMain.handle('library:search', (_, query: string, limit?: number): SearchResultsPayload =>
    repos.search.search(query, limit ?? 20),
  )

  ipcMain.handle('library:folders', () => repos.folders.list().filter(folder => folder.role === 'library'))
  ipcMain.handle('library:folders:remove', async (event, id: number, options?: RemoveFolderOptions) => {
    const folderId = assertId(id, 'folderId')
    const folder = repos.folders.getById(folderId)
    if (!folder) throw new Error('La carpeta ya no existe en la biblioteca.')
    if (folder.backup_source_folder_id != null) {
      throw new Error('Desvinculá o promové este backup antes de quitarlo.')
    }
    if (repos.folders.listAll().some(candidate => candidate.backup_source_folder_id === folderId)) {
      throw new Error('Esta biblioteca tiene un backup vinculado. Desvinculalo o promovelo primero.')
    }

    const deleteMusic = options?.deleteMusic === true
    if (deleteMusic && folder.provider !== 'local') {
      throw new Error('Los archivos de una biblioteca cloud no se eliminan desde esta acción.')
    }
    const folderPath = folder.provider === 'local' ? resolve(folder.path) : folder.path
    if (deleteMusic) {
      watcher.stop(folderId)
      try {
        await getLocalFileAccessService().runWithAccess(
          folderPath,
          'write',
          () => shell.trashItem(folderPath),
          { owner: BrowserWindow.fromWebContents(event.sender) ?? undefined },
        )
      } catch (err) {
        watcher.start(folderId, folder.path)
        throw new Error(`No se pudo mover la carpeta a Papelera: ${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      watcher.stop(folderId)
    }

    getLibraryBackup().cancelForFolder(folderId)
    if (folder.provider === 'onedrive') await getOneDriveLibraryService().waitForFolderIdle(folderId)
    repos.folders.remove(folderId)
    broadcast('library:changed', { reason: 'folder-remove' })
  })

  ipcMain.handle('library:folders:pick', async (): Promise<PickFolderResult> => {
    const result = await dialog.showOpenDialog({
      title: 'Add music folder',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, token: null, displayPath: null }
    }
    const displayPath = resolve(result.filePaths[0])
    const token = getPathAuthorizationService().issue(displayPath, ['library:add'])
    return { canceled: false, token, displayPath }
  })

  ipcMain.handle('library:folders:add', async (event, token: unknown): Promise<AddFolderResult> => {
    const folderPath = getPathAuthorizationService().resolve(
      assertNonEmptyString(token, 'folder authorization'),
      'library:add',
      { consume: true },
    )
    const result = await getLocalFileAccessService().runWithAccess(
      folderPath,
      'read',
      () => importer.addFolder(folderPath),
      {
        owner: BrowserWindow.fromWebContents(event.sender) ?? undefined,
        retryOnce: false,
      },
    )
    watcher.start(result.folder.id, result.folder.path)
    reconciler.scheduleFolderScan(result.folder.id, 'import', 0)
    broadcast('library:changed', { reason: 'folder-add' })
    return result
  })

  ipcMain.handle('library:scanNow', async (event, folderId?: number) => {
    if (folderId != null) {
      const safeFolderId = assertId(folderId, 'folderId')
      const folder = repos.folders.getById(safeFolderId)
      if (!folder) throw new Error('La biblioteca ya no existe.')
      if (folder.provider !== 'local') return reconciler.scanFolder(safeFolderId, 'manual')
      return getLocalFileAccessService().runWithAccess(
        folder.path,
        'read',
        () => reconciler.scanFolder(safeFolderId, 'manual'),
        { owner: BrowserWindow.fromWebContents(event.sender) ?? undefined },
      )
    }
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
    for (const folder of repos.folders.list().filter(item => item.provider === 'local')) {
      const access = await getLocalFileAccessService().inspect(folder.path)
      if (access.state === 'permission_required') {
        await getLocalFileAccessService().runWithAccess(folder.path, 'read', async () => undefined, { owner })
      }
    }
    const runs = await reconciler.scanAll('manual')
    if (runs.length === 0) throw new Error('No library folders configured')
    return runs[0]
  })

  ipcMain.handle('library:scanLog', (_, folderId?: number, limit?: number) => {
    const safeFolderId = folderId == null ? null : assertId(folderId, 'folderId')
    const safeLimit = Number.isInteger(limit) && (limit as number) > 0 ? (limit as number) : 200
    return reconciler.scanLog(safeFolderId, safeLimit)
  })

  // Queue persistence
  ipcMain.handle('queue:save', (_, payload: { trackIds: number[]; currentIndex: number; shuffle: boolean; repeat: 'off' | 'all' | 'one' }) => {
    const repeat = payload.repeat === 'all' || payload.repeat === 'one' ? payload.repeat : 'off'
    repos.queue.save(payload.trackIds, payload.currentIndex, payload.shuffle === true, repeat)
  })
  ipcMain.handle('queue:load', () => repos.queue.load())

  // Track plays. Threshold (30s) is decided by the renderer — main just
  // increments and notifies subscribers so the UI refreshes.
  ipcMain.handle('track:countPlay', (_, trackId: number) => {
    repos.tracks.updatePlays(trackId)
    getLibraryBackup().scheduleWriteForTrack(trackId)
    getCloudManifestService().scheduleWriteForTrack(trackId)
    broadcast('library:changed', { reason: 'play-count' })
  })

  ipcMain.handle('track:setFavorite', (_, payload: { id: number; favorite: boolean }) => {
    repos.tracks.setFavorite(payload.id, payload.favorite)
    getLibraryBackup().scheduleWriteForTrack(payload.id)
    getCloudManifestService().scheduleWriteForTrack(payload.id)
    broadcast('library:changed', { reason: 'track-favorite' })
  })

  ipcMain.handle('album:setFavorite', (_, payload: { id: number; favorite: boolean }) => {
    repos.albums.setFavorite(payload.id, payload.favorite)
    getLibraryBackup().scheduleWriteForAlbum(payload.id)
    getCloudManifestService().scheduleWriteForAlbum(payload.id)
    broadcast('library:changed', { reason: 'album-favorite' })
  })

  ipcMain.handle('track:updateMetadata', async (event, payload: { trackId: number; metadata: TrackMetadataUpdatePayload }) => {
    const track = repos.tracks.getById(payload.trackId)
    if (!track) return
    if (track.provider !== 'local') throw new Error('Metadata editing is unavailable for cloud tracks')

    const folder = repos.folders.getById(track.folder_id)
    if (!folder || folder.provider !== 'local') throw new Error('La biblioteca local ya no existe.')
    await getLocalFileAccessService().runWithAccess(folder.path, 'write', async () => {
      writeTrackMetadata(track.path, payload.metadata)
      await refreshTrackMetadataInDb(repos, track.id)
    }, { owner: BrowserWindow.fromWebContents(event.sender) ?? undefined })
    broadcast('library:changed', { reason: 'track-metadata-update' })
  })

  ipcMain.handle('track:refreshMetadata', async (event, trackId: number) => {
    const track = repos.tracks.getById(trackId)
    if (track?.provider !== 'local') throw new Error('Metadata refresh is unavailable for cloud tracks')
    if (!track) return
    const folder = repos.folders.getById(track.folder_id)
    if (!folder || folder.provider !== 'local') throw new Error('La biblioteca local ya no existe.')
    await getLocalFileAccessService().runWithAccess(
      folder.path,
      'read',
      () => refreshTrackMetadataInDb(repos, trackId),
      { owner: BrowserWindow.fromWebContents(event.sender) ?? undefined },
    )
    broadcast('library:changed', { reason: 'track-refresh' })
  })

  ipcMain.handle('track:metadataCompletion:targets', async (_, payload?: { folderId?: number; limit?: number }) => {
    const folderId = payload?.folderId == null ? null : assertId(payload.folderId, 'folderId')
    const limit = Number.isInteger(payload?.limit) && (payload?.limit as number) > 0 ? payload?.limit as number : 24
    return metadataCompletion.findTargets(folderId, limit)
  })

  ipcMain.handle('track:metadataCompletion:preview', async (_, trackIds: number[]) => {
    return metadataCompletion.preview(sanitizeIds(trackIds))
  })

  ipcMain.handle('track:metadataCompletion:apply', async (event, payload: MetadataCompletionApplyRequest) => {
    const selections = Array.isArray(payload?.selections)
      ? payload.selections.map(selection => ({
          trackId: assertId(selection.trackId, 'trackId'),
          fields: Array.isArray(selection.fields) ? selection.fields : [],
        }))
      : []
    const roots = new Set<string>()
    for (const selection of selections) {
      const track = repos.tracks.getById(selection.trackId)
      const folder = track ? repos.folders.getById(track.folder_id) : null
      if (track?.provider === 'local' && folder?.provider === 'local') roots.add(folder.path)
    }
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
    for (const root of roots) {
      await getLocalFileAccessService().runWithAccess(root, 'write', async () => undefined, { owner })
    }
    const result = await metadataCompletion.apply({
      previewId: assertNonEmptyString(payload?.previewId, 'previewId'),
      selections,
    })
    if (result.applied > 0) broadcast('library:changed', { reason: 'metadata-completion' })
    return result
  })

  ipcMain.handle('track:albumMove:preview', async (event, payload: { trackId: number; targetAlbumId: number; trackNumber?: number | null }) => {
    const trackNumber = Number.isInteger(payload?.trackNumber) && (payload!.trackNumber as number) > 0
      ? (payload!.trackNumber as number)
      : null
    const trackId = assertId(payload?.trackId, 'trackId')
    const track = repos.tracks.getById(trackId)
    const folder = track ? repos.folders.getById(track.folder_id) : null
    const operation = () => albumMove.preview(
      trackId,
      assertId(payload?.targetAlbumId, 'targetAlbumId'),
      trackNumber,
    )
    if (track?.provider !== 'local' || folder?.provider !== 'local') return operation()
    return getLocalFileAccessService().runWithAccess(
      folder.path,
      'read',
      operation,
      { owner: BrowserWindow.fromWebContents(event.sender) ?? undefined },
    )
  })

  ipcMain.handle('track:albumMove:apply', async (event, payload: { previewId: string; confirmLowerQualityReplace?: boolean }) => {
    const previewId = assertNonEmptyString(payload?.previewId, 'previewId')
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const roots = albumMove.accessRootsForPreview(previewId)
    for (const root of roots) {
      await getLocalFileAccessService().runWithAccess(root, 'write', async () => undefined, { owner })
    }
    const result = await albumMove.apply(previewId, payload?.confirmLowerQualityReplace === true)
    broadcast('library:changed', { reason: 'track-album-move' })
    return result
  })

  ipcMain.handle('track:trash', async (event, trackIds: number[]): Promise<TrashTracksResult> => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = await trashTrackBatch(trackIds, {
      getTrack: trackId => repos.tracks.getById(trackId),
      getLocalRoot: folderId => {
        const folder = repos.folders.getById(folderId)
        return folder?.provider === 'local' ? folder.path : null
      },
      runWithWriteAccess: (rootPath, operation) => getLocalFileAccessService().runWithAccess(
        rootPath, 'write', operation, { owner },
      ),
      trashItem: path => shell.trashItem(path),
      deleteTrack: trackId => repos.tracks.deleteById(trackId),
      sidecarPath: sidecarPathFor,
      sidecarExists: existsSync,
      onSidecarError: (path, error) => {
        console.warn(`[track-trash] failed to trash sidecar ${path}:`, error instanceof Error ? error.message : String(error))
      },
    })

    for (const folderId of result.affectedFolderIds) {
      repos.folders.updateTrackCount(folderId, repos.tracks.countByFolder(folderId))
      getLibraryBackup().scheduleWriteForFolder(folderId)
    }

    if (result.trashedTrackIds.length > 0) {
      broadcast('library:changed', { reason: 'track-trash' })
    }

    return { trashedTrackIds: result.trashedTrackIds, failed: result.failed }
  })

  ipcMain.handle('artist:setFavorite', (_, payload: { id: number; favorite: boolean }) => {
    repos.artists.setFavorite(payload.id, payload.favorite)
    getLibraryBackup().scheduleWriteForArtist(payload.id)
    getCloudManifestService().scheduleWriteForArtist(payload.id)
    broadcast('library:changed', { reason: 'artist-favorite' })
  })

  // Renderer-side preference push. The renderer reads its tweak from
  // localStorage on boot and forwards it here so the backup service knows
  // whether to write.
  ipcMain.handle('settings:setLibraryBackup', (_, enabled: boolean) => {
    getLibraryBackup().setEnabled(enabled)
    getDuplicateDecisionPortableService().setEnabled(enabled)
  })
  ipcMain.handle('settings:setLibraryScanLogRetention', (_, days: number | null) => {
    reconciler.setRetentionDays(days)
  })
}
