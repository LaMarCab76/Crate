// LRCLIB lyrics fetcher. Mirrors the contract that the original Swift app
// (old_swift/HiFidelity/Core/LyricsService.swift) used so we can re-use the
// same upstream and inherit its coverage characteristics.
//
// Strategy:
//   1. /api/get with exact title + artist + album + duration. This is the
//      cheapest path and returns 200 on a clean match, 404 on miss.
//   2. On miss, fall back to /api/search which is fuzzier. We pick the result
//      with the closest duration when available.
//
// The caller (audio IPC channel) caches results via LyricsRepo so we hit the
// network at most once per track.

const BASE_URL = 'https://lrclib.net/api'
const USER_AGENT = 'HiFidelity2/1.0 (https://github.com/anthropics/electron-port)'

export interface LyricsQuery {
  title: string
  artist: string
  album?: string | null
  durationSec?: number | null
}

export interface LyricsResult {
  synced: string | null    // raw LRC content with [mm:ss.xx] tags
  plain: string | null
  language: string | null
  source: 'lrclib'
}

interface LrclibGetResponse {
  id: number
  name?: string
  trackName?: string
  artistName?: string
  albumName?: string | null
  duration?: number
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
  lang?: string | null
}

async function lrclibGet(q: LyricsQuery): Promise<LrclibGetResponse | null> {
  const params = new URLSearchParams({
    track_name: q.title,
    artist_name: q.artist,
  })
  if (q.album) params.set('album_name', q.album)
  if (q.durationSec != null && q.durationSec > 0) {
    params.set('duration', String(Math.round(q.durationSec)))
  }
  const url = `${BASE_URL}/get?${params.toString()}`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`LRCLIB /get ${res.status}`)
  return (await res.json()) as LrclibGetResponse
}

async function lrclibSearch(q: LyricsQuery): Promise<LrclibGetResponse | null> {
  const params = new URLSearchParams({
    track_name: q.title,
    artist_name: q.artist,
  })
  if (q.album) params.set('album_name', q.album)
  const url = `${BASE_URL}/search?${params.toString()}`
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) return null
  const arr = (await res.json()) as LrclibGetResponse[]
  if (!Array.isArray(arr) || arr.length === 0) return null

  // Prefer the entry whose reported duration is closest to ours — protects
  // against picking a remix or single-edit when album version was requested.
  if (q.durationSec != null && q.durationSec > 0) {
    let best = arr[0]
    let bestDelta = Math.abs((best.duration ?? 0) - q.durationSec)
    for (let i = 1; i < arr.length; i++) {
      const delta = Math.abs((arr[i].duration ?? 0) - q.durationSec)
      if (delta < bestDelta) { best = arr[i]; bestDelta = delta }
    }
    return best
  }
  return arr[0]
}

export async function fetchLyrics(q: LyricsQuery): Promise<LyricsResult | null> {
  if (!q.title || !q.artist) return null
  try {
    let hit = await lrclibGet(q)
    if (!hit) hit = await lrclibSearch(q)
    if (!hit) return null
    if (hit.instrumental) {
      return { synced: null, plain: '♪ Instrumental ♪', language: hit.lang ?? null, source: 'lrclib' }
    }
    return {
      synced: hit.syncedLyrics ?? null,
      plain: hit.plainLyrics ?? null,
      language: hit.lang ?? null,
      source: 'lrclib',
    }
  } catch (err) {
    console.warn('[lyrics] LRCLIB lookup failed:', (err as Error).message)
    return null
  }
}
