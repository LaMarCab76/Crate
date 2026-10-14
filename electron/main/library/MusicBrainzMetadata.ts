import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeMetadataText, scoreMetadataCandidate } from './MetadataCompletionRules.ts'
import { fetchCoverArtForRelease, type CoverArtImage } from './CoverArtArchive.ts'
import {
  formatArtistCredit,
  rankOriginalReleases,
  type OriginalReleaseQuery,
  type RankedOriginalRelease,
} from './originalAlbumCandidates.ts'

const MB_BASE = 'https://musicbrainz.org/ws/2'
const REQUEST_TIMEOUT_MS = 6000
const MB_SPACING_MS = 1100
let cachedAppVersion: string | null = null

export interface MusicBrainzTrackQuery {
  title: string
  artist: string
  album: string | null
  durationSeconds: number | null
}

export interface MusicBrainzTrackMatch {
  title: string | null
  artist: string | null
  album: string | null
  albumArtist: string | null
  genre: string | null
  year: string | null
  trackNumber: number | null
  totalTracks: number | null
  discNumber: number | null
  totalDiscs: number | null
  releaseId: string | null
  releaseGroupId: string | null
  confidence: number
}

// One row of an album's official tracklist as published on MusicBrainz. Titles
// are returned raw — normalization/matching is the planner's job.
export interface MusicBrainzReleaseTrack {
  discNumber: number
  trackNumber: number
  title: string
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Serializes MusicBrainz traffic and preserves a minimum interval between
 * request starts. A timestamp-only limiter is insufficient: two callers can
 * finish the same wait together and issue concurrent requests.
 */
export class MusicBrainzRequestQueue {
  private tail: Promise<void> = Promise.resolve()
  private lastStartedAt: number | null = null
  private readonly spacingMs: number
  private readonly now: () => number
  private readonly wait: (ms: number) => Promise<void>

  constructor(
    spacingMs = MB_SPACING_MS,
    now: () => number = Date.now,
    wait: (ms: number) => Promise<void> = delay,
  ) {
    this.spacingMs = Math.max(0, spacingMs)
    this.now = now
    this.wait = wait
  }

  run<T>(request: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      if (this.lastStartedAt != null) {
        const remaining = this.spacingMs - (this.now() - this.lastStartedAt)
        if (remaining > 0) await this.wait(remaining)
      }
      this.lastStartedAt = this.now()
      return request()
    })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
}

// All metadata consumers share the same gate, including duplicate enrichment
// and regular metadata completion.
const musicBrainzRequestQueue = new MusicBrainzRequestQueue()

function asString(value: unknown): string | null {
  if (value == null) return null
  const text = String(value).trim()
  return text || null
}

function asNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function safeYear(value: string | null): string | null {
  if (!value) return null
  const match = /\d{4}/.exec(value)
  return match ? match[0] : null
}

function cleanQueryValue(value: string | null | undefined): string {
  return (value ?? '').replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()
}

function joinCredit(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const text = value
    .map(item => {
      if (!item || typeof item !== 'object') return ''
      const row = item as Record<string, unknown>
      if (row['name'] != null) return String(row['name'])
      const artist = row['artist']
      if (artist && typeof artist === 'object') {
        return String((artist as Record<string, unknown>)['name'] ?? '')
      }
      return ''
    })
    .filter(Boolean)
    .join(', ')
    .trim()
  return text || null
}

function firstTagName(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const sorted = [...value].sort((a, b) => {
    const ac = typeof a === 'object' && a ? Number((a as Record<string, unknown>)['count'] ?? 0) : 0
    const bc = typeof b === 'object' && b ? Number((b as Record<string, unknown>)['count'] ?? 0) : 0
    return bc - ac
  })
  for (const item of sorted) {
    if (!item || typeof item !== 'object') continue
    const name = asString((item as Record<string, unknown>)['name'])
    if (name) return name
  }
  return null
}

function pickRelease(releases: Record<string, unknown>[], album: string | null): Record<string, unknown> | null {
  if (releases.length === 0) return null
  if (album) {
    const target = normalizeMetadataText(album)
    const exact = releases.find(release => normalizeMetadataText(asString(release['title']) ?? '') === target)
    if (exact) return exact
  }
  return releases.find(release => asString(release['status']) === 'Official') ?? releases[0]
}

function mapRecording(recording: unknown, query: MusicBrainzTrackQuery): MusicBrainzTrackMatch | null {
  if (!recording || typeof recording !== 'object') return null
  const row = recording as Record<string, unknown>
  const title = asString(row['title'])
  const artist = joinCredit(row['artist-credit'])
  if (!title || !artist) return null
  const releases = Array.isArray(row['releases']) ? row['releases'] as Record<string, unknown>[] : []
  const release = pickRelease(releases, query.album)
  const album = asString(release?.['title']) ?? query.album
  const releaseDate = safeYear(asString(release?.['date']) ?? asString(row['first-release-date']))
  const releaseGroup = release?.['release-group'] && typeof release['release-group'] === 'object'
    ? release['release-group'] as Record<string, unknown>
    : null
  const confidence = scoreMetadataCandidate({
    title: query.title,
    artist: query.artist,
    album: query.album,
    durationSeconds: query.durationSeconds,
    candidateTitle: title,
    candidateArtist: artist,
    candidateAlbum: album,
    candidateDurationSeconds: typeof row['length'] === 'number' ? row['length'] / 1000 : null,
  })

  return {
    title,
    artist,
    album,
    albumArtist: joinCredit(release?.['artist-credit']) ?? artist,
    genre: firstTagName(row['tags']),
    year: releaseDate,
    trackNumber: null,
    totalTracks: null,
    discNumber: null,
    totalDiscs: null,
    releaseId: asString(release?.['id']),
    releaseGroupId: asString(releaseGroup?.['id']),
    confidence,
  }
}

// Flattens a MusicBrainz release JSON into its full official tracklist. Shared by
// enrichMatchFromRelease (single-track enrichment) and lookupAlbumTracklist
// (whole-album lookup). Rows with no positive track number or empty title are
// dropped so the planner only ever sees usable slots.
export function parseReleaseTracklist(releaseJson: unknown): MusicBrainzReleaseTrack[] {
  if (!releaseJson || typeof releaseJson !== 'object') return []
  const row = releaseJson as Record<string, unknown>
  const media = Array.isArray(row['media']) ? row['media'] as Record<string, unknown>[] : []
  const tracklist: MusicBrainzReleaseTrack[] = []
  for (const medium of media) {
    const discNumber = asNumber(medium['position']) ?? 1
    const tracks = Array.isArray(medium['tracks']) ? medium['tracks'] as Record<string, unknown>[] : []
    for (const track of tracks) {
      const rec = track['recording'] && typeof track['recording'] === 'object'
        ? track['recording'] as Record<string, unknown>
        : null
      const title = asString(rec?.['title']) ?? asString(track['title'])
      const trackNumber = asNumber(track['position'] ?? track['number'])
      if (!title || trackNumber == null) continue
      tracklist.push({ discNumber, trackNumber, title })
    }
  }
  return tracklist
}

export function enrichMatchFromRelease(
  base: MusicBrainzTrackMatch,
  releaseJson: unknown,
  query: MusicBrainzTrackQuery,
): MusicBrainzTrackMatch {
  if (!releaseJson || typeof releaseJson !== 'object') return base
  const row = releaseJson as Record<string, unknown>
  const media = Array.isArray(row['media']) ? row['media'] as Record<string, unknown>[] : []
  const totalDiscs = media.length > 0 ? media.length : null

  const tracklist = parseReleaseTracklist(releaseJson)
  const target = normalizeMetadataText(query.title)
  const match = tracklist.find(entry => normalizeMetadataText(entry.title) === target) ?? null
  const trackNumber = match?.trackNumber ?? null
  const discNumber = match?.discNumber ?? null
  const totalTracks = match
    ? tracklist.filter(entry => entry.discNumber === match.discNumber).length
    : null

  const releaseGroup = row['release-group'] && typeof row['release-group'] === 'object'
    ? row['release-group'] as Record<string, unknown>
    : null
  return {
    ...base,
    album: asString(row['title']) ?? base.album,
    albumArtist: joinCredit(row['artist-credit']) ?? base.albumArtist,
    genre: firstTagName(row['genres']) ?? firstTagName(row['tags']) ?? base.genre,
    year: safeYear(asString(row['date'])) ?? base.year,
    trackNumber: trackNumber ?? base.trackNumber,
    totalTracks: totalTracks ?? base.totalTracks,
    discNumber: discNumber ?? base.discNumber,
    totalDiscs: totalDiscs ?? base.totalDiscs,
    releaseGroupId: asString(releaseGroup?.['id']) ?? base.releaseGroupId,
  }
}

export interface MusicBrainzReleaseDetailTrack extends MusicBrainzReleaseTrack {
  recordingId: string | null
}

// Everything needed to create an album that isn't in the library yet from one
// MusicBrainz release: identity, tags and the full official tracklist.
export interface MusicBrainzReleaseDetail {
  releaseId: string
  releaseGroupId: string | null
  title: string
  albumArtist: string | null
  albumArtistIds: string[]
  date: string | null
  year: string | null
  country: string | null
  status: string | null
  primaryType: string | null
  secondaryTypes: string[]
  genre: string | null
  totalDiscs: number
  // Track count per disc number (from the medium's track-count when present).
  discTrackCounts: Record<number, number>
  tracklist: MusicBrainzReleaseDetailTrack[]
}

export function parseReleaseDetail(releaseJson: unknown): MusicBrainzReleaseDetail | null {
  if (!releaseJson || typeof releaseJson !== 'object') return null
  const row = releaseJson as Record<string, unknown>
  const releaseId = asString(row['id'])
  const title = asString(row['title'])
  if (!releaseId || !title) return null
  const group = row['release-group'] && typeof row['release-group'] === 'object'
    ? row['release-group'] as Record<string, unknown>
    : null
  const media = Array.isArray(row['media']) ? row['media'] as Record<string, unknown>[] : []
  const discTrackCounts: Record<number, number> = {}
  const tracklist: MusicBrainzReleaseDetailTrack[] = []
  for (const medium of media) {
    const discNumber = asNumber(medium['position']) ?? 1
    const tracks = Array.isArray(medium['tracks']) ? medium['tracks'] as Record<string, unknown>[] : []
    discTrackCounts[discNumber] = asNumber(medium['track-count']) ?? tracks.length
    for (const track of tracks) {
      const rec = track['recording'] && typeof track['recording'] === 'object'
        ? track['recording'] as Record<string, unknown>
        : null
      const trackTitle = asString(track['title']) ?? asString(rec?.['title'])
      const trackNumber = asNumber(track['position'] ?? track['number'])
      if (!trackTitle || trackNumber == null) continue
      tracklist.push({ discNumber, trackNumber, title: trackTitle, recordingId: asString(rec?.['id']) })
    }
  }
  const credits = Array.isArray(row['artist-credit']) ? row['artist-credit'] as Record<string, unknown>[] : []
  const albumArtistIds = credits
    .map(credit => credit['artist'] && typeof credit['artist'] === 'object'
      ? asString((credit['artist'] as Record<string, unknown>)['id'])
      : null)
    .filter((id): id is string => id != null)
  const date = asString(row['date'])
  const secondaryTypes = group?.['secondary-types']
  return {
    releaseId,
    releaseGroupId: asString(group?.['id']),
    title,
    albumArtist: formatArtistCredit(row['artist-credit']),
    albumArtistIds,
    date,
    year: safeYear(date),
    country: asString(row['country']),
    status: asString(row['status']),
    primaryType: asString(group?.['primary-type']),
    secondaryTypes: Array.isArray(secondaryTypes)
      ? secondaryTypes.map(asString).filter((type): type is string => type != null)
      : [],
    genre: firstTagName(row['genres']) ?? firstTagName(group?.['genres']) ?? firstTagName(row['tags']),
    totalDiscs: Math.max(1, media.length),
    discTrackCounts,
    tracklist,
  }
}

function userAgent(): string {
  const version = appVersion()
  return `Crate/${version} (https://github.com/LaMarCab76/Crate)`
}

function appVersion(): string {
  if (cachedAppVersion) return cachedAppVersion
  try {
    const packagePath = join(dirname(fileURLToPath(import.meta.url)), '../../../package.json')
    const json = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown }
    cachedAppVersion = typeof json.version === 'string' && json.version ? json.version : '0.0.0'
  } catch {
    cachedAppVersion = process.env.npm_package_version ?? '0.0.0'
  }
  return cachedAppVersion
}

export class MusicBrainzMetadataClient {
  async lookupRecordingOnAlbum(query: MusicBrainzTrackQuery): Promise<MusicBrainzTrackMatch | null> {
    const result = await this.searchRecording(query)
    if (!result) return null
    if (!result.releaseId) return result
    const params = new URLSearchParams({
      fmt: 'json',
      inc: 'recordings+artist-credits+release-groups+genres+tags',
    })
    const json = await this.fetchMusicBrainzJson(`${MB_BASE}/release/${encodeURIComponent(result.releaseId)}?${params.toString()}`)
    return enrichMatchFromRelease(result, json, query)
  }

  // Resolves the destination album's release and returns its full official
  // tracklist. Prefers the stored MusicBrainz release id (a direct, exact fetch)
  // and otherwise searches for the best release by album title + artist. Returns
  // [] when nothing usable is found; throws only on transport errors so the
  // caller can degrade to library-only placement.
  async lookupAlbumTracklist(query: {
    album: string | null
    albumArtist: string | null
    musicBrainzAlbumId: string | null
  }): Promise<MusicBrainzReleaseTrack[]> {
    if (query.musicBrainzAlbumId) {
      const params = new URLSearchParams({ fmt: 'json', inc: 'recordings' })
      const json = await this.fetchMusicBrainzJson(`${MB_BASE}/release/${encodeURIComponent(query.musicBrainzAlbumId)}?${params.toString()}`)
      const tracklist = parseReleaseTracklist(json)
      if (tracklist.length > 0) return tracklist
    }

    const album = cleanQueryValue(query.album)
    if (!album) return []
    const artist = cleanQueryValue(query.albumArtist)
    const lucene = artist ? `release:"${album}" AND artist:"${artist}"` : `release:"${album}"`
    const searchParams = new URLSearchParams({ fmt: 'json', limit: '5', query: lucene })
    const searchJson = await this.fetchMusicBrainzJson(`${MB_BASE}/release?${searchParams.toString()}`)
    const releases = Array.isArray((searchJson as Record<string, unknown>)?.['releases'])
      ? (searchJson as Record<string, unknown>)['releases'] as Record<string, unknown>[]
      : []
    const release = pickRelease(releases, query.album)
    const releaseId = asString(release?.['id'])
    if (!releaseId) return []
    const detailParams = new URLSearchParams({ fmt: 'json', inc: 'recordings' })
    const detailJson = await this.fetchMusicBrainzJson(`${MB_BASE}/release/${encodeURIComponent(releaseId)}?${detailParams.toString()}`)
    return parseReleaseTracklist(detailJson)
  }

  // Candidate ORIGINAL albums for a song — typically one downloaded from a
  // compilation. Searches the recording by title + artist and ranks every
  // release it appears on (see rankOriginalReleases). `searchArtist` lets the
  // caller query with the primary artist only ("A feat. B" → "A") while scoring
  // still uses the full credit.
  async findOriginalReleases(query: OriginalReleaseQuery & { searchArtist?: string | null }): Promise<RankedOriginalRelease[]> {
    const title = cleanQueryValue(query.title)
    const artist = cleanQueryValue(query.searchArtist || query.artist)
    if (!title) return []
    const lucene = artist ? `recording:"${title}" AND artist:"${artist}"` : `recording:"${title}"`
    const params = new URLSearchParams({ fmt: 'json', limit: '25', query: lucene })
    let json = await this.fetchMusicBrainzJson(`${MB_BASE}/recording?${params.toString()}`)
    let ranked = rankOriginalReleases((json as Record<string, unknown> | null)?.['recordings'], query)
    if (ranked.length === 0) {
      const fallback = new URLSearchParams({ fmt: 'json', limit: '25', query: `${title} ${artist}`.trim() })
      json = await this.fetchMusicBrainzJson(`${MB_BASE}/recording?${fallback.toString()}`)
      ranked = rankOriginalReleases((json as Record<string, unknown> | null)?.['recordings'], query)
    }
    return ranked
  }

  // Full release (identity + official tracklist) for creating a new album.
  // Returns null when MusicBrainz doesn't know the id; throws on transport errors.
  async lookupReleaseDetail(releaseId: string): Promise<MusicBrainzReleaseDetail | null> {
    const params = new URLSearchParams({
      fmt: 'json',
      inc: 'recordings+artist-credits+release-groups+genres+tags',
    })
    const json = await this.fetchMusicBrainzJson(`${MB_BASE}/release/${encodeURIComponent(releaseId)}?${params.toString()}`)
    return parseReleaseDetail(json)
  }

  async fetchCoverArt(releaseId: string | null, releaseGroupId: string | null): Promise<CoverArtImage | null> {
    return fetchCoverArtForRelease({ releaseId, releaseGroupId, userAgent: userAgent() })
  }

  private async searchRecording(query: MusicBrainzTrackQuery): Promise<MusicBrainzTrackMatch | null> {
    const lucene = `recording:"${cleanQueryValue(query.title)}" AND artist:"${cleanQueryValue(query.artist)}"`
    const params = new URLSearchParams({
      fmt: 'json',
      limit: '5',
      query: lucene,
    })
    let json = await this.fetchMusicBrainzJson(`${MB_BASE}/recording?${params.toString()}`)
    let recordings = Array.isArray((json as Record<string, unknown>)?.['recordings'])
      ? (json as Record<string, unknown>)['recordings'] as unknown[]
      : []

    if (recordings.length === 0) {
      const fallback = new URLSearchParams({
        fmt: 'json',
        limit: '5',
        query: `${cleanQueryValue(query.title)} ${cleanQueryValue(query.artist)}`,
      })
      json = await this.fetchMusicBrainzJson(`${MB_BASE}/recording?${fallback.toString()}`)
      recordings = Array.isArray((json as Record<string, unknown>)?.['recordings'])
        ? (json as Record<string, unknown>)['recordings'] as unknown[]
        : []
    }

    const ranked = recordings
      .map(recording => mapRecording(recording, query))
      .filter((item): item is MusicBrainzTrackMatch => item != null)
      .sort((a, b) => b.confidence - a.confidence)

    return ranked[0] ?? null
  }

  private async fetchMusicBrainzJson(url: string): Promise<unknown> {
    return musicBrainzRequestQueue.run(async () => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
          signal: ctrl.signal,
        })
        if (response.status === 404) return null
        if (response.status === 503) throw new Error('MusicBrainz rate limit reached')
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json()
      } finally {
        clearTimeout(timer)
      }
    })
  }
}

let instance: MusicBrainzMetadataClient | null = null

export function getMusicBrainzMetadataClient(): MusicBrainzMetadataClient {
  if (!instance) instance = new MusicBrainzMetadataClient()
  return instance
}
