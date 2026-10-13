// Zustand store backing the library views. Loads tracks/albums/artists from
// the main-process SQLite database on first access and caches them in memory.
// Search runs on demand through the FTS5 IPC channel.

import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import { useMemo } from 'react'
import type { Album, Artist, Pattern, Playlist, Track } from '@shared/types/library'
import type { DbFolder, DbTrack } from '@shared/types/db'
import type {
  ImportProgressEvent,
  MetadataCompletionApplyRequest,
  MetadataCompletionApplyResult,
  MetadataCompletionPreview,
  MetadataCompletionTargetsPayload,
  RemoveFolderOptions,
  OriginalAlbumCandidatesResult,
  TrackAlbumMoveApplyResult,
  TrackAlbumMovePreview,
  TrackAlbumMovePreviewRequest,
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
import { useActivityCenterStore } from './activityCenterStore'
import { useLibraryLocationsStore } from './libraryLocationsStore'
import { runTrackDeletionLifecycle } from '@renderer/utils/trackDeletionLifecycle'
import { useTweakStore } from './settingsStore'
import { buildDisplayedArtists } from '@renderer/utils/artistDisplay'

const TRACK_NO_WITHOUT = Number.MAX_SAFE_INTEGER
const DISC_NO_WITHOUT = Number.MAX_SAFE_INTEGER
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
  const aDisc = a.discNumber != null && a.discNumber > 0 ? a.discNumber : DISC_NO_WITHOUT
  const bDisc = b.discNumber != null && b.discNumber > 0 ? b.discNumber : DISC_NO_WITHOUT
  if (aDisc !== bDisc) return aDisc - bDisc

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

const LEGACY_ACTIVE_LIBRARY_STORAGE_KEY = 'crate.activeLibraryId'
const LIBRARY_TRACK_PAGE_SIZE = 2_000

// Coalesce broadcasts that arrive while a refresh is hydrating a large
// library. The active pass is allowed to finish, then exactly one fresh pass
// runs against the latest database snapshot.
let libraryRefreshPromise: Promise<void> | null = null
let libraryRefreshRequested = false

function clearLegacyActiveLibraryScope(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(LEGACY_ACTIVE_LIBRARY_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

clearLegacyActiveLibraryScope()

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
  metadataCompletionPrompt: {
    folderId: number
    totalCandidates: number
    trackIds: number[]
  } | null
  refresh(): Promise<void>
  addFolder(token: string): Promise<void>
  removeFolder(id: number, options?: RemoveFolderOptions): Promise<void>
  pickFolder(): Promise<string | null>
  dismissMetadataCompletionPrompt(): void
  deletingTrackIds: Set<number>
  markDeletingTracks(ids: number[]): void
  clearDeletingTracks(ids: number[]): void
  // Tracks that have been optimistically removed from the UI but whose disk
  // deletion has not settled yet. `refresh()` filters these out so an unrelated
  // reload can't resurrect a row mid-deletion.
  pendingTrashIds: Set<number>
  applyOptimisticTrash(ids: number[]): void
  clearPendingTrash(ids: number[]): void
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
  metadataCompletionPrompt: null,
  deletingTrackIds: new Set<number>(),
  pendingTrashIds: new Set<number>(),

  async refresh() {
    if (libraryRefreshPromise) {
      libraryRefreshRequested = true
      return libraryRefreshPromise
    }

    const refreshTask = (async () => {
      do {
        libraryRefreshRequested = false
        set({ loading: true, error: null })
        try {
      const api = window.api.library

      const [dbAlbums, dbArtists, dbGenres, dbPlaylists, dbFolders, count] =
        await Promise.all([
          api.albums(),
          api.artists(),
          api.genres(),
          api.playlists(),
          api.folders(),
          api.trackCount(),
        ])

      const rawDbTracks: DbTrack[] = []
      for (let offset = 0; offset < count; offset += LIBRARY_TRACK_PAGE_SIZE) {
        const page = await api.tracks({
          limit: LIBRARY_TRACK_PAGE_SIZE,
          offset,
          orderBy: 'date_added_desc',
        })
        rawDbTracks.push(...page)
        if (page.length < LIBRARY_TRACK_PAGE_SIZE) break
      }

      // Drop rows whose disk deletion is still in flight so a reload triggered
      // mid-deletion (e.g. a `library:changed` broadcast) can't resurrect an
      // optimistically removed track before the trash settles.
      const pendingTrash = get().pendingTrashIds
      const dbTracks = pendingTrash.size > 0
        ? rawDbTracks.filter(row => !pendingTrash.has(row.id))
        : rawDbTracks
      const trackCount = Math.max(0, count - (rawDbTracks.length - dbTracks.length))

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
        if (albumTracks.length === 0) continue
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
        ...dbAlbums.flatMap(a => {
          const album = albumsById.get(`a${a.id}`)
          return album ? [album] : []
        }),
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
        trackCount,
        loaded: true,
        loading: false,
        error: null,
      })
      await useQueueStore.getState().hydrate(orderedTracks)
        } catch (err) {
          set({ loading: false, error: (err as Error).message })
        }
      } while (libraryRefreshRequested)
    })()

    libraryRefreshPromise = refreshTask
    try {
      await refreshTask
    } finally {
      if (libraryRefreshPromise === refreshTask) libraryRefreshPromise = null
    }
  },

  async addFolder(token) {
    await window.api.library.addFolder(token)
    await Promise.all([
      get().refresh(),
      useLibraryLocationsStore.getState().load(),
    ])
  },

  async removeFolder(id, options) {
    await window.api.library.removeFolder(id, options)
    await Promise.all([
      get().refresh(),
      useLibraryLocationsStore.getState().load(),
    ])
  },

  async pickFolder() {
    const result = await window.api.library.pickFolder()
    return result.canceled ? null : result.token
  },

  dismissMetadataCompletionPrompt() {
    set({ metadataCompletionPrompt: null })
  },

  markDeletingTracks(ids) {
    set(s => {
      const next = new Set(s.deletingTrackIds)
      for (const id of ids) next.add(id)
      return { deletingTrackIds: next }
    })
  },

  clearDeletingTracks(ids) {
    set(s => {
      const next = new Set(s.deletingTrackIds)
      for (const id of ids) next.delete(id)
      return { deletingTrackIds: next }
    })
  },

  applyOptimisticTrash(ids) {
    if (ids.length === 0) return
    const idSet = new Set(ids)
    set(s => {
      const tracks = s.tracks.filter(t => t.dbId == null || !idSet.has(t.dbId))
      const removed = s.tracks.length - tracks.length
      const pendingTrashIds = new Set(s.pendingTrashIds)
      for (const id of ids) pendingTrashIds.add(id)
      return {
        tracks,
        pendingTrashIds,
        trackCount: Math.max(0, s.trackCount - removed),
      }
    })
  },

  clearPendingTrash(ids) {
    set(s => {
      const next = new Set(s.pendingTrashIds)
      for (const id of ids) next.delete(id)
      return { pendingTrashIds: next }
    })
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

function applyLocalArtistArtwork(artistDbId: number, artworkPath: string, sourceType: 'album' | 'custom'): void {
  useLibraryStore.setState(state => ({
    artists: state.artists.map(ar => (
      ar.dbId === artistDbId ? { ...ar, artworkPath, artworkSourceType: sourceType } : ar
    )),
  }))
}

export async function setArtistArtworkFromAlbum(
  artistDbId: number,
  albumUiId: string,
): Promise<void> {
  const albumDbId = toAlbumDbId(albumUiId)
  if (!albumDbId || albumDbId <= 0) throw new Error('El álbum elegido no está persistido.')
  const result = await window.api.artists.setArtworkFromAlbum(artistDbId, albumDbId)
  applyLocalArtistArtwork(artistDbId, result.artworkPath, 'album')
}

export async function pickArtistArtwork(artistDbId: number): Promise<boolean> {
  const result = await window.api.artists.pickArtwork(artistDbId)
  if (result.canceled || !result.artworkPath) return false
  applyLocalArtistArtwork(artistDbId, result.artworkPath, 'custom')
  return true
}

export async function resetArtistArtwork(artistDbId: number): Promise<void> {
  await window.api.artists.resetArtwork(artistDbId)
  await useLibraryStore.getState().refresh()
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

export async function findMetadataCompletionTargets(
  folderId?: number,
  limit?: number,
): Promise<MetadataCompletionTargetsPayload> {
  return window.api.tracks.findMetadataCompletionTargets(folderId, limit)
}

export async function previewMetadataCompletion(trackDbIds: number[]): Promise<MetadataCompletionPreview> {
  const ids = uniqueTrackDbIds(trackDbIds)
  if (ids.length === 0) {
    return { previewId: '', createdAt: Date.now(), candidates: [] }
  }
  return window.api.tracks.previewMetadataCompletion(ids)
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

export async function applyMetadataCompletions(
  payload: MetadataCompletionApplyRequest,
): Promise<MetadataCompletionApplyResult> {
  const ids = uniqueTrackDbIds(payload.selections.map(selection => selection.trackId))
  if (ids.length === 0) return { applied: 0, failed: 0, results: [] }
  await stopPlaybackIfCurrentTrack(ids)
  const result = await window.api.tracks.applyMetadataCompletions(payload)
  await useLibraryStore.getState().refresh()
  if (result.applied > 0) {
    useLibraryStore.setState({ metadataCompletionPrompt: null })
  }
  return result
}

export async function findOriginalAlbums(trackDbId: number): Promise<OriginalAlbumCandidatesResult> {
  return window.api.tracks.findOriginalAlbums(trackDbId)
}

export async function previewTrackAlbumMove(
  payload: TrackAlbumMovePreviewRequest,
): Promise<TrackAlbumMovePreview> {
  return window.api.tracks.previewAlbumMove(payload)
}

export async function applyTrackAlbumMove(
  preview: TrackAlbumMovePreview,
  confirmLowerQualityReplace = false,
): Promise<TrackAlbumMoveApplyResult> {
  await stopPlaybackIfCurrentTrack([preview.source.id])
  const result = await window.api.tracks.applyAlbumMove({ previewId: preview.previewId, confirmLowerQualityReplace })
  await useLibraryStore.getState().refresh()
  return result
}

async function refreshMetadataCompletionPrompt(folderId: number): Promise<void> {
  try {
    const result = await window.api.tracks.findMetadataCompletionTargets(folderId, 24)
    useLibraryStore.setState({
      metadataCompletionPrompt: result.targets.length > 0
        ? {
            folderId,
            totalCandidates: result.totalCandidates,
            trackIds: result.targets.map(target => target.trackId),
          }
        : null,
    })
  } catch {
    useLibraryStore.setState({ metadataCompletionPrompt: null })
  }
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

export const TRACK_DELETE_ROW_MS = 240
export const TRACK_DELETE_ROW_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)'
// The collapse transition starts ~2 rAF after `markDeletingTracks` (React commit
// + the double requestAnimationFrame in TrackTable), so the `wait` clock leads
// the animation by ~20-40ms. Hold a small buffer before unmounting the row so it
// has fully reached height 0 — otherwise removing it at exactly 240ms pops.
const TRACK_DELETE_SETTLE_MS = TRACK_DELETE_ROW_MS + 64
const TRACK_DELETE_VOLUME_FADE_MS = 130
const TRACK_DELETE_PLAYER_CLOSE_MS = 280

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function getTrackDeleteVisualDelayMs(): number {
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    return 0
  }
  return TRACK_DELETE_SETTLE_MS
}

function notifyTrashFailures(failed: TrashTracksResult['failed']): void {
  if (failed.length === 0) return
  const first = failed[0]
  useActivityCenterStore.getState().upsert({
    id: `track-trash-failed:${failed.map(f => f.id).sort((a, b) => a - b).join('-')}`,
    category: 'library',
    status: 'error',
    title: failed.length === 1 ? 'No se pudo mover a Papelera' : `${failed.length} temas no se borraron`,
    detail: `${first?.title ?? ''}${first?.error ? ` · ${first.error}` : ''}`,
  })
}

function fadeAudioVolume(fromVol: number, toVol: number, durationMs: number): Promise<void> {
  const start = performance.now()
  return new Promise(resolve => {
    const tick = () => {
      const progress = Math.min(1, (performance.now() - start) / durationMs)
      void window.api.audio.setVolume(fromVol + (toVol - fromVol) * progress)
      if (progress < 1) requestAnimationFrame(tick)
      else resolve()
    }
    requestAnimationFrame(tick)
  })
}

export async function trashTracksWithAnimation(trackDbIds: number[]): Promise<void> {
  const ids = uniqueTrackDbIds(trackDbIds)
  if (ids.length === 0) return
  const idSet = new Set(ids)

  useLibraryStore.getState().markDeletingTracks(ids)

  const currentTrack = usePlaybackStore.getState().currentTrack
  const isPlayingDeleted = currentTrack?.dbId != null && idSet.has(currentTrack.dbId)
  const queueState = useQueueStore.getState()
  const hasNext = isPlayingDeleted && (queueState.currentIndex + 1) < queueState.tracks.length

  const prepareBeforeDelete = async () => {
    if (!isPlayingDeleted) return

    if (hasNext) {
      await useQueueStore.getState().next()
      return
    }

    const originalVol = usePlaybackStore.getState().volume
    await fadeAudioVolume(originalVol, 0, TRACK_DELETE_VOLUME_FADE_MS)
    await window.api.audio.stop()
    await window.api.audio.clearNext()
    usePlaybackStore.setState({
      status: 'stopped',
      currentTrack: null,
      streamInfo: null,
      positionSec: 0,
      durationSec: 0,
    })
    // Restore engine volume so the next playback session isn't silent.
    await window.api.audio.setVolume(originalVol)
    await delay(TRACK_DELETE_PLAYER_CLOSE_MS)
  }

  const { settled } = runTrackDeletionLifecycle({
    visualDelayMs: getTrackDeleteVisualDelayMs(),
    wait: delay,
    prepareBeforeDelete,
    // Remove the rows from the in-memory library the instant the collapse
    // animation finishes — the list settles without waiting on the drive.
    settleUi: () => useLibraryStore.getState().applyOptimisticTrash(ids),
    deleteTracks: () => window.api.tracks.trash(ids),
    afterDelete: result => {
      pruneDeletedTracksFromQueue(result.trashedTrackIds)
      notifyTrashFailures(result.failed)
    },
    // Reconcile against the DB once the disk settles: tracks that failed to
    // trash are still in the DB and reappear; successfully trashed ones stay
    // gone. Clear `pendingTrashIds` first so the refresh restores the failures.
    reconcile: () => {
      const store = useLibraryStore.getState()
      store.clearPendingTrash(ids)
      store.clearDeletingTracks(ids)
      return store.refresh()
    },
  })

  // Only wait for the UI to settle; the disk trash + reconcile run in the
  // background and must never block the caller (or the deletion animation).
  await settled
}

let libraryListenerCleanups: Array<() => void> | null = null

function initializeLibraryListeners(): void {
  if (typeof window === 'undefined' || !window.api?.library) return
  if (libraryListenerCleanups) {
    for (const off of libraryListenerCleanups) off()
    libraryListenerCleanups = null
  }
  let refreshDebounce: number | undefined
  const scheduleRefresh = () => {
    if (refreshDebounce) window.clearTimeout(refreshDebounce)
    refreshDebounce = window.setTimeout(() => {
      // Skip while deletion animations are in progress; trashTracksWithAnimation
      // triggers the refresh itself after animations complete.
      if (useLibraryStore.getState().deletingTrackIds.size > 0) return
      void useLibraryStore.getState().refresh()
    }, 200)
  }

  const offProgress = window.api.library.onImportProgress(payload => {
    useLibraryStore.setState({ importing: payload })
  })
  const offComplete = window.api.library.onImportComplete(payload => {
    useLibraryStore.setState({ importing: null })
    scheduleRefresh()
    void refreshMetadataCompletionPrompt(payload.folderId)
  })
  const offChanged = window.api.library.onLibraryChanged(scheduleRefresh)
  libraryListenerCleanups = [
    offProgress,
    offComplete,
    offChanged,
    () => {
      if (refreshDebounce) window.clearTimeout(refreshDebounce)
    },
  ]
}

initializeLibraryListeners()

if (typeof import.meta !== 'undefined' && (import.meta as { hot?: { dispose: (cb: () => void) => void } }).hot) {
  (import.meta as { hot: { dispose: (cb: () => void) => void } }).hot.dispose(() => {
    if (libraryListenerCleanups) {
      for (const off of libraryListenerCleanups) off()
      libraryListenerCleanups = null
    }
  })
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

// Visible library views always represent the full local library. Source-folder
// management stays in Preferences and device sync settings, not the sidebar.
export function useVisibleTracks(): Track[] {
  return useLibraryStore(s => s.tracks)
}
export function useVisibleAlbums(): Album[] {
  return useLibraryStore(s => s.albums)
}
export function useVisibleArtists(): Artist[] {
  const artists = useLibraryStore(s => s.artists)
  const albums = useLibraryStore(s => s.albums)
  const source = useTweakStore(s => s.tweak.artistCreditSource)
  return useMemo(
    () => buildDisplayedArtists(artists, albums, source),
    [albums, artists, source],
  )
}

export const useDeletingTrackIds = (): Set<number> => useLibraryStore(s => s.deletingTrackIds)

// Memoize filtered favorites by source-array identity so subscribers don't
// re-run `filter` on every store notification — the lists only need to be
// recomputed when the underlying artists/tracks array reference changes.
const favoriteArtistsCache = new WeakMap<Artist[], Artist[]>()
const favoriteTracksCache = new WeakMap<Track[], Track[]>()

export function useFavoriteArtists(): Artist[] {
  return useLibraryStore(useShallow(s => {
    const cached = favoriteArtistsCache.get(s.artists)
    if (cached) return cached
    const computed = s.artists.filter(ar => ar.favorite)
    favoriteArtistsCache.set(s.artists, computed)
    return computed
  }))
}

export function useFavoriteTracks(): Track[] {
  return useLibraryStore(useShallow(s => {
    const cached = favoriteTracksCache.get(s.tracks)
    if (cached) return cached
    const computed = s.tracks.filter(t => t.loved)
    favoriteTracksCache.set(s.tracks, computed)
    return computed
  }))
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

export function useMetadataCompletionPrompt(): LibraryState['metadataCompletionPrompt'] {
  return useLibraryStore(s => s.metadataCompletionPrompt)
}

export function useAlbumByUiId(uiId: string | undefined): Album | undefined {
  return useLibraryStore(s => (uiId ? s.albums.find(a => a.id === uiId) : undefined))
}

export function useArtistByUiId(uiId: string | undefined): Artist | undefined {
  const artists = useVisibleArtists()
  return useMemo(
    () => (uiId ? artists.find(artist => artist.id === uiId) : undefined),
    [artists, uiId],
  )
}
