import { dialog, ipcMain } from 'electron'
import { getRepos } from '../db/repositories'
import { getImportService } from '../library/ImportService'
import { getFolderWatcher } from '../library/FolderWatcher'
import { fetchLyrics } from '../services/lyrics'
import { getLibraryBackup } from '../services/LibraryBackup'
import { broadcast } from './events'
import type {
  AddFolderResult,
  ListTracksOpts,
  PickFolderResult,
  SearchResultsPayload,
} from '@shared/types/ipc-contract'

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
