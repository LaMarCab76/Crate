// Keeps a manually edited track in the album it already shares with its
// siblings when only a minor field changed (year, album artist casing...), so
// editing one track doesn't split an album in two. Pure: loaded by node --test.

export interface AlbumHintTrack {
  album: string
  artist: string
  album_artist: string | null
  album_id: number | null
}

function normText(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function albumOwner(track: Pick<AlbumHintTrack, 'artist' | 'album_artist'>): string {
  return normText(track.album_artist) || normText(track.artist)
}

// Returns the album id the edited track should keep, or null to let the caller
// resolve the album from the tags. Only a library album with the SAME name and
// the SAME album artist qualifies. There is deliberately no "most common album
// among the candidates" fallback: candidates span the whole library root, and
// that fallback used to drop a track renamed to its original album into
// whichever album happened to be the biggest.
export function resolveAlbumFromFolderHints(track: AlbumHintTrack, candidates: readonly AlbumHintTrack[]): number | null {
  const albumName = normText(track.album)
  if (!albumName || candidates.length === 0) return null
  const owner = albumOwner(track)

  const sameAlbum = candidates.filter(candidate => candidate.album_id != null && normText(candidate.album) === albumName)
  const sameOwner = sameAlbum.filter(candidate => albumOwner(candidate) === owner)
  const ids = new Set(sameOwner.map(candidate => candidate.album_id as number))
  if (ids.size !== 1) return null
  const [albumId] = ids
  return albumId
}
