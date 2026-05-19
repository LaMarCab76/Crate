import { dialog, ipcMain } from 'electron'
import { basename } from 'node:path'
import { getRepos } from '../db/repositories'
import { getImportService } from '../library/ImportService'
import { getFolderWatcher } from '../library/FolderWatcher'
import { parseArtistName } from '../library/ArtistNameParser'
import { readTrackMetadata } from '../library/MetadataExtractor'
import { fetchLyrics } from '../services/lyrics'
import { getLibraryBackup } from '../services/LibraryBackup'
import { broadcast } from './events'
import type { DbTrack } from '@shared/types/db'
import type {
  AddFolderResult,
  ListTracksOpts,
  PickFolderResult,
  SearchResultsPayload,
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

export function registerLibraryChannel(): void {
  const repos = getRepos()
  const importer = getImportService()
  const watcher = getFolderWatcher()

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
    repos.playlists.addTracks(p.playlistId, p.trackIds)
    broadcast('library:changed', { reason: 'playlist-tracks' })
  })

  ipcMain.handle('library:search', (_, query: string, limit?: number): SearchResultsPayload =>
    repos.search.search(query, limit ?? 20),
  )

  ipcMain.handle('library:folders', () => repos.folders.list())
  ipcMain.handle('library:folders:remove', (_, id: number) => {
    watcher.stop(id)
    getLibraryBackup().cancelForFolder(id)
    repos.folders.remove(id)
    broadcast('library:changed', { reason: 'folder-remove' })
  })

  ipcMain.handle('library:folders:pick', async (): Promise<PickFolderResult> => {
    const result = await dialog.showOpenDialog({
      title: 'Add music folder',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: null }
    }
    return { canceled: false, path: result.filePaths[0] }
  })

  ipcMain.handle('library:folders:add', async (_, path: string): Promise<AddFolderResult> => {
    const result = await importer.addFolder(path)
    watcher.start(result.folder.id, result.folder.path)
    broadcast('library:changed', { reason: 'folder-add' })
    return result
  })

  // Queue persistence
  ipcMain.handle('queue:save', (_, payload: { trackIds: number[]; currentIndex: number }) => {
    repos.queue.save(payload.trackIds, payload.currentIndex)
  })
  ipcMain.handle('queue:load', () => repos.queue.load())

  // Lyrics
  ipcMain.handle('lyrics:get', (_, trackId: number) => repos.lyrics.get(trackId) ?? null)
  ipcMain.handle('lyrics:set', (_, payload: { trackId: number; lrcContent: string; source: string | null; language: string | null }) =>
    repos.lyrics.set(payload.trackId, payload.lrcContent, payload.source ?? null, payload.language ?? null),
  )
  // High-level fetch: serve from cache, otherwise hit LRCLIB and cache.
  ipcMain.handle('lyrics:getForTrack', async (_, trackId: number) => {
    const cached = repos.lyrics.get(trackId)
    if (cached) {
      return {
        trackId,
        lrcContent: cached.lrc_content,
        source: cached.source,
        language: cached.language,
        synced: cached.lrc_content.includes('['),
      }
    }
    const track = repos.tracks.getById(trackId)
    if (!track) return null
    const result = await fetchLyrics({
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationSec: track.duration,
    })
    if (!result) return null
    const content = result.synced ?? result.plain
    if (!content) return null
    repos.lyrics.set(trackId, content, result.source, result.language)
    return {
      trackId,
      lrcContent: content,
      source: result.source,
      language: result.language,
      synced: result.synced != null,
    }
  })

  // Track plays. Threshold (30s) is decided by the renderer — main just
  // increments and notifies subscribers so the UI refreshes.
  ipcMain.handle('track:countPlay', (_, trackId: number) => {
    repos.tracks.updatePlays(trackId)
    getLibraryBackup().scheduleWriteForTrack(trackId)
    broadcast('library:changed', { reason: 'play-count' })
  })

  ipcMain.handle('track:setFavorite', (_, payload: { id: number; favorite: boolean }) => {
    repos.tracks.setFavorite(payload.id, payload.favorite)
    getLibraryBackup().scheduleWriteForTrack(payload.id)
    broadcast('library:changed', { reason: 'track-favorite' })
  })

  ipcMain.handle('track:refreshMetadata', async (_, trackId: number) => {
    const track = repos.tracks.getById(trackId)
    if (!track) return

    const md = await readTrackMetadata(track.path)
    const parsedArtist = parseArtistName(md.artist)
    const artist = repos.artists.getOrCreate(parsedArtist.primary || md.artist)
    const genre = md.genre ? repos.genres.getOrCreate(md.genre) : null

    const candidateRefs = repos.tracks.getByFolderWithAlbum(track.folder_id)
    const candidateAlbum = resolveAlbumFromFolderHints(track, candidateRefs)
    const resolvedAlbum = repos.albums.getOrCreate(md.album, md.albumArtist ?? null, md.year || null)
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
      duration: md.duration,
      format: md.format,
      codec: md.codec,
      bitrate: md.bitrate,
      sampleRate: md.sampleRate,
      channels: md.channels,
      bitDepth: md.bitDepth,
      fileSize: md.fileSize,
      dateModified: md.dateModified,
      artworkPath: md.artwork?.filename ?? track.artwork_path,
      filename: basename(track.path),
      artistId: artist.id,
      albumId: targetAlbumId,
      genreId: genre?.id ?? null,
    })

    getLibraryBackup().scheduleWriteForTrack(track.id)
    broadcast('library:changed', { reason: 'track-refresh' })
  })

  ipcMain.handle('artist:setFavorite', (_, payload: { id: number; favorite: boolean }) => {
    repos.artists.setFavorite(payload.id, payload.favorite)
    getLibraryBackup().scheduleWriteForArtist(payload.id)
    broadcast('library:changed', { reason: 'artist-favorite' })
  })

  // Renderer-side preference push. The renderer reads its tweak from
  // localStorage on boot and forwards it here so the backup service knows
  // whether to write.
  ipcMain.handle('settings:setLibraryBackup', (_, enabled: boolean) => {
    getLibraryBackup().setEnabled(enabled)
  })
}
