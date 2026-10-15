import { useEffect, useRef } from 'react'
import type { InterfaceGuestRequest } from '@shared/types/interfaces'
import { useLibraryStore } from '../stores/libraryStore'
import { usePlaybackStore } from '../stores/playbackStore'
import { useQueueStore } from '../stores/queueStore'
import { interfaceAlbum, interfaceArtist, interfaceNumber, interfacePage, interfaceParams, interfacePlaylist, interfaceTrack } from './interfaceModels'
import { readyInterfaceLibrary } from './interfaceReadiness'

export async function executeInterfaceRequest(request: InterfaceGuestRequest, navigate: (route: string) => void): Promise<unknown> {
  const p = interfaceParams(request.params)
  const needsLibrary = request.method.startsWith('library.') || request.method === 'playback.playTrack' || request.method === 'queue.add' || request.method === 'queue.play' && p.index == null
  const library = needsLibrary ? await readyInterfaceLibrary(useLibraryStore.getState) : useLibraryStore.getState()
  const queue = useQueueStore.getState()
  const playback = usePlaybackStore.getState()
  const query = typeof p.query === 'string' ? p.query.slice(0, 500).toLocaleLowerCase() : ''
  const page = <T, R,>(items: T[], model: (item: T) => R) => { const result = interfacePage(items, p); return { ...result, items: result.items.map(model) } }
  const matching = <T,>(items: T[], title: (value: T) => string) => query ? items.filter(item => title(item).toLocaleLowerCase().includes(query)) : items
  const trackById = (id: unknown) => {
    if (typeof id !== 'string' && typeof id !== 'number') throw new Error('Falta el identificador de canción.')
    const track = library.tracks.find(item => item.id === String(id) || item.dbId === id)
    if (!track) throw new Error('La canción ya no está disponible.')
    return track
  }
  const requestedTracks = () => {
    const ids = p.ids ?? [p.trackId ?? p.id]
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 250) throw new Error('Elegí entre 1 y 250 canciones.')
    return ids.map(trackById)
  }
  switch (request.method) {
    case 'queue.list': return { ...page(queue.tracks, interfaceTrack), currentIndex: queue.currentIndex, shuffle: queue.shuffle, repeat: queue.repeat }
    case 'library.trackCount': return library.trackCount
    case 'library.tracks': return page(matching(library.tracks, track => `${track.t} ${track.artist} ${track.albumTitle}`), interfaceTrack)
    case 'library.albums': return page(matching(library.albums, album => `${album.title} ${album.artist}`), interfaceAlbum)
    case 'library.artists': return page(matching(library.artists, artist => artist.name), interfaceArtist)
    case 'library.playlists': return page(matching(library.playlists, playlist => playlist.name), interfacePlaylist)
    case 'library.albumTracks': {
      const album = library.albums.find(item => item.id === p.id || item.id === `a${p.id}`)
      if (!album) throw new Error('El álbum ya no está disponible.')
      return page(album.tracks, interfaceTrack)
    }
    case 'library.artistTracks': {
      const artist = library.artists.find(item => item.id === p.id || item.dbId === p.id)
      if (!artist) throw new Error('El artista ya no está disponible.')
      return page(artist.albums.flatMap(album => album.tracks), interfaceTrack)
    }
    case 'library.playlistTracks': {
      const playlist = library.playlists.find(item => item.id === p.id)
      if (!playlist) throw new Error('La playlist ya no está disponible.')
      return page(playlist.tracks, interfaceTrack)
    }
    case 'library.search': return {
      tracks: page(matching(library.tracks, item => `${item.t} ${item.artist} ${item.albumTitle}`), interfaceTrack),
      albums: page(matching(library.albums, item => `${item.title} ${item.artist}`), interfaceAlbum),
      artists: page(matching(library.artists, item => item.name), interfaceArtist),
    }
    case 'playback.toggle': await queue.togglePlay(); return null
    case 'playback.play':
      if (playback.currentTrack) await window.api.audio.play()
      else if (queue.tracks.length) await queue.jumpTo(Math.max(0, queue.currentIndex))
      else throw new Error('Elegí una canción para reproducir.')
      return null
    case 'playback.pause': if (playback.status === 'playing') await window.api.audio.pause(); return null
    case 'playback.next': await queue.next(); return null
    case 'playback.previous': await queue.previous(); return null
    case 'playback.seek': await queue.seek(interfaceNumber(p.positionSec, 'positionSec', 0, playback.durationSec)); return null
    case 'playback.volume': await queue.setVolume(interfaceNumber(p.volume, 'volume', 0, 1)); return null
    case 'playback.playTrack': {
      const track = trackById(p.trackId ?? p.id)
      await queue.playNow(track, [track]); return null
    }
    case 'queue.add': queue.enqueue(requestedTracks()); return null
    case 'queue.play':
      if (p.index != null) {
        const index = interfaceNumber(p.index, 'index', 0, queue.tracks.length - 1)
        if (!Number.isInteger(index)) throw new Error('index debe ser un entero.')
        await queue.jumpTo(index)
      } else {
        const tracks = requestedTracks()
        await queue.playNow(tracks[0], tracks)
      }
      return null
    case 'queue.clear': queue.clear(); return null
    case 'queue.remove': {
      const index = interfaceNumber(p.index, 'index', 0, queue.tracks.length - 1)
      if (!Number.isInteger(index)) throw new Error('index debe ser un entero.')
      await queue.removeAt(index); return null
    }
    case 'navigation.openSettings': navigate('settings'); return null
    case 'navigation.go': {
      if (typeof p.route !== 'string' || p.route.length > 200) throw new Error('Destino inválido.')
      navigate(p.id == null ? p.route : `${p.route}:${String(p.id)}`)
      return null
    }
    default: throw new Error('Método del SDK no disponible.')
  }
}

export function useInterfaceBridge(navigate: (route: string) => void, route: string): void {
  const navigateRef = useRef(navigate)
  const routeRef = useRef(route)
  const publishRef = useRef<(() => void) | null>(null)
  navigateRef.current = navigate
  routeRef.current = route
  useEffect(() => {
    const api = window.api?.interfaces
    if (!api) return
    let disposed = false
    let pending: ReturnType<typeof setTimeout> | undefined
    const publish = () => {
      if (disposed) return
      const playback = usePlaybackStore.getState()
      const queue = useQueueStore.getState()
      void api.updateGuestState({
        playback: { status: playback.status, currentTrack: playback.currentTrack ? interfaceTrack(playback.currentTrack) : null, positionSec: playback.positionSec, durationSec: playback.durationSec, volume: playback.volume },
        queue: { tracks: queue.tracks.slice(0, 250).map(interfaceTrack), total: queue.tracks.length, currentIndex: queue.currentIndex, shuffle: queue.shuffle, repeat: queue.repeat },
        route: routeRef.current,
      }).catch(() => { /* guest may have been replaced */ })
    }
    publishRef.current = publish
    const schedule = () => {
      if (pending != null) return
      pending = setTimeout(() => { pending = undefined; publish() }, 200)
    }
    const offRequest = api.onRequest(request => {
      void executeInterfaceRequest(request, destination => navigateRef.current(destination)).then(
        result => api.respond({ requestId: request.requestId, result }),
        error => api.respond({ requestId: request.requestId, error: error instanceof Error ? error.message : 'No se pudo completar la acción.' }),
      ).catch(() => { /* request was cancelled on interface switch */ })
    })
    const offPlayback = usePlaybackStore.subscribe(schedule)
    const offQueue = useQueueStore.subscribe(schedule)
    const offSelection = api.onSelectionChanged(schedule)
    publish()
    return () => { publishRef.current = null; disposed = true; if (pending != null) clearTimeout(pending); offRequest(); offPlayback(); offQueue(); offSelection() }
  }, [])
  useEffect(() => {
    publishRef.current?.()
  }, [route])
}
