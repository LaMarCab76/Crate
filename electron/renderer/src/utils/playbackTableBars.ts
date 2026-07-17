import { useEffect, useState } from 'react'
import type { PlaybackTableBarsResult } from '@shared/types/ipc-contract'
import type { Track } from '@shared/types/library'

const memory = new Map<string, PlaybackTableBarsResult>()
const inflight = new Map<string, Promise<PlaybackTableBarsResult | null>>()

function analysisKey(track: Track): string {
  return `${track.dbId ?? track.path ?? track.id}:table-bars`
}

function trackPath(track: Track | null | undefined): string | null {
  return track?.path && track.path.trim().length > 0 ? track.path : null
}

function librarySource(track: Track | null | undefined) {
  return track?.dbId != null ? { kind: 'library' as const, trackId: track.dbId } : null
}

export function clearPlaybackTableBarsMemoryCache(): void {
  memory.clear()
  inflight.clear()
}

export function warmPlaybackTableBars(
  track: Track | null | undefined,
): Promise<PlaybackTableBarsResult | null> {
  const path = trackPath(track)
  const source = librarySource(track)
  if (!track || !path || !source || typeof window === 'undefined' || !window.api?.audio) {
    return Promise.resolve(null)
  }

  const key = analysisKey(track)
  const cached = memory.get(key)
  if (cached) return Promise.resolve(cached)

  const existing = inflight.get(key)
  if (existing) return existing

  const request = window.api.audio.ensureTableBars(source)
    .then(result => {
      memory.set(key, result)
      return result
    })
    .catch(() => null)
    .finally(() => inflight.delete(key))

  inflight.set(key, request)
  return request
}

export function usePlaybackTableBars(
  track: Track | null | undefined,
): PlaybackTableBarsResult | null {
  const [analysis, setAnalysis] = useState<PlaybackTableBarsResult | null>(null)
  const path = trackPath(track)
  const dbId = track?.dbId ?? null
  const source = librarySource(track)
  const trackId = track?.id ?? null

  useEffect(() => {
    if (!track || !path || !source || typeof window === 'undefined' || !window.api?.audio) {
      setAnalysis(null)
      return
    }

    const key = analysisKey(track)
    const inMemory = memory.get(key)
    if (inMemory) {
      setAnalysis(inMemory)
      return
    }

    let cancelled = false
    setAnalysis(null)

    void window.api.audio.getCachedTableBars(source)
      .then(cached => {
        if (cancelled) return
        if (cached) {
          memory.set(key, cached)
          setAnalysis(cached)
          return
        }

        void warmPlaybackTableBars(track).then(result => {
          if (!cancelled && result) setAnalysis(result)
        })
      })
      .catch(() => {
        if (cancelled) return
        void warmPlaybackTableBars(track).then(result => {
          if (!cancelled && result) setAnalysis(result)
        })
      })

    return () => {
      cancelled = true
    }
  }, [track, trackId, path, dbId, source?.trackId])

  return analysis
}
