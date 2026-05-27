import type { Album, Artist, Track } from '@shared/types/library'

export type SortDirection = 'asc' | 'desc'

export type ListViewKind =
  | 'library'
  | 'albums'
  | 'artists'
  | 'genres'
  | 'playlist'
  | 'favoriteTracks'
  | 'album'
  | 'artist'

export type LibraryTrackSortBy = 'dateAdded' | 'title' | 'artist' | 'album' | 'plays' | 'duration'
export type AlbumsSortBy = 'dateAdded' | 'title' | 'artist' | 'year'
export type ArtistsSortBy = 'name' | 'albumCount' | 'trackCount' | 'favorite'
export type GenresSortBy = 'name' | 'albumCount'
export type PlaylistTrackSortBy = 'title' | 'album' | 'artist' | 'plays' | 'duration' | 'dateAdded'
export type AlbumTrackSortBy = 'trackNo' | 'title' | 'duration' | 'plays'
export type GenreAlbumSortBy = 'dateAdded' | 'title' | 'artist' | 'year'
export type ArtistTrackSortBy = AlbumTrackSortBy
export type ArtistAlbumSortBy = 'year' | 'title' | 'trackCount'

interface BaseLibraryFilters {
  query: string
}

type YearBoundary = number | null

interface DirectionalPrefs {
  sortDir: SortDirection
}

export interface LibraryListPrefs extends BaseLibraryFilters, DirectionalPrefs {
  sortBy: LibraryTrackSortBy
  favoritesOnly: boolean
}

export interface AlbumsListPrefs extends BaseLibraryFilters, DirectionalPrefs {
  sortBy: AlbumsSortBy
  onlyWithArtwork: boolean
  yearMin: YearBoundary
  yearMax: YearBoundary
}

export interface ArtistsListPrefs extends BaseLibraryFilters, DirectionalPrefs {
  sortBy: ArtistsSortBy
  principalOnly: boolean
}

export interface GenresListPrefs extends BaseLibraryFilters, DirectionalPrefs {
  sortBy: GenresSortBy
  albumSortBy: GenreAlbumSortBy
  albumSortDir: SortDirection
}

export interface PlaylistListPrefs extends BaseLibraryFilters, DirectionalPrefs {
  sortBy: PlaylistTrackSortBy
  favoritesOnly: boolean
}

export interface AlbumListPrefs {
  trackSortBy: AlbumTrackSortBy
  trackSortDir: SortDirection
}

export interface ArtistListPrefs extends BaseLibraryFilters, DirectionalPrefs {
  albumSortBy: ArtistAlbumSortBy
  albumSortDir: SortDirection
  trackSortBy: ArtistTrackSortBy
  trackSortDir: SortDirection
}

export interface ListPrefsMap {
  library: LibraryListPrefs
  albums: AlbumsListPrefs
  artists: ArtistsListPrefs
  genres: GenresListPrefs
  playlist: PlaylistListPrefs
  favoriteTracks: PlaylistListPrefs
  album: AlbumListPrefs
  artist: ArtistListPrefs
}

const TEXT_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase()
}

function compareDirection(result: number, direction: SortDirection): number {
  return direction === 'asc' ? result : -result
}

function compareText(a: string, b: string, direction: SortDirection): number {
  return compareDirection(TEXT_COLLATOR.compare(a ?? '', b ?? ''), direction)
}

function compareNumber(a: number, b: number, direction: SortDirection): number {
  return compareDirection(a - b, direction)
}

function compareDate(a: string, b: string, direction: SortDirection): number {
  const at = Date.parse(a ?? '')
  const bt = Date.parse(b ?? '')
  const aSafe = Number.isNaN(at) ? Number.MIN_SAFE_INTEGER : at
  const bSafe = Number.isNaN(bt) ? Number.MIN_SAFE_INTEGER : bt
  return compareDirection(aSafe - bSafe, direction)
}

function stableTieBreak(a: { id: string }, b: { id: string }): number {
  return TEXT_COLLATOR.compare(a.id, b.id)
}

export function trackMatchesQuery(track: Track, query: string): boolean {
  const q = normalizeQuery(query)
  if (!q) return true

  return [track.t, track.artist, track.albumTitle, track.genre]
    .some(v => normalizeQuery(v || '').includes(q))
}

function albumMatchesQuery(album: Album, query: string): boolean {
  const q = normalizeQuery(query)
  if (!q) return true
  return [album.title, album.artist, album.genre]
    .some(v => normalizeQuery(v || '').includes(q))
}

export function sortTracks(
  tracks: readonly Track[],
  sortBy: LibraryTrackSortBy | PlaylistTrackSortBy | AlbumTrackSortBy,
  direction: SortDirection,
): Track[] {
  return [...tracks].sort((a, b) => {
    let result: number

    switch (sortBy) {
      case 'dateAdded':
        result = compareDate(a.added, b.added, direction)
        break
      case 'title':
        result = compareText(a.t, b.t, direction)
        break
      case 'artist':
        result = compareText(a.artist, b.artist, direction)
        break
      case 'album':
        result = compareText(a.albumTitle, b.albumTitle, direction)
        break
      case 'plays':
        result = compareNumber(a.plays, b.plays, direction)
        break
      case 'duration':
        result = compareNumber(a.d, b.d, direction)
        break
      case 'trackNo': {
        const aDisc = a.discNumber != null && a.discNumber > 0 ? a.discNumber : Number.MAX_SAFE_INTEGER
        const bDisc = b.discNumber != null && b.discNumber > 0 ? b.discNumber : Number.MAX_SAFE_INTEGER
        result = compareNumber(aDisc, bDisc, direction)
        if (result !== 0) break

        const an = a.no || Number.MAX_SAFE_INTEGER
        const bn = b.no || Number.MAX_SAFE_INTEGER
        result = compareNumber(an, bn, direction)
        break
      }
      default:
        result = 0
    }

    return result === 0 ? stableTieBreak(a, b) : result
  })
}

export function sortAlbums(albums: readonly Album[], sortBy: AlbumsSortBy | GenreAlbumSortBy, direction: SortDirection): Album[] {
  return [...albums].sort((a, b) => {
    let result = 0

    if (sortBy === 'dateAdded') {
      result = compareDate(a.added, b.added, direction)
    } else if (sortBy === 'title') {
      result = compareText(a.title, b.title, direction)
    } else if (sortBy === 'artist') {
      result = compareText(a.artist, b.artist, direction)
    } else if (sortBy === 'year') {
      result = compareNumber(a.year, b.year, direction)
    }

    return result === 0 ? compareDirection(TEXT_COLLATOR.compare(a.id, b.id), 'asc') : result
  })
}

export function sortArtistAlbums(albums: readonly Album[], sortBy: ArtistAlbumSortBy, direction: SortDirection): Album[] {
  return [...albums].sort((a, b) => {
    let result = 0

    if (sortBy === 'year') {
      result = compareNumber(a.year, b.year, direction)
    } else if (sortBy === 'title') {
      result = compareText(a.title, b.title, direction)
    } else {
      result = compareNumber(a.tracks.length, b.tracks.length, direction)
    }

    return result === 0 ? compareDirection(TEXT_COLLATOR.compare(a.id, b.id), 'asc') : result
  })
}

export function sortArtists(artists: readonly Artist[], sortBy: ArtistsSortBy, direction: SortDirection): Artist[] {
  return [...artists].sort((a, b) => {
    let result = 0

    if (sortBy === 'name') {
      result = compareText(a.name, b.name, direction)
    } else if (sortBy === 'albumCount') {
      result = compareNumber(a.albums.length, b.albums.length, direction)
    } else if (sortBy === 'trackCount') {
      result = compareNumber(a.trackCount, b.trackCount, direction)
    } else if (sortBy === 'favorite') {
      const af = a.favorite ? 1 : 0
      const bf = b.favorite ? 1 : 0
      result = compareNumber(af, bf, direction)
    }

    return result === 0 ? compareText(a.id, b.id, 'asc') : result
  })
}

export function sortGenreGroupsByNameOrCount(entries: [string, Album[]][], sortBy: GenresSortBy, direction: SortDirection): [string, Album[]][] {
  return [...entries].sort((a, b) => {
    const aName = a[0]
    const bName = b[0]

    let result = 0
    if (sortBy === 'name') {
      result = compareText(aName, bName, direction)
    } else {
      result = compareNumber(a[1].length, b[1].length, direction)
      if (result === 0) {
        result = compareText(aName, bName, 'asc')
      }
    }

    return result
  })
}

export function createListPrefsDefaults(): ListPrefsMap {
  return {
    library: {
      sortBy: 'dateAdded',
      sortDir: 'desc',
      query: '',
      favoritesOnly: false,
    },
    albums: {
      sortBy: 'dateAdded',
      sortDir: 'desc',
      query: '',
      onlyWithArtwork: false,
      yearMin: null,
      yearMax: null,
    },
    artists: {
      sortBy: 'name',
      sortDir: 'asc',
      query: '',
      principalOnly: false,
    },
    genres: {
      sortBy: 'name',
      sortDir: 'asc',
      query: '',
      albumSortBy: 'dateAdded',
      albumSortDir: 'desc',
    },
    playlist: {
      sortBy: 'dateAdded',
      sortDir: 'desc',
      query: '',
      favoritesOnly: false,
    },
    favoriteTracks: {
      sortBy: 'dateAdded',
      sortDir: 'desc',
      query: '',
      favoritesOnly: true,
    },
    album: {
      trackSortBy: 'trackNo',
      trackSortDir: 'asc',
    },
    artist: {
      sortDir: 'desc',
      query: '',
      albumSortBy: 'year',
      albumSortDir: 'desc',
      trackSortBy: 'trackNo',
      trackSortDir: 'asc',
    },
  }
}

export {
  albumMatchesQuery,
  compareDirection,
  normalizeQuery,
}
