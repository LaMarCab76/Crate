import type { Album, Artist, Playlist } from '@shared/types/library'

export type View =
  | { kind: 'library' | 'recent' | 'albums' | 'artists' | 'genres' | 'search' | 'settings' | 'import' | 'devices' | 'favoriteTracks' }
  | { kind: 'device'; deviceId: string; section: 'dashboard' | 'sync' | 'library' | 'playlists' | 'rockboxThemes' }
  | { kind: 'album'; album: Album }
  | { kind: 'artist'; artist: Artist }
  | { kind: 'playlist'; playlist: Playlist }
  | { kind: 'metadataFix'; trackIds: number[]; title?: string; missingCount?: number }
  | { kind: 'duplicates'; candidateId?: string }

export interface RouteLibrary { albums: Album[]; artists: Artist[]; playlists: Playlist[] }

export function viewRoute(view: View): string {
  if (view.kind === 'album') return `album:${view.album.id}`
  if (view.kind === 'artist') return `artist:${view.artist.id}`
  if (view.kind === 'playlist') return `playlist:${view.playlist.id}`
  if (view.kind === 'device') return `device:${view.deviceId}:${view.section}`
  return view.kind
}

export function resolveRoute(route: string, library: RouteLibrary): View {
  const [kind, id, section] = route.split(':')
  switch (kind) {
    case 'album': {
      const album = library.albums.find(item => item.id === id || item.id === `a${id}`)
      if (!album) throw new Error('El álbum ya no está disponible.')
      return { kind, album }
    }
    case 'artist': {
      const artist = library.artists.find(item => item.id === id || item.dbId === Number(id))
      if (!artist) throw new Error('El artista ya no está disponible.')
      return { kind, artist }
    }
    case 'playlist': {
      const playlist = library.playlists.find(item => item.id === id || item.id === `p${id}`)
      if (!playlist) throw new Error('La playlist ya no está disponible.')
      return { kind, playlist }
    }
    case 'device':
      if (!id || !['dashboard', 'sync', 'library', 'playlists', 'rockboxThemes'].includes(section)) throw new Error('Destino de dispositivo inválido.')
      return { kind, deviceId: id, section: section as Extract<View, { kind: 'device' }>['section'] }
    case 'library': case 'recent': case 'albums': case 'artists': case 'genres': case 'search':
    case 'settings': case 'import': case 'devices': case 'favoriteTracks': case 'duplicates': return { kind }
    default: throw new Error(`Destino de Crate desconocido: ${route}`)
  }
}
