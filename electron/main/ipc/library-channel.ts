import { dialog, ipcMain } from 'electron'
import { basename } from 'node:path'
import { getRepos } from '../db/repositories'
import type {
  AddFolderResult,
  ListTracksOpts,
  PickFolderResult,
  SearchResultsPayload,
} from '@shared/types/ipc-contract'

export function registerLibraryChannel(): void {
  const repos = getRepos()

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

  // Playlists are read-only stubs in Session 1 (PlaylistRepo lands in Session 2).
  ipcMain.handle('library:playlists', () => [])
  ipcMain.handle('library:playlist:tracks', () => [])

  ipcMain.handle('library:search', (_, query: string, limit?: number): SearchResultsPayload =>
    repos.search.search(query, limit ?? 20),
  )

  ipcMain.handle('library:folders', () => repos.folders.list())
  ipcMain.handle('library:folders:remove', (_, id: number) => {
    repos.folders.remove(id)
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
    const name = basename(path) || path
    const folder = repos.folders.add(path, name)
    // Scanning lands in Session 2 (ImportService). For now we just register
    // the folder so the UI can show it.
    return { folder, startedScan: false }
  })
}
