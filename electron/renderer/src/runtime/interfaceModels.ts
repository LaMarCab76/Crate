import type { Album, Artist, Playlist, Track } from '@shared/types/library'

// The SDK deliberately uses display models, never provider tokens or paths.
export function interfaceTrack(track: Track) {
  return {
    id: track.dbId ?? track.id, title: track.t, artist: track.artist,
    album: track.albumTitle, albumId: track.albumId, duration: track.d,
    format: track.fmt, quality: track.q, loved: track.loved,
    artworkUrl: track.artworkPath ? `crate://artwork/${encodeURIComponent(track.artworkPath)}` : null,
  }
}

export function interfaceAlbum(album: Album) {
  return { id: album.id, title: album.title, artist: album.artist, year: album.year, trackCount: album.tracks.length }
}

export function interfaceArtist(artist: Artist) {
  return { id: artist.id, name: artist.name, trackCount: artist.trackCount, albumCount: artist.albums.length }
}

export function interfacePlaylist(playlist: Playlist) {
  return { id: playlist.id, name: playlist.name, trackCount: playlist.count }
}

export function interfaceParams(value: unknown): Record<string, unknown> {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Los parámetros deben ser un objeto.')
  return value as Record<string, unknown>
}

export function interfacePage<T>(items: readonly T[], params: Record<string, unknown>) {
  const offset = params.offset == null ? 0 : params.offset
  const limit = params.limit == null ? 100 : params.limit
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('offset debe ser un entero positivo o cero.')
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 250) throw new Error('limit debe estar entre 1 y 250.')
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit }
}

export function interfaceNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} debe estar entre ${min} y ${max}.`)
  return value
}
