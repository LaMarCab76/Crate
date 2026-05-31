import type { DeviceArtworkAnalysisItem } from '@shared/types/device-sync'

export type ArtworkOptimizeSearchScope = 'artist' | 'tracks' | 'all'
export type ArtworkOptimizeViewMode = 'artist' | 'album'

export interface ArtworkOptimizeGroup {
  key: string
  title: string
  subtitle: string
  itemCount: number
  maxWidth: number | null
  maxHeight: number | null
  items: DeviceArtworkAnalysisItem[]
}

export function normalizeArtworkSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
}

export function artworkSearchTokens(query: string): string[] {
  const normalized = normalizeArtworkSearchText(query)
  return normalized ? normalized.split(' ') : []
}

function artworkSearchFields(
  item: DeviceArtworkAnalysisItem,
  scope: ArtworkOptimizeSearchScope,
): string[] {
  if (scope === 'artist') return [item.artist]
  if (scope === 'tracks') return [item.title, item.album, item.relativePath]
  return [item.artist, item.title, item.album, item.relativePath]
}

export function artworkItemMatchesSearch(
  item: DeviceArtworkAnalysisItem,
  query: string,
  scope: ArtworkOptimizeSearchScope,
): boolean {
  const tokens = artworkSearchTokens(query)
  if (tokens.length === 0) return false
  const haystack = normalizeArtworkSearchText(artworkSearchFields(item, scope).join(' '))
  return tokens.every(token => haystack.includes(token))
}

export function filterArtworkItemsForSearch(
  items: DeviceArtworkAnalysisItem[],
  query: string,
  scope: ArtworkOptimizeSearchScope,
): DeviceArtworkAnalysisItem[] {
  if (artworkSearchTokens(query).length === 0) return items
  return items.filter(item => artworkItemMatchesSearch(item, query, scope))
}

export function selectedArtworkItemsForSearch({
  items,
  query,
  scope,
  excludedKeys,
}: {
  items: DeviceArtworkAnalysisItem[]
  query: string
  scope: ArtworkOptimizeSearchScope
  excludedKeys: ReadonlySet<string>
}): DeviceArtworkAnalysisItem[] {
  if (artworkSearchTokens(query).length === 0) return []
  return items.filter(item =>
    !excludedKeys.has(item.key) && artworkItemMatchesSearch(item, query, scope),
  )
}

export function selectedArtworkItemsFromGroup(
  group: ArtworkOptimizeGroup | null | undefined,
  excludedKeys: ReadonlySet<string>,
): DeviceArtworkAnalysisItem[] {
  if (!group) return []
  return group.items.filter(item => !excludedKeys.has(item.key))
}

function fallbackArtist(value: string): string {
  return value.trim() || 'Unknown Artist'
}

function fallbackAlbum(value: string): string {
  return value.trim() || 'Unknown Album'
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function groupKeyForArtworkItem(item: DeviceArtworkAnalysisItem, mode: ArtworkOptimizeViewMode): string {
  if (mode === 'artist') return `artist:${normalizeArtworkSearchText(fallbackArtist(item.artist))}`
  return [
    'album',
    normalizeArtworkSearchText(fallbackArtist(item.artist)),
    normalizeArtworkSearchText(fallbackAlbum(item.album)),
  ].join(':')
}

export function groupArtworkItems(
  items: DeviceArtworkAnalysisItem[],
  mode: ArtworkOptimizeViewMode,
): ArtworkOptimizeGroup[] {
  const groups = new Map<string, ArtworkOptimizeGroup>()
  const albumSets = new Map<string, Set<string>>()
  const artistSets = new Map<string, Set<string>>()

  for (const item of items) {
    const key = groupKeyForArtworkItem(item, mode)
    const artist = fallbackArtist(item.artist)
    const album = fallbackAlbum(item.album)
    let group = groups.get(key)

    if (!group) {
      group = {
        key,
        title: mode === 'artist' ? artist : album,
        subtitle: mode === 'artist' ? '' : artist,
        itemCount: 0,
        maxWidth: null,
        maxHeight: null,
        items: [],
      }
      groups.set(key, group)
      albumSets.set(key, new Set())
      artistSets.set(key, new Set())
    }

    group.items.push(item)
    group.itemCount += 1
    albumSets.get(key)?.add(album)
    artistSets.get(key)?.add(artist)

    const currentEdge = Math.max(group.maxWidth ?? 0, group.maxHeight ?? 0)
    const itemEdge = Math.max(item.width ?? 0, item.height ?? 0)
    if (itemEdge > currentEdge) {
      group.maxWidth = item.width
      group.maxHeight = item.height
    }
  }

  for (const [key, group] of groups) {
    if (mode === 'artist') {
      group.subtitle = pluralize(albumSets.get(key)?.size ?? 0, 'álbum', 'álbumes')
    } else {
      const artistCount = artistSets.get(key)?.size ?? 0
      if (artistCount > 1) group.subtitle = pluralize(artistCount, 'artista', 'artistas')
    }
  }

  return [...groups.values()].sort((a, b) => {
    const title = a.title.localeCompare(b.title)
    if (title !== 0) return title
    return a.subtitle.localeCompare(b.subtitle)
  })
}

export function shouldShowArtworkSearchResults(query: string): boolean {
  return artworkSearchTokens(query).length > 0
}
