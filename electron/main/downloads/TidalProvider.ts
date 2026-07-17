import type { DownloadQuality, OnlineTrackResult, ProviderAuthState } from '@shared/types/downloads'
import type { CredentialStore } from './CredentialStore'
import { ProviderDownloadUnavailableError, type DownloadResolution, type OnlineProvider, type TidalCredentials } from './types'

const TIDAL_TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token'
const TIDAL_API_BASE = 'https://openapi.tidal.com/v2'
const TIDAL_WEB_BASE = 'https://tidal.com'
const DEFAULT_COUNTRY = 'US'
const DEFAULT_LOCALE = 'en_US'

function asString(value: unknown, fallback = ''): string {
  if (value == null) return fallback
  return String(value)
}

function asNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function attr(item: unknown): Record<string, unknown> {
  if (!item || typeof item !== 'object') return {}
  const row = item as Record<string, unknown>
  return row['attributes'] && typeof row['attributes'] === 'object'
    ? row['attributes'] as Record<string, unknown>
    : row
}

function sourceUrl(trackId: string): string {
  return `https://tidal.com/browse/track/${encodeURIComponent(trackId)}`
}

function normalizeCountryCode(value: unknown): string {
  const country = asString(value, DEFAULT_COUNTRY).trim().toUpperCase()
  return /^[A-Z]{2}$/.test(country) ? country : DEFAULT_COUNTRY
}

function tidalArtworkUrl(cover: unknown): string | null {
  const id = asString(cover).trim()
  if (!id) return null
  return `https://resources.tidal.com/images/${id.replace(/-/g, '/')}/320x320.jpg`
}

export class TidalProvider implements OnlineProvider {
  readonly provider = 'tidal' as const
  private accessToken: string | null = null
  private accessTokenExpiresAt = 0

  constructor(private store: CredentialStore) {}

  invalidateCredentials(): void {
    this.accessToken = null
    this.accessTokenExpiresAt = 0
  }

  async authState(): Promise<ProviderAuthState> {
    const credentials = this.store.getTidalCredentials()
    const configured = Boolean(credentials.clientId && credentials.clientSecret)
    const tokenOnly = Boolean(credentials.accessToken || credentials.webToken)
    const missingFields = configured || tokenOnly
      ? []
      : [
          ...(credentials.clientId ? [] : ['clientId']),
          ...(credentials.clientSecret ? [] : ['clientSecret']),
          ...(credentials.accessToken || credentials.webToken ? [] : ['accessToken', 'webToken']),
        ]
    return {
      provider: 'tidal',
      configured: configured || tokenOnly,
      authenticated: configured || tokenOnly,
      canSearch: configured || tokenOnly,
      canDownload: false,
      displayName: configured ? 'TIDAL catalog' : credentials.webToken ? 'TIDAL web token' : tokenOnly ? 'TIDAL token' : null,
      reason: configured || tokenOnly
        ? 'TIDAL search is available. File download is unavailable unless TIDAL exposes an official non-DRM file delivery endpoint for this account.'
        : 'TIDAL OAuth credentials or a TIDAL web token from HAR are required before searching.',
      source: credentials.source ?? null,
      missingFields,
      expiresAt: credentials.expiresAt ?? null,
    }
  }

  async search(query: string, limit: number): Promise<OnlineTrackResult[]> {
    const credentials = this.store.getTidalCredentials()
    if (credentials.webToken && !credentials.accessToken && !(credentials.clientId && credentials.clientSecret)) {
      return this.searchWebCatalog(query, limit, credentials as TidalCredentials)
    }

    const token = await this.getAccessToken()
    const url = `${TIDAL_API_BASE}/searchResults/${encodeURIComponent(query)}/relationships/tracks?countryCode=${DEFAULT_COUNTRY}&limit=${Math.max(1, Math.min(25, limit))}`
    const json = await this.fetchJson(url, token)
    const rows = Array.isArray((json as { data?: unknown[] }).data) ? (json as { data: unknown[] }).data : []
    return rows.map(item => this.mapTrack(item)).filter((item): item is OnlineTrackResult => item != null)
  }

  async getTrack(providerTrackId: string, signal?: AbortSignal): Promise<OnlineTrackResult> {
    const credentials = this.store.getTidalCredentials()
    if (credentials.webToken && !credentials.accessToken && !(credentials.clientId && credentials.clientSecret)) {
      const countryCode = normalizeCountryCode(credentials.countryCode)
      const url = this.webUrl(`/v1/tracks/${encodeURIComponent(providerTrackId)}`, { countryCode })
      const json = await this.fetchWebJson(url, credentials.webToken, signal)
      return this.mapWebTrack(json) ?? this.unavailableTrack(providerTrackId)
    }

    const token = await this.getAccessToken(signal)
    const json = await this.fetchJson(
      `${TIDAL_API_BASE}/tracks/${encodeURIComponent(providerTrackId)}?countryCode=${DEFAULT_COUNTRY}`,
      token,
      signal,
    )
    return this.mapTrack((json as { data?: unknown }).data ?? json) ?? this.unavailableTrack(providerTrackId)
  }

  private unavailableTrack(providerTrackId: string): OnlineTrackResult {
    return {
      provider: 'tidal',
      providerTrackId,
      title: `TIDAL ${providerTrackId}`,
      artist: 'Unknown Artist',
      album: 'Unknown Album',
      durationSec: null,
      artworkUrl: null,
      qualityLabel: null,
      bitDepth: null,
      sampleRate: null,
      explicit: false,
      availability: 'unavailable',
      unavailableReason: 'TIDAL does not expose authorized file downloads through the public integration used by Crate.',
      sourceUrl: sourceUrl(providerTrackId),
    }
  }

  async resolveDownload(track: OnlineTrackResult, _quality: DownloadQuality, _signal: AbortSignal): Promise<DownloadResolution> {
    throw new ProviderDownloadUnavailableError(
      track.unavailableReason || 'TIDAL download is unavailable through the public API integration.',
    )
  }

  private mapTrack(item: unknown): OnlineTrackResult | null {
    if (!item || typeof item !== 'object') return null
    const row = item as Record<string, unknown>
    const attributes = attr(row)
    const id = asString(row['id'] ?? attributes['id']).trim()
    if (!id) return null
    const artist = asString(attributes['artistName'] ?? attributes['artists'] ?? attributes['artist'], 'Unknown Artist')
    const album = asString(attributes['albumTitle'] ?? attributes['album'] ?? attributes['releaseTitle'], 'Unknown Album')
    const title = asString(attributes['title'] ?? attributes['name'], `TIDAL ${id}`)
    const duration = asNumber(attributes['duration'] ?? attributes['durationSec'])
    const audioQuality = asString(attributes['audioQuality'] ?? attributes['audioModes'] ?? attributes['mediaMetadataTags']).trim()

    return {
      provider: 'tidal',
      providerTrackId: id,
      title: title.trim() || `TIDAL ${id}`,
      artist: artist.trim() || 'Unknown Artist',
      album: album.trim() || 'Unknown Album',
      durationSec: duration,
      artworkUrl: null,
      qualityLabel: audioQuality || null,
      bitDepth: null,
      sampleRate: null,
      explicit: Boolean(attributes['explicit']),
      availability: 'unavailable',
      unavailableReason: 'TIDAL search is supported; file download is not available through the official public integration.',
      sourceUrl: sourceUrl(id),
    }
  }

  private mapWebTrack(item: unknown): OnlineTrackResult | null {
    if (!item || typeof item !== 'object') return null
    const row = item as Record<string, unknown>
    const id = asString(row['id']).trim()
    if (!id) return null
    const artistRow = row['artist'] && typeof row['artist'] === 'object' ? row['artist'] as Record<string, unknown> : null
    const albumRow = row['album'] && typeof row['album'] === 'object' ? row['album'] as Record<string, unknown> : null
    const artists = Array.isArray(row['artists'])
      ? row['artists']
        .map(artist => artist && typeof artist === 'object' ? asString((artist as Record<string, unknown>)['name']) : '')
        .filter(Boolean)
      : []
    const title = asString(row['title'] ?? row['name'], `TIDAL ${id}`)
    const artist = artists.join(', ') || asString(artistRow?.['name'], 'Unknown Artist')
    const album = asString(albumRow?.['title'] ?? albumRow?.['name'], 'Unknown Album')
    const mediaTags = row['mediaMetadata'] && typeof row['mediaMetadata'] === 'object'
      ? (row['mediaMetadata'] as Record<string, unknown>)['tags']
      : null
    const quality = asString(row['audioQuality'] ?? row['audioModes'] ?? mediaTags).trim()

    return {
      provider: 'tidal',
      providerTrackId: id,
      title: title.trim() || `TIDAL ${id}`,
      artist: artist.trim() || 'Unknown Artist',
      album: album.trim() || 'Unknown Album',
      durationSec: asNumber(row['duration']),
      artworkUrl: tidalArtworkUrl(albumRow?.['cover'] ?? row['cover']),
      qualityLabel: quality || null,
      bitDepth: asNumber(row['bitDepth']),
      sampleRate: asNumber(row['sampleRate']),
      explicit: Boolean(row['explicit']),
      availability: 'unavailable',
      unavailableReason: 'TIDAL search is supported; file download is not available through the official public integration.',
      sourceUrl: sourceUrl(id),
    }
  }

  private async searchWebCatalog(query: string, limit: number, credentials: TidalCredentials): Promise<OnlineTrackResult[]> {
    const boundedLimit = Math.max(1, Math.min(25, limit))
    const countryCode = normalizeCountryCode(credentials.countryCode)
    const primary = await this.fetchWebJson(
      this.webUrl('/v1/search/tracks', {
        query,
        limit: String(boundedLimit),
        offset: '0',
        countryCode,
      }),
      credentials.webToken ?? '',
    )
    const primaryRows = this.webTrackRows(primary)
    if (primaryRows.length > 0) {
      return primaryRows.map(item => this.mapWebTrack(item)).filter((item): item is OnlineTrackResult => item != null)
    }

    const fallback = await this.fetchWebJson(
      this.webUrl('/v1/search', {
        query,
        types: 'TRACKS',
        limit: String(boundedLimit),
        offset: '0',
        countryCode,
      }),
      credentials.webToken ?? '',
    )
    return this.webTrackRows(fallback).map(item => this.mapWebTrack(item)).filter((item): item is OnlineTrackResult => item != null)
  }

  private webTrackRows(json: unknown): unknown[] {
    if (!json || typeof json !== 'object') return []
    const row = json as Record<string, unknown>
    if (Array.isArray(row['items'])) return row['items']
    if (row['tracks'] && typeof row['tracks'] === 'object') {
      const tracks = row['tracks'] as Record<string, unknown>
      if (Array.isArray(tracks['items'])) return tracks['items']
    }
    if (Array.isArray(row['data'])) return row['data']
    return []
  }

  private webUrl(path: string, params: Record<string, string>): string {
    const url = new URL(path, TIDAL_WEB_BASE)
    url.searchParams.set('locale', DEFAULT_LOCALE)
    url.searchParams.set('deviceType', 'BROWSER')
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
    return url.toString()
  }

  private async getAccessToken(signal?: AbortSignal): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) return this.accessToken

    const credentials = this.requireCredentials()
    if (credentials.accessToken && (!credentials.clientId || !credentials.clientSecret)) {
      this.accessToken = credentials.accessToken
      this.accessTokenExpiresAt = credentials.expiresAt ?? (Date.now() + 3600 * 1000)
      return this.accessToken
    }
    const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')
    const response = await fetch(TIDAL_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
      signal,
    })
    const json = await response.json() as { access_token?: string; expires_in?: number; error_description?: string; error?: string }
    if (!response.ok || !json.access_token) {
      throw new Error(json.error_description || json.error || `TIDAL token request failed (${response.status})`)
    }
    this.accessToken = json.access_token
    this.accessTokenExpiresAt = Date.now() + Math.max(60, json.expires_in ?? 3600) * 1000
    return this.accessToken
  }

  private requireCredentials(): TidalCredentials {
    const credentials = this.store.getTidalCredentials()
    if (!credentials.accessToken && (!credentials.clientId || !credentials.clientSecret)) {
      throw new Error('TIDAL OAuth credentials or a TIDAL web token from HAR are required before searching.')
    }
    return credentials as TidalCredentials
  }

  private async fetchJson(url: string, token: string, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.tidal.v1+json',
        Authorization: `Bearer ${token}`,
      },
      signal,
    })
    const text = await response.text()
    let json: unknown = null
    try { json = text ? JSON.parse(text) : null } catch { /* handled below */ }
    if (!response.ok) {
      const message = asString((json as { errors?: Array<{ detail?: string }>; error?: unknown } | null)?.errors?.[0]?.detail)
        || asString((json as { error?: unknown } | null)?.error)
        || text
        || `TIDAL request failed (${response.status})`
      throw new Error(message)
    }
    return json
  }

  private async fetchWebJson(url: string, webToken: string, signal?: AbortSignal): Promise<unknown> {
    if (!webToken) throw new Error('TIDAL web token is required before searching.')
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Tidal-Token': webToken,
      },
      signal,
    })
    const text = await response.text()
    let json: unknown = null
    try { json = text ? JSON.parse(text) : null } catch { /* handled below */ }
    if (!response.ok) {
      const message = asString((json as { userMessage?: unknown; error?: unknown; subStatus?: unknown } | null)?.userMessage)
        || asString((json as { error?: unknown } | null)?.error)
        || text
        || `TIDAL web request failed (${response.status})`
      throw new Error(message)
    }
    return json
  }
}
