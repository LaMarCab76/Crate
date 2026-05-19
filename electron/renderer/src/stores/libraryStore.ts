// Zustand store backing the library views. Loads tracks/albums/artists from
// the main-process SQLite database on first access and caches them in memory.
// Search runs on demand through the FTS5 IPC channel.

import { create } from 'zustand'
import type { Album, Artist, Playlist, Track } from '@shared/types/library'
import type { DbFolder } from '@shared/types/db'
import {
  dbToUiAlbum,
  dbToUiArtist,
  dbToUiPlaylist,
  dbToUiTrack,
  type UiGenre,
} from './adapters'

interface LibraryState {
  tracks: Track[]
  albums: Album[]
  artists: Artist[]
  genres: UiGenre[]
  playlists: Playlist[]
  folders: DbFolder[]
  trackCount: number
  loaded: boolean
  loading: boolean
  error: string | null
  refresh(): Promise<void>
  addFolder(path: string): Promise<void>
  removeFolder(id: number): Promise<void>
  pickFolder(): Promise<string | null>
}

function indexBy<T, K extends string | number>(items: T[], key: (t: T) => K): Map<K, T> {
  const m = new Map<K, T>()
  for (const i of items) m.set(key(i), i)
  return m
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  tracks: [],
  albums: [],
  artists: [],
  genres: [],
  playlists: [],
  folders: [],
  trackCount: 0,
  loaded: false,
  loading: false,
  error: null,

  async refresh() {
    if (get().loading) return
    set({ loading: true, error: null })
    try {
      const api = window.api.library

      const [dbTracks, dbAlbums, dbArtists, dbGenres, dbPlaylists, dbFolders, count] =
        await Promise.all([
          api.tracks({ limit: 5000 }),
          api.albums(),
          api.artists(),
          api.genres(),
          api.playlists(),
          api.folders(),
          api.trackCount(),
        ])

      const tracks = dbTracks.map(dbToUiTrack)
      const tracksByAlbumId = new Map<number, Track[]>()
      for (let i = 0; i < dbTracks.length; i++) {
        const aid = dbTracks[i].album_id
        if (aid == null) continue
        const arr = tracksByAlbumId.get(aid) ?? []
        arr.push(tracks[i])
        tracksByAlbumId.set(aid, arr)
      }
      const tracksByArtistId = new Map<number, Track[]>()
      for (let i = 0; i < dbTracks.length; i++) {
        const aid = dbTracks[i].artist_id
        if (aid == null) continue
        const arr = tracksByArtistId.get(aid) ?? []
        arr.push(tracks[i])
        tracksByArtistId.set(aid, arr)
      }

      const albums = dbAlbums.map(a => dbToUiAlbum(a, tracksByAlbumId.get(a.id) ?? []))
      const albumsByOrigId = indexBy(albums, a => a.id)
      const artists = dbArtists.map(ar => {
        const artistTracks = tracksByArtistId.get(ar.id) ?? []
        const albumIdsForArtist = new Set(artistTracks.map(t => t.albumId))
        const artistAlbums = albums.filter(a => albumIdsForArtist.has(a.id))
        return dbToUiArtist(ar, artistAlbums)
      })

      const playlists = dbPlaylists.map(p => dbToUiPlaylist(p, []))
      // Silence unused-warning while indexed lookups land in Session 2.
      void albumsByOrigId

      set({
        tracks,
        albums,
        artists,
        genres: dbGenres.map(g => ({ id: `g${g.id}`, name: g.name })),
        playlists,
        folders: dbFolders,
        trackCount: count,
        loaded: true,
        loading: false,
        error: null,
      })
    } catch (err) {
      set({ loading: false, error: (err as Error).message })
    }
  },

  async addFolder(path) {
    await window.api.library.addFolder(path)
    await get().refresh()
  },

  async removeFolder(id) {
    await window.api.library.removeFolder(id)
    await get().refresh()
  },

  async pickFolder() {
    const result = await window.api.library.pickFolder()
    return result.canceled ? null : result.path
  },
}))

export function useTracks(): Track[] {
  return useLibraryStore(s => s.tracks)
}
export function useAlbums(): Album[] {
  return useLibraryStore(s => s.albums)
}
export function useArtists(): Artist[] {
  return useLibraryStore(s => s.artists)
}
export function useGenres(): UiGenre[] {
  return useLibraryStore(s => s.genres)
}
export function usePlaylists(): Playlist[] {
  return useLibraryStore(s => s.playlists)
}
export function useFolders(): DbFolder[] {
  return useLibraryStore(s => s.folders)
}
export function useTrackCount(): number {
  return useLibraryStore(s => s.trackCount)
}
export function useLibraryLoaded(): boolean {
  return useLibraryStore(s => s.loaded)
}

export function useAlbumByUiId(uiId: string | undefined): Album | undefined {
  return useLibraryStore(s => (uiId ? s.albums.find(a => a.id === uiId) : undefined))
}

export function useArtistByUiId(uiId: string | undefined): Artist | undefined {
  return useLibraryStore(s => (uiId ? s.artists.find(a => a.id === uiId) : undefined))
}
