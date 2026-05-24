import { app } from 'electron'
import { isLyricsSizeOk } from '@shared/lyrics/lrc'

const BASE = 'https://lrclib.net/api'
const TIMEOUT_MS = 15000
const MAX_CONCURRENT = 2
const SPACING_MS = 500
const RETRIES = 2
const BACKOFF_MS = 1500

export interface LrclibQuery {
  title: string
  artist: string
  album?: string | null
  durationSeconds?: number | null
}

export interface LrclibRaw {
  id: number
  trackName: string
  artistName: string
  albumName: string | null
  duration: number | null
  instrumental: boolean
  plainLyrics: string | null
  syncedLyrics: string | null
}

export class LrclibRateLimitError extends Error {}
export class LrclibTimeoutError extends Error {}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// Cap each lyrics blob from the (untrusted, possibly MITM'd) provider. An oversized
// field is dropped to null rather than failing the whole record, so a valid plain
// blob survives even if synced is hostile.
function cappedLyrics(value: unknown): string | null {
  if (value == null) return null
  const s = String(value)
  return isLyricsSizeOk(s) ? s : null
}

function asRaw(value: unknown): LrclibRaw | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  if (typeof o.id !== 'number') return null
  return {
    id: o.id,
    trackName: String(o.trackName ?? ''),
    artistName: String(o.artistName ?? ''),
    albumName: o.albumName == null ? null : String(o.albumName),
    duration: typeof o.duration === 'number' ? o.duration : null,
    instrumental: o.instrumental === true,
    plainLyrics: cappedLyrics(o.plainLyrics),
    syncedLyrics: cappedLyrics(o.syncedLyrics),
  }
}

// Privacy: only title/artist/album/duration are ever sent — never file paths.
export class LrclibProvider {
  private readonly userAgent = `Crate/${safeVersion()} (https://github.com/lautarocaballero/HiFidelity2)`
  private active = 0
  private waiters: Array<() => void> = []
  private lastRequestAt = 0

  async getExact(q: LrclibQuery): Promise<LrclibRaw | null> {
    const params = new URLSearchParams({ track_name: q.title, artist_name: q.artist })
    if (q.album) params.set('album_name', q.album)
    if (q.durationSeconds != null) params.set('duration', String(Math.round(q.durationSeconds)))
    const json = await this.request(`${BASE}/get?${params.toString()}`)
    return asRaw(json)
  }

  async getById(id: string): Promise<LrclibRaw | null> {
    const json = await this.request(`${BASE}/get/${encodeURIComponent(id)}`)
    return asRaw(json)
  }

  async search(q: LrclibQuery): Promise<LrclibRaw[]> {
    const params = new URLSearchParams({ track_name: q.title, artist_name: q.artist })
    if (q.album) params.set('album_name', q.album)
    const json = await this.request(`${BASE}/search?${params.toString()}`)
    if (!Array.isArray(json)) return []
    return json.map(asRaw).filter((r): r is LrclibRaw => r !== null)
  }

  private async request(url: string): Promise<unknown | null> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        return await this.withSlot(() => this.fetchJson(url))
      } catch (err) {
        if (err instanceof LrclibRateLimitError) throw err
        lastErr = err
        if (attempt < RETRIES) await delay(BACKOFF_MS * (attempt + 1))
      }
    }
    throw new LrclibTimeoutError(lastErr instanceof Error ? lastErr.message : String(lastErr))
  }

  private async fetchJson(url: string): Promise<unknown | null> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
        signal: ctrl.signal,
      })
      if (res.status === 404) return null
      if (res.status === 429) throw new LrclibRateLimitError('lrclib rate limited (429)')
      if (!res.ok) throw new Error(`lrclib HTTP ${res.status}`)
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  // Concurrency gate (max 2) plus minimum spacing between requests.
  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= MAX_CONCURRENT) {
      await new Promise<void>(resolve => this.waiters.push(resolve))
    }
    this.active++
    const since = Date.now() - this.lastRequestAt
    if (since < SPACING_MS) await delay(SPACING_MS - since)
    this.lastRequestAt = Date.now()
    try {
      return await fn()
    } finally {
      this.active--
      const next = this.waiters.shift()
      if (next) next()
    }
  }
}

function safeVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}
