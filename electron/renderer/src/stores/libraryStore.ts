// Zustand store backing the library views. Loads tracks/albums/artists from
// the main-process SQLite database on first access and caches them in memory.
// Search runs on demand through the FTS5 IPC channel.

import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type { Album, Artist, Pattern, Playlist, Track } from '@shared/types/library'
import type { DbFolder, DbTrack } from '@shared/types/db'
import type {
  ImportProgressEvent,
  TrackMetadataUpdatePayload,
  TrashTracksResult,
} from '@shared/types/ipc-contract'
import {
  dbToUiAlbum,
  dbToUiArtist,
  dbToUiPlaylist,
  dbToUiTrack,
  type UiGenre,
} from './adapters'
import { usePlaybackStore } from './playbackStore'
import { useQueueStore } from './queueStore'

const TRACK_NO_WITHOUT = Number.MAX_SAFE_INTEGER
const UNRESOLVED_ALBUM_PREFIX = 'a-unresolved'
const UNRESOLVED_ALBUM_LABEL = 'Sin álbum detectado'
const SYNTH_PATTERNS: Pattern[] = ['circles', 'sun', 'rays', 'grid', 'wave', 'stripes', 'rings', 'half', 'diag', 'lines']

function normalizeForAlbumId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'unknown'
}

function toSyntheticAlbumId(row: DbTrack): string {
  const key = `${row.folder_id ?? 'folder'}::${normalizeForAlbumId(row.album || 'sin-album')}`
  return `${UNRESOLVED_ALBUM_PREFIX}-${key}`
}

function hashSeed(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

function palette(seed: number): [string, string, string] {
  const hue = seed % 360
  const c0 = `hsl(${hue}, 30%, 12%)`
  const c1 = `hsl(${(hue + 25) % 360}, 35%, 28%)`
  const c2 = `hsl(${(hue + 50) % 360}, 45%, 65%)`
  return [c0, c1, c2]
}

function patternFor(seed: number): Pattern {
  return SYNTH_PATTERNS[seed % SYNTH_PATTERNS.length]
}

function toAlbumDbId(albumUiId: string): number | null {
  if (albumUiId.startsWith(UNRESOLVED_ALBUM_PREFIX)) return null
  const raw = albumUiId.startsWith('a') ? albumUiId.slice(1) : albumUiId
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function inferUnresolvedAlbumArtist(tracks: Track[]): string {
  const artists = new Set(tracks.map(t => t.artist).filter(Boolean))
  if (artists.size <= 1) return tracks[0]?.artist || ''
  return 'Various Artists'
}

function buildUnresolvedAlbum(albumId: string, tracks: Track[]): Album {
  const sorted = [...tracks].sort(compareTrackNumberAsc)
  const seed = hashSeed(albumId)
  const title = sorted[0]?.albumTitle || UNRESOLVED_ALBUM_LABEL
  const genre = sorted[0]?.genre || ''
  const year = sorted[0]?.year || 0
  return {
    id: albumId,
    title,
    artist: inferUnresolvedAlbumArtist(sorted),
    year,
    added: latestTrackAddedDateInAlbum(tracks),
    seed,
    palette: palette(seed),
    pattern: patternFor(seed),
    genre,
    tracks: sorted,
    artworkPath: sorted[0]?.artworkPath,
  }
}

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

function latestTrackAddedDateInAlbum(tracks: Track[]): string {
  return tracks.reduce((latest, track) => {
    if (!track.added) return latest
    return track.added.localeCompare(latest) > 0 ? track.added : latest
  }, '')
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
      const tracksByAlbumId = new Map<string, Track[]>()
      const tracksByArtistId = new Map<number, Track[]>()
      for (let i = 0; i < dbTracks.length; i++) {
        const aid = dbTracks[i].album_id
        const track = (() => {
          if (aid == null) {
            const albumId = toSyntheticAlbumId(dbTracks[i])
            return {
              ...tracks[i],
              albumId,
              albumTitle: tracks[i].albumTitle || UNRESOLVED_ALBUM_LABEL,
            }
          }
          return tracks[i]
        })()
        tracks[i] = track

        const byAlbum = tracksByAlbumId.get(track.albumId) ?? []
        byAlbum.push(track)
        tracksByAlbumId.set(track.albumId, byAlbum)

        const artistId = dbTracks[i].artist_id
        if (artistId == null) continue
        const artistTracks = tracksByArtistId.get(artistId) ?? []
        artistTracks.push(track)
        tracksByArtistId.set(artistId, artistTracks)
      }

      const albumsById = new Map<string, Album>()
      for (const album of dbAlbums) {
        const albumKey = `a${album.id}`
        const albumTracks = tracksByAlbumId.get(albumKey) ?? []
        const sortedTracks = [...albumTracks].sort(compareTrackNumberAsc)
        albumsById.set(albumKey, dbToUiAlbum(album, sortedTracks))

        tracksByAlbumId.set(albumKey, sortedTracks)
      }

      const syntheticAlbums: Album[] = [...tracksByAlbumId.entries()]
        .filter(([albumId]) => albumId.startsWith(`${UNRESOLVED_ALBUM_PREFIX}-`))
        .map(([albumId, tracksInAlbum]) => {
          const sorted = [...tracksInAlbum].sort(compareTrackNumberAsc)
          return buildUnresolvedAlbum(albumId, sorted)
        })

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
      const tracksByDbId = new Map<number, Track>()
      for (const track of tracks) {
        if (track.dbId != null) tracksByDbId.set(track.dbId, track)
      }

      const albums = [
        ...dbAlbums.map(a => albumsById.get(`a${a.id}`) ?? dbToUiAlbum(a, tracksByAlbumId.get(`a${a.id}`) ?? [])),
        ...syntheticAlbums,
      ]
      const artists = dbArtists.map(ar => {
        const artistTracks = tracksByArtistId.get(ar.id) ?? []
        const albumIdsForArtist = new Set(artistTracks.map(t => t.albumId))
        const artistAlbums = albums.filter(a => albumIdsForArtist.has(a.id))
        return dbToUiArtist(ar, artistAlbums)
      })

      const playlistTrackRows = await Promise.all(
        dbPlaylists.map(p => api.playlistTracks(p.id).catch(() => [] as DbTrack[])),
      )
      const playlists = dbPlaylists.map((p, i) => {
        const playlistTracks = playlistTrackRows[i].map(row => tracksByDbId.get(row.id) ?? dbToUiTrack(row))
        return dbToUiPlaylist(p, playlistTracks)
      })

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

export async function toggleAlbumFavorite(albumUiIdOrDbId: string | number, favorite: boolean): Promise<void> {
  const albumDbId =
    typeof albumUiIdOrDbId === 'number'
      ? albumUiIdOrDbId
      : toAlbumDbId(albumUiIdOrDbId)
  if (!albumDbId || albumDbId <= 0) {
    throw new Error('Cannot set favorite for non-persisted album')
  }

  const albumId = `a${albumDbId}`
  const applyLocalFavorite = (nextFavorite: boolean) => {
    useLibraryStore.setState(state => ({
      albums: state.albums.map(album =>
        album.id === albumId ? { ...album, favorite: nextFavorite } : album,
      ),
    }))
  }

  applyLocalFavorite(favorite)
  try {
    await window.api.albums.setFavorite(albumDbId, favorite)
  } catch (error) {
    applyLocalFavorite(!favorite)
    throw error
  }
}

export async function toggleTrackFavorite(trackDbId: number, favorite: boolean): Promise<void> {
  const applyLocalFavorite = (nextFavorite: boolean) => {
    const withFavorite = (track: Track) =>
      track.dbId === trackDbId ? { ...track, loved: nextFavorite } : track

    useLibraryStore.setState(state => ({ tracks: state.tracks.map(withFavorite) }))

    usePlaybackStore.setState(state => {
      const currentTrack = state.currentTrack
      if (currentTrack?.dbId !== trackDbId) return {}
      return { currentTrack: { ...currentTrack, loved: nextFavorite } }
    })

    useQueueStore.setState(state => ({
      tracks: state.tracks.map(withFavorite),
      history: state.history.map(withFavorite),
    }))
  }

  applyLocalFavorite(favorite)
  try {
    await window.api.tracks.setFavorite(trackDbId, favorite)
  } catch (error) {
    applyLocalFavorite(!favorite)
    throw error
  }
}

export async function refreshTrackMetadata(trackDbId: number): Promise<void> {
  await window.api.tracks.refreshMetadata(trackDbId)
}

function uniqueTrackDbIds(trackDbIds: number[]): number[] {
  return [...new Set(trackDbIds.filter(id => Number.isInteger(id) && id > 0))]
}

async function stopPlaybackIfCurrentTrack(trackDbIds: number[]): Promise<void> {
  const ids = new Set(trackDbIds)
  const currentTrack = usePlaybackStore.getState().currentTrack
  if (currentTrack?.dbId == null || !ids.has(currentTrack.dbId)) return

  await window.api.audio.stop()
  await window.api.audio.clearNext()
  usePlaybackStore.setState({
    status: 'stopped',
    currentTrack: null,
    streamInfo: null,
    positionSec: 0,
    durationSec: 0,
  })
}

function pruneDeletedTracksFromQueue(trackDbIds: number[]): void {
  const ids = new Set(trackDbIds)
  if (ids.size === 0) return

  useQueueStore.setState(state => {
    const current = state.currentIndex >= 0 ? state.tracks[state.currentIndex] : undefined
    const tracks = state.tracks.filter(t => t.dbId == null || !ids.has(t.dbId))
    const currentIndex = current?.dbId != null && ids.has(current.dbId)
      ? -1
      : current
        ? tracks.findIndex(t => t.id === current.id)
        : state.currentIndex

    return {
      tracks,
      currentIndex: Math.max(-1, currentIndex),
      history: state.history.filter(t => t.dbId == null || !ids.has(t.dbId)),
    }
  })

  const currentTrack = usePlaybackStore.getState().currentTrack
  if (currentTrack?.dbId != null && ids.has(currentTrack.dbId)) {
    usePlaybackStore.setState({
      currentTrack: null,
      streamInfo: null,
      positionSec: 0,
      durationSec: 0,
      status: 'stopped',
    })
  }
}

export async function addTracksToPlaylist(playlistDbId: number, trackDbIds: number[]): Promise<void> {
  const ids = uniqueTrackDbIds(trackDbIds)
  if (ids.length === 0) return
  await window.api.library.addToPlaylist(playlistDbId, ids)
  await useLibraryStore.getState().refresh()
}

export async function createPlaylistWithTracks(name: string, trackDbIds: number[]): Promise<void> {
  const cleanName = name.trim()
  if (!cleanName) throw new Error('Playlist name is required.')

  const playlist = await window.api.library.createPlaylist(cleanName)
  const ids = uniqueTrackDbIds(trackDbIds)
  if (ids.length > 0) {
    await window.api.library.addToPlaylist(playlist.id, ids)
  }
  await useLibraryStore.getState().refresh()
}

export async function updateTrackMetadata(
  trackDbId: number,
  payload: TrackMetadataUpdatePayload,
): Promise<void> {
  await updateTracksMetadata([trackDbId], payload)
}

export async function updateTracksMetadata(
  trackDbIds: number[],
  payload: TrackMetadataUpdatePayload,
): Promise<void> {
  const ids = uniqueTrackDbIds(trackDbIds)
  if (ids.length === 0) return
  await stopPlaybackIfCurrentTrack(ids)
  for (const trackDbId of ids) {
    await window.api.tracks.updateMetadata(trackDbId, payload)
  }
  await useLibraryStore.getState().refresh()
}

export async function trashTracks(trackDbIds: number[]): Promise<TrashTracksResult> {
  const ids = uniqueTrackDbIds(trackDbIds)
  if (ids.length === 0) return { trashedTrackIds: [], failed: [] }

  await stopPlaybackIfCurrentTrack(ids)
  const result = await window.api.tracks.trash(ids)
  pruneDeletedTracksFromQueue(result.trashedTrackIds)
  await useLibraryStore.getState().refresh()
  return result
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

export function useFavoriteTracks(): Track[] {
  return useLibraryStore(useShallow(s => s.tracks.filter(t => t.loved)))
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
