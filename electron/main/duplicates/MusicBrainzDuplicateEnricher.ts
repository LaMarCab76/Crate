import {
  getMusicBrainzMetadataClient,
  type MusicBrainzMetadataClient,
  type MusicBrainzTrackMatch,
} from '../library/MusicBrainzMetadata.ts'
import type {
  DuplicateMetadataEnricher,
  DuplicateMetadataEnrichment,
} from './DuplicateDetectionService.ts'
import type { DuplicateTrackFacts } from './domain.ts'
import { normalizeDuplicateText } from './normalization.ts'

export const DUPLICATE_MUSICBRAINZ_MAX_PAIRS_PER_RUN = 4
export const DUPLICATE_MUSICBRAINZ_MIN_CONFIDENCE = 0.78
const MAX_CACHE_ENTRIES = 512

interface DuplicateMusicBrainzClient {
  lookupRecordingOnAlbum(query: {
    title: string
    artist: string
    album: string | null
    durationSeconds: number | null
  }): Promise<MusicBrainzTrackMatch | null>
}

function cacheKey(track: DuplicateTrackFacts): string {
  return JSON.stringify([
    normalizeDuplicateText(track.title),
    normalizeDuplicateText(track.primaryArtist ?? track.artist),
    normalizeDuplicateText(track.album),
    Math.round(track.duration * 10) / 10,
  ])
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('MusicBrainz duplicate enrichment cancelled.')
  error.name = 'AbortError'
  throw error
}

export class MusicBrainzDuplicateEnricher implements DuplicateMetadataEnricher {
  private readonly client: DuplicateMusicBrainzClient
  private readonly maxPairsPerRun: number
  private remainingPairs: number
  private readonly cache = new Map<string, Promise<MusicBrainzTrackMatch | null>>()

  constructor(
    client: DuplicateMusicBrainzClient = getMusicBrainzMetadataClient(),
    maxPairsPerRun = DUPLICATE_MUSICBRAINZ_MAX_PAIRS_PER_RUN,
  ) {
    this.client = client
    this.maxPairsPerRun = Math.max(0, Math.floor(maxPairsPerRun))
    this.remainingPairs = this.maxPairsPerRun
  }

  beginRun(): void {
    this.remainingPairs = this.maxPairsPerRun
  }

  private lookup(track: DuplicateTrackFacts): Promise<MusicBrainzTrackMatch | null> {
    const key = cacheKey(track)
    const cached = this.cache.get(key)
    if (cached) {
      // Refresh insertion order for the bounded LRU cache.
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached
    }
    const request = this.client.lookupRecordingOnAlbum({
      title: track.title,
      artist: track.primaryArtist ?? track.artist,
      album: track.album || null,
      durationSeconds: Number.isFinite(track.duration) ? track.duration : null,
    }).catch(error => {
      this.cache.delete(key)
      throw error
    })
    this.cache.set(key, request)
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (!oldest) break
      this.cache.delete(oldest)
    }
    return request
  }

  async enrichPair(
    left: DuplicateTrackFacts,
    right: DuplicateTrackFacts,
    signal?: AbortSignal,
  ): Promise<DuplicateMetadataEnrichment | null> {
    abortIfNeeded(signal)
    const leftCached = this.cache.has(cacheKey(left))
    const rightCached = this.cache.has(cacheKey(right))
    if ((!leftCached || !rightCached) && this.remainingPairs <= 0) return null
    if (!leftCached || !rightCached) this.remainingPairs -= 1

    const [leftMatch, rightMatch] = await Promise.all([
      this.lookup(left),
      this.lookup(right),
    ])
    abortIfNeeded(signal)
    const acceptedLeft = leftMatch && leftMatch.confidence >= DUPLICATE_MUSICBRAINZ_MIN_CONFIDENCE
      ? leftMatch
      : null
    const acceptedRight = rightMatch && rightMatch.confidence >= DUPLICATE_MUSICBRAINZ_MIN_CONFIDENCE
      ? rightMatch
      : null
    if (!acceptedLeft && !acceptedRight) return null
    return {
      left: acceptedLeft ? {
        musicBrainzReleaseId: acceptedLeft.releaseId,
        musicBrainzReleaseGroupId: acceptedLeft.releaseGroupId,
        musicBrainzInferred: true,
      } : undefined,
      right: acceptedRight ? {
        musicBrainzReleaseId: acceptedRight.releaseId,
        musicBrainzReleaseGroupId: acceptedRight.releaseGroupId,
        musicBrainzInferred: true,
      } : undefined,
    }
  }
}

let instance: MusicBrainzDuplicateEnricher | null = null

export function getMusicBrainzDuplicateEnricher(): MusicBrainzDuplicateEnricher {
  instance ??= new MusicBrainzDuplicateEnricher(
    getMusicBrainzMetadataClient() as MusicBrainzMetadataClient,
  )
  return instance
}
