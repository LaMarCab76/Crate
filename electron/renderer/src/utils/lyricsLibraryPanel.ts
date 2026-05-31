import type { LyricsLibraryItem } from '@shared/types/lyrics'

export type LyricsLibraryTab = 'missing' | 'with'

export interface LyricsLibraryCounts {
  total: number
  withLyrics: number
  missingLyrics: number
}

export function lyricsLibraryCounts(items: LyricsLibraryItem[]): LyricsLibraryCounts {
  const withLyrics = items.filter(item => item.hasLyrics).length
  return {
    total: items.length,
    withLyrics,
    missingLyrics: items.length - withLyrics,
  }
}

export function filterLyricsLibraryItems(
  items: LyricsLibraryItem[],
  tab: LyricsLibraryTab,
  query: string,
): LyricsLibraryItem[] {
  const q = query.trim().toLocaleLowerCase()
  return items.filter(item => {
    if (tab === 'missing' ? item.hasLyrics : !item.hasLyrics) return false
    if (!q) return true
    return [item.title, item.artist, item.album]
      .some(value => value.toLocaleLowerCase().includes(q))
  })
}

export function pruneLyricsSelection(
  selectedTrackIds: Iterable<number>,
  items: LyricsLibraryItem[],
): Set<number> {
  const missing = new Set(items.filter(item => !item.hasLyrics).map(item => item.trackId))
  const next = new Set<number>()
  for (const id of selectedTrackIds) {
    if (missing.has(id)) next.add(id)
  }
  return next
}
