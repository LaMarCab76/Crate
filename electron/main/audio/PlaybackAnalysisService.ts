import { statSync } from 'node:fs'
import { getRepos } from '../db/repositories'
import { PLAYBACK_ANALYSIS_VERSION, type TrackCacheFingerprint } from '../db/repositories/PlaybackAnalysisRepo'
import { getAudioEngine } from './AudioEngine'
import type { DbTrack } from '@shared/types/db'
import type { PlaybackAnalysisResult, PlaybackCacheStats, PlaybackTableBarsResult } from '@shared/types/ipc-contract'

const DEFAULT_BUCKETS = 1200

let service: PlaybackAnalysisService | null = null

function normalizeBuckets(buckets: number | undefined): number {
  const n = Number(buckets)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BUCKETS
  return Math.max(128, Math.min(6000, Math.floor(n)))
}

function fingerprintFor(track: DbTrack): TrackCacheFingerprint {
  try {
    const st = statSync(track.path)
    return {
      fileSize: st.size,
      fileMtimeMs: Math.round(st.mtimeMs),
      trackDateModified: track.date_modified ?? null,
    }
  } catch {
    return {
      fileSize: track.file_size ?? null,
      fileMtimeMs: null,
      trackDateModified: track.date_modified ?? null,
    }
  }
}

export class PlaybackAnalysisService {
  private inflight = new Map<string, Promise<PlaybackAnalysisResult>>()
  private tableBarsInflight = new Map<string, Promise<PlaybackTableBarsResult>>()

  getCached(path: string, buckets?: number, trackId?: number | null): PlaybackAnalysisResult | null {
    const resolved = this.resolveTrack(path, trackId)
    if (!resolved) return null
    return getRepos().playbackAnalysis.getValid(
      resolved,
      normalizeBuckets(buckets),
      fingerprintFor(resolved),
    )
  }

  async ensure(path: string, buckets?: number, trackId?: number | null): Promise<PlaybackAnalysisResult> {
    const resolved = this.resolveTrack(path, trackId)
    const normalizedBuckets = normalizeBuckets(buckets)
    if (!resolved) {
      return getAudioEngine().decodePlaybackAnalysis(path, normalizedBuckets)
    }

    const cached = getRepos().playbackAnalysis.getValid(resolved, normalizedBuckets, fingerprintFor(resolved))
    if (cached) return cached

    const key = `${resolved.id}:${normalizedBuckets}`
    const existing = this.inflight.get(key)
    if (existing) return existing

    const promise = this.decodeAndStore(resolved, normalizedBuckets)
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, promise)
    return promise
  }

  getCachedTableBars(path: string, trackId?: number | null): PlaybackTableBarsResult | null {
    const resolved = this.resolveTrack(path, trackId)
    if (!resolved) return null
    return getRepos().playbackAnalysis.getValidTableBars(
      resolved,
      fingerprintFor(resolved),
    )
  }

  async ensureTableBars(path: string, trackId?: number | null): Promise<PlaybackTableBarsResult> {
    const resolved = this.resolveTrack(path, trackId)
    if (!resolved) {
      return getAudioEngine().decodeTableBars(path)
    }

    const cached = getRepos().playbackAnalysis.getValidTableBars(resolved, fingerprintFor(resolved))
    if (cached) return cached

    const key = `${resolved.id}:table-bars`
    const existing = this.tableBarsInflight.get(key)
    if (existing) return existing

    const promise = this.decodeAndStoreTableBars(resolved)
      .finally(() => this.tableBarsInflight.delete(key))
    this.tableBarsInflight.set(key, promise)
    return promise
  }

  stats(): PlaybackCacheStats {
    return getRepos().playbackAnalysis.stats()
  }

  setMaxBytes(maxBytes: number): PlaybackCacheStats {
    return getRepos().playbackAnalysis.setMaxBytes(maxBytes, this.currentTrackId())
  }

  clear(): PlaybackCacheStats {
    return getRepos().playbackAnalysis.clear()
  }

  private async decodeAndStore(track: DbTrack, buckets: number): Promise<PlaybackAnalysisResult> {
    const fingerprint = fingerprintFor(track)
    const decoded = await getAudioEngine().decodePlaybackAnalysis(track.path, buckets)
    const normalized: PlaybackAnalysisResult = {
      ...decoded,
      analysisVersion: PLAYBACK_ANALYSIS_VERSION,
      source: 'decoded',
    }
    getRepos().playbackAnalysis.save(track, fingerprint, normalized, [track.id, this.currentTrackId()])
    return normalized
  }

  private async decodeAndStoreTableBars(track: DbTrack): Promise<PlaybackTableBarsResult> {
    const fingerprint = fingerprintFor(track)
    const decoded = await getAudioEngine().decodeTableBars(track.path)
    const normalized: PlaybackTableBarsResult = {
      ...decoded,
      analysisVersion: PLAYBACK_ANALYSIS_VERSION,
      source: 'decoded',
    }
    getRepos().playbackAnalysis.saveTableBars(track, fingerprint, normalized, [track.id, this.currentTrackId()])
    return normalized
  }

  private resolveTrack(path: string, trackId?: number | null): DbTrack | null {
    const repos = getRepos()
    if (trackId != null) {
      const byId = repos.tracks.getById(trackId)
      if (!byId || byId.path !== path) {
        throw new Error('playback analysis path does not match the track record')
      }
      return byId
    }
    return repos.tracks.getByPath(path) ?? null
  }

  private currentTrackId(): number | null {
    const path = getAudioEngine().getCurrentPath()
    if (!path) return null
    return getRepos().tracks.getByPath(path)?.id ?? null
  }
}

export function getPlaybackAnalysisService(): PlaybackAnalysisService {
  if (!service) service = new PlaybackAnalysisService()
  return service
}
