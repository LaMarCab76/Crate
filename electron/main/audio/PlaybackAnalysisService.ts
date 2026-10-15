import { statSync } from 'node:fs'
import { getRepos } from '../db/repositories'
import { PLAYBACK_ANALYSIS_VERSION, type TrackCacheFingerprint } from '../db/repositories/PlaybackAnalysisRepo'
import { getAudioEngine } from './AudioEngine'
import { decodeTableBarsAnalysis, decodeWaveformAnalysis } from './PlaybackDecode'
import type { DbTrack } from '@shared/types/db'
import type { PlaybackAnalysisResult, PlaybackCacheStats, PlaybackTableBarsResult } from '@shared/types/ipc-contract'
import { requireLocalLibraryTrackPath } from '../library/localLibraryTrackGuard'
import { requireFilesystemPlaybackAnalysisPath } from './playbackAnalysisSafety'

const DEFAULT_BUCKETS = 1200
// Short-lived layer over the persistent DB cache, mainly for tracks that are
// not in the library (device playback) and therefore can't be stored.
const MEMORY_CACHE_MAX = 50

let service: PlaybackAnalysisService | null = null

function memoryCacheKey(path: string, kind: string): string {
  try {
    const st = statSync(path)
    return `${path}:${kind}:${st.size}:${Math.round(st.mtimeMs)}`
  } catch {
    return `${path}:${kind}`
  }
}

function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= MEMORY_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
  return value
}

const analysisMemory = new Map<string, PlaybackAnalysisResult>()
const tableBarsMemory = new Map<string, PlaybackTableBarsResult>()

async function decodeAnalysis(path: string, buckets: number): Promise<PlaybackAnalysisResult> {
  const key = memoryCacheKey(path, String(buckets))
  const cached = analysisMemory.get(key)
  if (cached) return { ...cached, source: 'decoded' }
  const decoded = await decodeWaveformAnalysis(path, buckets)
  return remember(analysisMemory, key, { ...decoded, analysisVersion: PLAYBACK_ANALYSIS_VERSION, source: 'decoded' })
}

async function decodeTableBars(path: string): Promise<PlaybackTableBarsResult> {
  const key = memoryCacheKey(path, 'table-bars')
  const cached = tableBarsMemory.get(key)
  if (cached) return { ...cached, source: 'decoded' }
  const decoded = await decodeTableBarsAnalysis(path)
  return remember(tableBarsMemory, key, { ...decoded, analysisVersion: PLAYBACK_ANALYSIS_VERSION, source: 'decoded' })
}

function normalizeBuckets(buckets: number | undefined): number {
  const n = Number(buckets)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BUCKETS
  return Math.max(128, Math.min(6000, Math.floor(n)))
}

function fingerprintFor(track: DbTrack): TrackCacheFingerprint {
  requireFilesystemPlaybackAnalysisPath(track.path, track.provider)
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
    requireFilesystemPlaybackAnalysisPath(path)
    const resolved = this.resolveTrack(path, trackId)
    if (!resolved) return null
    const current = this.requireCurrentLocalTrack(resolved)
    return getRepos().playbackAnalysis.getValid(
      current,
      normalizeBuckets(buckets),
      fingerprintFor(current),
    )
  }

  async ensure(path: string, buckets?: number, trackId?: number | null): Promise<PlaybackAnalysisResult> {
    requireFilesystemPlaybackAnalysisPath(path)
    const resolved = this.resolveTrack(path, trackId)
    const normalizedBuckets = normalizeBuckets(buckets)
    if (!resolved) {
      return decodeAnalysis(path, normalizedBuckets)
    }

    const current = this.requireCurrentLocalTrack(resolved)
    const cached = getRepos().playbackAnalysis.getValid(current, normalizedBuckets, fingerprintFor(current))
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
    requireFilesystemPlaybackAnalysisPath(path)
    const resolved = this.resolveTrack(path, trackId)
    if (!resolved) return null
    const current = this.requireCurrentLocalTrack(resolved)
    return getRepos().playbackAnalysis.getValidTableBars(
      current,
      fingerprintFor(current),
    )
  }

  async ensureTableBars(path: string, trackId?: number | null): Promise<PlaybackTableBarsResult> {
    requireFilesystemPlaybackAnalysisPath(path)
    const resolved = this.resolveTrack(path, trackId)
    if (!resolved) {
      return decodeTableBars(path)
    }

    const current = this.requireCurrentLocalTrack(resolved)
    const cached = getRepos().playbackAnalysis.getValidTableBars(current, fingerprintFor(current))
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
    const current = this.requireCurrentLocalTrack(track)
    const fingerprint = fingerprintFor(current)
    const normalized = await decodeAnalysis(current.path, buckets)
    getRepos().playbackAnalysis.save(current, fingerprint, normalized, [current.id, this.currentTrackId()])
    return normalized
  }

  private async decodeAndStoreTableBars(track: DbTrack): Promise<PlaybackTableBarsResult> {
    const current = this.requireCurrentLocalTrack(track)
    const fingerprint = fingerprintFor(current)
    const normalized = await decodeTableBars(current.path)
    getRepos().playbackAnalysis.saveTableBars(current, fingerprint, normalized, [current.id, this.currentTrackId()])
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

  private requireCurrentLocalTrack(expected: DbTrack): DbTrack {
    const repos = getRepos()
    const current = repos.tracks.getById(expected.id)
    if (!current || current.folder_id !== expected.folder_id) {
      throw new Error('Playback analysis track changed while the request was queued')
    }
    requireFilesystemPlaybackAnalysisPath(current.path, current.provider)
    requireLocalLibraryTrackPath({
      track: current,
      folder: repos.folders.getById(current.folder_id),
      expectedPath: expected.path,
      label: 'Playback analysis track',
    })
    return current
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
