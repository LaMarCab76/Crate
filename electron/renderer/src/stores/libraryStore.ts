// Zustand store backing the library views. Loads tracks/albums/artists from
// the main-process SQLite database on first access and caches them in memory.
// Search runs on demand through the FTS5 IPC channel.

import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type { Album, Artist, Playlist, Track } from '@shared/types/library'
import type { DbFolder } from '@shared/types/db'
import type { ImportProgressEvent } from '@shared/types/ipc-contract'
import {
  dbToUiAlbum,
  dbToUiArtist,
  dbToUiPlaylist,
  dbToUiTrack,
  type UiGenre,
} from './adapters'

const TRACK_NO_WITHOUT = Number.MAX_SAFE_INTEGER

function compareTrackNumberAsc(a: Track, b: Track): number {
  const aNo = a.no > 0 ? a.no : TRACK_NO_WITHOUT
  const bNo = b.no > 0 ? b.no : TRACK_NO_WITHOUT
  if (aNo !== bNo) return aNo - bNo

  const byAdded = (a.added || '').localeCompare(b.added || '')
  if (byAdded !== 0) return byAdded

  return (a.dbId ?? 0) - (b.dbId ?? 0)
}

function firstTrackAddedDateInAlbum(tracks: Track[]): string {
  if (tracks.length === 0) return ''
  return tracks[0]?.added || ''
}

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
  importing: ImportProgressEvent | null
  refresh(): Promise<void>
  addFolder(path: string): Promise<void>
  removeFolder(id: number): Promise<void>
  pickFolder(): Promise<string | null>
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
  importing: null,

  async refresh() {
    if (get().loading) return
    set({ loading: true, error: null })
    try {
      const api = window.api.library

      const [dbTracks, dbAlbums, dbArtists, dbGenres, dbPlaylists, dbFolders, count] =
        await Promise.all([
          api.tracks({ limit: 10000 }),
          api.albums(),
          api.artists(),
          api.genres(),
          api.playlists(),
          api.folders(),
          api.trackCount(),
        ])

      const tracks = dbTracks.map(dbToUiTrack)
      const tracksByAlbumId = new Map<number, Track[]>()
      const tracksByArtistId = new Map<number, Track[]>()
      for (let i = 0; i < dbTracks.length; i++) {
        const aid = dbTracks[i].album_id
        if (aid == null) continue
        const sortedByAlbum = tracksByAlbumId.get(aid) ?? []
        sortedByAlbum.push(tracks[i])
        tracksByAlbumId.set(aid, sortedByAlbum)

        const artistId = dbTracks[i].artist_id
        if (artistId == null) continue
        const artistTracks = tracksByArtistId.get(artistId) ?? []
        artistTracks.push(tracks[i])
        tracksByArtistId.set(artistId, artistTracks)
      }

      const albumsById = new Map<number, Album>()
      for (const album of dbAlbums) {
        const albumTracks = tracksByAlbumId.get(album.id) ?? []
        const sortedTracks = [...albumTracks].sort(compareTrackNumberAsc)
        albumsById.set(album.id, dbToUiAlbum(album, sortedTracks))

        tracksByAlbumId.set(album.id, sortedTracks)
      }

      const albumOrderForSongs = [...tracksByAlbumId.entries()]
        .map(([, tracksInAlbum]) => ({
          tracksInAlbum,
          firstTrackAdded: firstTrackAddedDateInAlbum(tracksInAlbum),
        }))
        .sort((a, b) => {
          const byDate = b.firstTrackAdded.localeCompare(a.firstTrackAdded)
          if (byDate !== 0) return byDate

          const aTrackId = a.tracksInAlbum[0]?.dbId ?? 0
          const bTrackId = b.tracksInAlbum[0]?.dbId ?? 0
          return bTrackId - aTrackId
        })

      const orderedTracks = albumOrderForSongs.flatMap(item => item.tracksInAlbum)

      const albums = dbAlbums.map(a => albumsById.get(a.id) ?? dbToUiAlbum(a, tracksByAlbumId.get(a.id) ?? []))
      const artists = dbArtists.map(ar => {
        const artistTracks = tracksByArtistId.get(ar.id) ?? []
        const albumIdsForArtist = new Set(artistTracks.map(t => t.albumId))
        const artistAlbums = albums.filter(a => albumIdsForArtist.has(a.id))
        return dbToUiArtist(ar, artistAlbums)
      })

      const playlists = dbPlaylists.map(p => dbToUiPlaylist(p, []))

      set({
        tracks: orderedTracks,
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

// Mutations that don't fit cleanly inside the store creator (they need access
// to window.api but no shared state changes beyond a refresh).
export async function toggleArtistFavorite(artistDbId: number, favorite: boolean): Promise<void> {
  await window.api.artists.setFavorite(artistDbId, favorite)
  // The library:changed broadcast already debounces a refresh, but flip the
  // local flag immediately so the UI feels instant.
  useLibraryStore.setState(state => ({
    artists: state.artists.map(ar => (ar.dbId === artistDbId ? { ...ar, favorite } : ar)),
  }))
}

// Subscribe once, on module load, to main-process push events so the store
// stays fresh without each component wiring its own listener.
if (typeof window !== 'undefined' && window.api?.library) {
  let refreshDebounce: number | undefined
  const scheduleRefresh = () => {
    if (refreshDebounce) window.clearTimeout(refreshDebounce)
    refreshDebounce = window.setTimeout(() => {
      useLibraryStore.getState().refresh()
    }, 200)
  }

  window.api.library.onImportProgress(payload => {
    useLibraryStore.setState({ importing: payload })
  })
  window.api.library.onImportComplete(() => {
    useLibraryStore.setState({ importing: null })
    scheduleRefresh()
  })
  window.api.library.onLibraryChanged(scheduleRefresh)
}

export function useTracks(): Track[] {
  return useLibraryStore(s => s.tracks)
}
export function useAlbums(): Album[] {
  return useLibraryStore(s => s.albums)
}
export function useArtists(): Artist[] {
  return useLibraryStore(s => s.artists)
}

export function useFavoriteArtists(): Artist[] {
  // useShallow keeps the React tree stable when the filtered list happens to
  // be the same set even though the array reference changed.
  return useLibraryStore(useShallow(s => s.artists.filter(ar => ar.favorite)))
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
export function useImporting(): ImportProgressEvent | null {
  return useLibraryStore(s => s.importing)
}

export function useAlbumByUiId(uiId: string | undefined): Album | undefined {
  return useLibraryStore(s => (uiId ? s.albums.find(a => a.id === uiId) : undefined))
}

export function useArtistByUiId(uiId: string | undefined): Artist | undefined {
  return useLibraryStore(s => (uiId ? s.artists.find(a => a.id === uiId) : undefined))
}
