import type { DbTrack } from '@shared/types/db'
import type { LyricsLibraryItem, LyricsLibraryOverview, LyricsView } from '@shared/types/lyrics'

export function lyricsViewHasLibraryLyrics(view: LyricsView): boolean {
  return (
    view.status === 'found_synced' ||
    view.status === 'found_plain' ||
    view.status === 'instrumental'
  )
}

export function toLyricsLibraryItem(track: DbTrack, view: LyricsView): LyricsLibraryItem {
  return {
    trackId: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    path: track.path,
    status: view.status,
    source: view.source,
    hasLyrics: lyricsViewHasLibraryLyrics(view),
    sidecarWritten: view.sidecarWritten,
    embeddedInFile: view.embeddedInFile,
  }
}

export function buildLyricsLibraryOverview(
  tracks: DbTrack[],
  resolveView: (trackId: number) => LyricsView,
): LyricsLibraryOverview {
  const items = tracks
    .map(track => toLyricsLibraryItem(track, resolveView(track.id)))
    .sort((a, b) => {
      const artist = a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' })
      if (artist !== 0) return artist
      const album = a.album.localeCompare(b.album, undefined, { sensitivity: 'base' })
      if (album !== 0) return album
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    })
  const withLyrics = items.filter(item => item.hasLyrics).length
  return {
    total: items.length,
    withLyrics,
    missingLyrics: items.length - withLyrics,
    items,
  }
}
