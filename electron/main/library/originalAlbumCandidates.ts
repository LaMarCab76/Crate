import { normalizeMetadataText, scoreMetadataCandidate } from './MetadataCompletionRules.ts'

// Finds the album a song ORIGINALLY belongs to from a MusicBrainz recording
// search. A track downloaded from a compilation (picked for its better audio)
// shares its recording with the artist's own album, so we aggregate every
// release of every matching recording, group them by release group and rank
// the groups so studio albums come before EPs/singles and compilations/live
// releases sink to the bottom. Kept free of electron/DB imports so node --test
// can load it directly.

const MIN_RECORDING_CONFIDENCE = 0.6
const DEFAULT_LIMIT = 8

export interface OriginalReleaseQuery {
  title: string
  artist: string
  durationSeconds: number | null
}

export interface RankedOriginalRelease {
  // Representative release of the group (earliest official edition).
  releaseId: string
  releaseGroupId: string | null
  // Every release of the group seen in the search, for local-album matching.
  releaseIds: string[]
  recordingId: string | null
  title: string
  artist: string
  date: string | null
  year: string | null
  country: string | null
  status: string | null
  primaryType: string | null
  secondaryTypes: string[]
  trackNumber: number | null
  discNumber: number | null
  totalTracks: number | null
  confidence: number
}

const VARIOUS_ARTISTS = new Set([
  'various artists',
  'various',
  'va',
  'v a',
  'varios artistas',
  'varios',
  'artistas varios',
  'multi artistas',
  'vários artistas',
  'divers',
  'artistes divers',
  'verschiedene interpreten',
  'aa vv',
  'aavv',
])

export function isVariousArtists(name: string | null | undefined): boolean {
  const normalized = normalizeMetadataText(name ?? '').replace(/[^a-z0-9À-ɏ ]+/g, ' ').replace(/\s+/g, ' ').trim()
  return normalized !== '' && VARIOUS_ARTISTS.has(normalized)
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((row): row is Record<string, unknown> => row != null) : []
}

function asString(value: unknown): string | null {
  if (value == null) return null
  const text = String(value).trim()
  return text || null
}

function asPositiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(n) && n > 0 ? n : null
}

function yearOf(date: string | null): string | null {
  const match = /\d{4}/.exec(date ?? '')
  return match ? match[0] : null
}

// Renders a MusicBrainz artist credit the way it's printed on the release
// ("Simon & Garfunkel", "Artist feat. Guest"), honouring join phrases.
export function formatArtistCredit(value: unknown): string | null {
  const credits = list(value)
  if (credits.length === 0) return null
  const text = credits
    .map((credit, index) => {
      const name = asString(credit['name']) ?? asString(record(credit['artist'])?.['name']) ?? ''
      const join = credit['joinphrase'] != null
        ? String(credit['joinphrase'])
        : index < credits.length - 1 ? ', ' : ''
      return `${name}${join}`
    })
    .join('')
    .trim()
  return text || null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => asString(item)).filter((item): item is string => item != null) : []
}

// Lower tier = better "original album" candidate. Release kind dominates the
// order (a single often predates its album, but the user wants the album).
export function originalReleaseTier(release: {
  primaryType: string | null
  secondaryTypes: string[]
  status: string | null
  artist: string | null
}): number {
  const primary = (release.primaryType ?? '').toLowerCase()
  let tier = primary === 'album' ? 0 : primary === 'ep' ? 1 : primary === 'single' ? 2 : primary === 'broadcast' ? 4 : 3
  const secondary = release.secondaryTypes.map(type => type.toLowerCase())
  if (secondary.includes('compilation') || isVariousArtists(release.artist)) tier += 10
  else if (secondary.some(type => type === 'dj-mix' || type === 'mixtape/street' || type === 'remix')) tier += 8
  else if (secondary.includes('live')) tier += 6
  else if (secondary.includes('soundtrack')) tier += 0.5
  else if (secondary.length > 0) tier += 4
  const status = (release.status ?? '').toLowerCase()
  if (status && status !== 'official') tier += 20
  return tier
}

function compareDates(a: string | null, b: string | null): number {
  if (a && b) return a.localeCompare(b)
  if (a) return -1
  if (b) return 1
  return 0
}

// Where the recording sits on this release, from the search result's media
// excerpt (MusicBrainz only returns the medium/track that matched).
function positionOnRelease(release: Record<string, unknown>): { trackNumber: number | null; discNumber: number | null; totalTracks: number | null } {
  for (const medium of list(release['media'])) {
    const tracks = list(medium['track'] ?? medium['tracks'])
    const first = tracks[0]
    if (!first) continue
    const offset = typeof medium['track-offset'] === 'number' ? medium['track-offset'] as number : null
    return {
      trackNumber: asPositiveInt(first['number']) ?? asPositiveInt(first['position']) ?? (offset != null ? offset + 1 : null),
      discNumber: asPositiveInt(medium['position']) ?? 1,
      totalTracks: asPositiveInt(medium['track-count']),
    }
  }
  return { trackNumber: null, discNumber: null, totalTracks: null }
}

export function rankOriginalReleases(
  recordingsJson: unknown,
  query: OriginalReleaseQuery,
  options: { limit?: number; minConfidence?: number } = {},
): RankedOriginalRelease[] {
  const minConfidence = options.minConfidence ?? MIN_RECORDING_CONFIDENCE
  const groups = new Map<string, RankedOriginalRelease[]>()

  for (const recording of list(recordingsJson)) {
    const recordingTitle = asString(recording['title'])
    const recordingArtist = formatArtistCredit(recording['artist-credit'])
    if (!recordingTitle || !recordingArtist) continue
    const confidence = scoreMetadataCandidate({
      title: query.title,
      artist: query.artist,
      album: null,
      durationSeconds: query.durationSeconds,
      candidateTitle: recordingTitle,
      candidateArtist: recordingArtist,
      candidateAlbum: null,
      candidateDurationSeconds: typeof recording['length'] === 'number' ? recording['length'] as number / 1000 : null,
    })
    if (confidence < minConfidence) continue

    for (const release of list(recording['releases'])) {
      const releaseId = asString(release['id'])
      const title = asString(release['title'])
      if (!releaseId || !title) continue
      const status = asString(release['status'])
      if (status?.toLowerCase() === 'pseudo-release') continue
      const group = record(release['release-group'])
      const date = asString(release['date'])
      const entry: RankedOriginalRelease = {
        releaseId,
        releaseGroupId: asString(group?.['id']),
        releaseIds: [releaseId],
        recordingId: asString(recording['id']),
        title,
        artist: formatArtistCredit(release['artist-credit']) ?? recordingArtist,
        date,
        year: yearOf(date),
        country: asString(release['country']),
        status,
        primaryType: asString(group?.['primary-type']),
        secondaryTypes: stringList(group?.['secondary-types']),
        ...positionOnRelease(release),
        confidence,
      }
      const key = entry.releaseGroupId ?? `release:${releaseId}`
      const bucket = groups.get(key)
      if (bucket) bucket.push(entry)
      else groups.set(key, [entry])
    }
  }

  const ranked: RankedOriginalRelease[] = []
  for (const releases of groups.values()) {
    // The group's representative edition: official first, then the earliest
    // dated one (the original pressing), then the best recording match.
    const sorted = [...releases].sort((a, b) => {
      const aOfficial = (a.status ?? '').toLowerCase() === 'official' ? 0 : 1
      const bOfficial = (b.status ?? '').toLowerCase() === 'official' ? 0 : 1
      if (aOfficial !== bOfficial) return aOfficial - bOfficial
      const byDate = compareDates(a.date, b.date)
      if (byDate !== 0) return byDate
      return b.confidence - a.confidence
    })
    const best = sorted[0]
    ranked.push({
      ...best,
      releaseIds: [...new Set(releases.map(release => release.releaseId))],
      confidence: Math.max(...releases.map(release => release.confidence)),
    })
  }

  ranked.sort((a, b) => {
    const byTier = originalReleaseTier(a) - originalReleaseTier(b)
    if (byTier !== 0) return byTier
    const byDate = compareDates(a.date, b.date)
    if (byDate !== 0) return byDate
    return b.confidence - a.confidence
  })
  return ranked.slice(0, options.limit ?? DEFAULT_LIMIT)
}

export interface LocalAlbumRef {
  id: number
  title: string
  album_artist: string | null
  musicbrainz_album_id: string | null
  musicbrainz_release_group_id: string | null
  track_count: number
}

// Edition suffixes that don't change which album it is ("Rumours (Deluxe
// Edition)" is still Rumours for library purposes).
const EDITION_SUFFIX = /\s*[([][^)\]]*\b(?:edition|remaster(?:ed)?|deluxe|expanded|anniversary|bonus|version|reissue|mono|stereo|super|legacy)\b[^)\]]*[)\]]\s*$/i

export function albumIdentityTitle(value: string | null | undefined): string {
  let title = (value ?? '').trim()
  for (let i = 0; i < 3 && EDITION_SUFFIX.test(title); i++) title = title.replace(EDITION_SUFFIX, '').trim()
  return normalizeMetadataText(title)
}

function artistKey(value: string | null | undefined): string {
  return normalizeMetadataText(value ?? '').replace(/\s*&\s*/g, ' and ')
}

// The library album that already IS this release, if any: exact MusicBrainz
// ids first, then the same title (ignoring edition suffixes) by the same album
// artist. Year is deliberately ignored — local tags often carry the remaster
// year while MusicBrainz reports the original.
export function matchLocalAlbumForRelease<A extends LocalAlbumRef>(
  release: { releaseIds: readonly string[]; releaseGroupId: string | null; title: string; artist: string | null },
  albums: readonly A[],
): A | null {
  const withTracks = albums.filter(album => album.track_count > 0)
  if (release.releaseGroupId) {
    const byGroup = withTracks.find(album => album.musicbrainz_release_group_id === release.releaseGroupId)
    if (byGroup) return byGroup
  }
  const releaseIds = new Set(release.releaseIds)
  const byRelease = withTracks.find(album => album.musicbrainz_album_id != null && releaseIds.has(album.musicbrainz_album_id))
  if (byRelease) return byRelease

  const title = albumIdentityTitle(release.title)
  const artist = artistKey(release.artist)
  if (!title || !artist) return null
  const byName = withTracks
    .filter(album => albumIdentityTitle(album.title) === title && artistKey(album.album_artist) === artist)
    .sort((a, b) => b.track_count - a.track_count || a.id - b.id)
  return byName[0] ?? null
}
