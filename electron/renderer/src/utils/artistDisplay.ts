import type { Album, Artist, Pattern, Track } from '@shared/types/library'

export type ArtistCreditSource = 'album' | 'both' | 'track'

const PATTERNS: Pattern[] = ['circles', 'sun', 'rays', 'grid', 'wave', 'stripes', 'rings', 'half', 'diag', 'lines']

interface ArtistAccumulator {
  base?: Artist
  name: string
  albums: Map<string, Album>
}

export function normalizeArtistCredit(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function hashSeed(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index)
    hash |= 0
  }
  return Math.abs(hash) || 1
}

function trackKey(track: Track): string {
  return track.dbId != null ? `db:${track.dbId}` : track.id
}

function mergeAlbumTracks(existing: Album | undefined, album: Album, incoming: Track[]): Album {
  if (!existing) return incoming.length === album.tracks.length ? album : { ...album, tracks: incoming }

  const included = new Set([...existing.tracks, ...incoming].map(trackKey))
  const tracks = album.tracks.filter(track => included.has(trackKey(track)))
  return tracks.length === album.tracks.length ? album : { ...album, tracks }
}

function addAlbum(entry: ArtistAccumulator, album: Album, tracks: Track[]): void {
  if (tracks.length === 0) return
  entry.albums.set(album.id, mergeAlbumTracks(entry.albums.get(album.id), album, tracks))
}

function compareAlbums(a: Album, b: Album): number {
  if (a.year !== b.year) return b.year - a.year
  const byAdded = (b.added || '').localeCompare(a.added || '')
  if (byAdded !== 0) return byAdded
  return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
}

function countTracks(albums: Album[]): number {
  const ids = new Set<string>()
  for (const album of albums) {
    for (const track of album.tracks) ids.add(trackKey(track))
  }
  return ids.size
}

function syntheticArtist(entry: ArtistAccumulator, normalizedName: string, albums: Album[]): Artist {
  const seed = hashSeed(normalizedName)
  return {
    id: `ar-album:${encodeURIComponent(normalizedName)}`,
    name: entry.name,
    albums,
    seed,
    palette: [
      `hsl(${seed % 360}, 30%, 12%)`,
      `hsl(${(seed + 25) % 360}, 35%, 28%)`,
      `hsl(${(seed + 50) % 360}, 45%, 65%)`,
    ],
    pattern: PATTERNS[seed % PATTERNS.length],
    artworkPath: albums.find(album => album.artworkPath)?.artworkPath,
    trackCount: countTracks(albums),
  }
}

function materializeArtist(entry: ArtistAccumulator, normalizedName: string): Artist {
  const albums = [...entry.albums.values()].sort(compareAlbums)
  if (!entry.base) return syntheticArtist(entry, normalizedName, albums)

  const groupedArtwork = albums.find(album => album.artworkPath)?.artworkPath
  return {
    ...entry.base,
    albums,
    artworkPath: entry.base.artworkSourceType
      ? entry.base.artworkPath
      : groupedArtwork ?? entry.base.artworkPath,
    trackCount: countTracks(albums),
  }
}

/**
 * Builds the Artists view from the selected metadata credit source.
 * Album credits include the complete album; track credits include only the
 * tracks credited to that artist. When both credits point to the same artist,
 * their album/track sets are merged without duplicates.
 */
export function buildDisplayedArtists(
  trackArtists: Artist[],
  albums: Album[],
  source: ArtistCreditSource,
): Artist[] {
  const rawByName = new Map(
    trackArtists.map(artist => [normalizeArtistCredit(artist.name), artist] as const),
  )
  const entries = new Map<string, ArtistAccumulator>()

  const ensureEntry = (name: string, base?: Artist): ArtistAccumulator | null => {
    const trimmed = name.trim()
    const normalized = normalizeArtistCredit(trimmed)
    if (!normalized) return null
    const existing = entries.get(normalized)
    if (existing) {
      if (!existing.base && base) existing.base = base
      return existing
    }
    const entry = { base, name: base?.name ?? trimmed, albums: new Map<string, Album>() }
    entries.set(normalized, entry)
    return entry
  }

  if (source === 'track' || source === 'both') {
    for (const artist of trackArtists) {
      const entry = ensureEntry(artist.name, artist)
      if (!entry) continue
      for (const album of albums) {
        const creditedTracks = album.tracks.filter(track => track.artistId === artist.id)
        addAlbum(entry, album, creditedTracks)
      }
    }
  }

  if (source === 'album' || source === 'both') {
    for (const album of albums) {
      const albumArtist = album.artist.trim()
      if (!albumArtist) continue
      const normalized = normalizeArtistCredit(albumArtist)
      const entry = ensureEntry(albumArtist, rawByName.get(normalized))
      if (entry) addAlbum(entry, album, album.tracks)
    }
  }

  return [...entries.entries()]
    .map(([normalizedName, entry]) => materializeArtist(entry, normalizedName))
    .filter(artist => artist.trackCount > 0)
}
