import { createHash } from 'node:crypto'
import type { DownloadQuality, OnlineTrackResult, ProviderAuthState } from '@shared/types/downloads'
import type { CredentialStore } from './CredentialStore'
import { ProviderDownloadUnavailableError, type DownloadResolution, type OnlineProvider, type QobuzCredentials } from './types'

const QOBUZ_BASE = 'https://www.qobuz.com/api.json/0.2'

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

function asString(value: unknown, fallback = ''): string {
  if (value == null) return fallback
  return String(value)
}

function asNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function imageUrl(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const img = value as Record<string, unknown>
  return asString(img['large'] ?? img['thumbnail'] ?? img['small']).trim() || null
}

function sourceUrl(trackId: string): string {
  return `https://play.qobuz.com/track/${encodeURIComponent(trackId)}`
}

function formatIdsForQuality(quality: DownloadQuality): string[] {
  switch (quality) {
    case 'best': return ['27', '7', '6', '5']
    case 'hires': return ['27', '7']
    case 'mp3-320': return ['5']
    case 'lossless':
    default: return ['6']
  }
}

function extensionForFormat(formatId: string): string {
  return formatId === '5' ? 'mp3' : 'flac'
}

function isInvalidSignatureError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /invalid request signature|request_sig|signature/i.test(msg)
}

function isUnavailableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /not available|not allowed|not found|format|rights|subscription/i.test(msg)
}

export class QobuzProvider implements OnlineProvider {
  readonly provider = 'qobuz' as const

  constructor(private store: CredentialStore) {}

  async authState(): Promise<ProviderAuthState> {
    const credentials = this.store.getQobuzCredentials()
    const hasSearch = Boolean(credentials.appId)
    const hasDownload = Boolean(credentials.appId && credentials.appSecret && credentials.userAuthToken)
    const missingFields = [
      ...(credentials.appId ? [] : ['appId']),
      ...(credentials.appSecret ? [] : ['appSecret']),
      ...(credentials.userAuthToken ? [] : ['userAuthToken']),
    ]
    return {
      provider: 'qobuz',
      configured: hasSearch,
      authenticated: hasDownload,
      canSearch: hasSearch,
      canDownload: hasDownload,
      displayName: hasDownload ? 'Qobuz token' : hasSearch ? 'Qobuz app' : null,
      reason: hasSearch
        ? hasDownload ? null : 'Qobuz needs app secret and user auth token before downloading.'
        : 'Qobuz app id is required before searching.',
      source: credentials.source ?? null,
      missingFields,
      expiresAt: credentials.expiresAt ?? null,
    }
  }

  async search(query: string, limit: number): Promise<OnlineTrackResult[]> {
    const credentials = this.requireSearchCredentials()
    const params = new URLSearchParams({
      app_id: credentials.appId,
      query,
      type: 'tracks',
      limit: String(Math.max(1, Math.min(50, limit))),
    })
    if (credentials.userAuthToken) params.set('user_auth_token', credentials.userAuthToken)
    const json = await this.fetchJson(`${QOBUZ_BASE}/catalog/search?${params.toString()}`)
    const tracks = (json as { tracks?: { items?: unknown[] } }).tracks?.items ?? []
    return tracks.map(item => this.mapTrack(item)).filter((item): item is OnlineTrackResult => item != null)
  }

  async getTrack(providerTrackId: string, signal?: AbortSignal): Promise<OnlineTrackResult> {
    const credentials = this.requireSearchCredentials()
    const params = new URLSearchParams({
      app_id: credentials.appId,
      track_id: providerTrackId,
    })
    if (credentials.userAuthToken) params.set('user_auth_token', credentials.userAuthToken)
    const json = await this.fetchJson(`${QOBUZ_BASE}/track/get?${params.toString()}`, signal)
    return this.mapTrack(json) ?? {
      provider: 'qobuz',
      providerTrackId,
      title: `Qobuz ${providerTrackId}`,
      artist: 'Unknown Artist',
      album: 'Unknown Album',
      durationSec: null,
      artworkUrl: null,
      qualityLabel: null,
      bitDepth: null,
      sampleRate: null,
      explicit: false,
      availability: 'downloadable',
      unavailableReason: null,
      sourceUrl: sourceUrl(providerTrackId),
    }
  }

  async resolveDownload(track: OnlineTrackResult, quality: DownloadQuality, signal: AbortSignal): Promise<DownloadResolution> {
    const credentials = this.requireDownloadCredentials()
    let lastError: unknown = null

    for (const formatId of formatIdsForQuality(quality)) {
      try {
        const url = await this.getFileUrl(credentials, track.providerTrackId, formatId, signal)
        return {
          url,
          extension: extensionForFormat(formatId),
          bytesTotal: null,
          track,
        }
      } catch (err) {
        lastError = err
        if (isInvalidSignatureError(err)) {
          try {
            const url = await this.getFileUrl(credentials, track.providerTrackId, formatId, signal)
            return {
              url,
              extension: extensionForFormat(formatId),
              bytesTotal: null,
              track,
            }
          } catch (retryErr) {
            lastError = retryErr
            throw new Error('Qobuz rejected the app signature. Update the Qobuz app id/secret and user token in Settings.')
          }
        }
        if (!isUnavailableError(err)) break
      }
    }

    const msg = lastError instanceof Error ? lastError.message : String(lastError ?? 'No Qobuz file URL was returned.')
    throw new ProviderDownloadUnavailableError(msg)
  }

  private async getFileUrl(credentials: QobuzCredentials, trackId: string, formatId: string, signal: AbortSignal): Promise<string> {
    const ts = Math.floor(Date.now() / 1000).toString()
    const requestSig = md5(`trackgetFileUrlformat_id${formatId}intentstreamtrack_id${trackId}${ts}${credentials.appSecret}`)
    const params = new URLSearchParams({
      app_id: credentials.appId,
      user_auth_token: credentials.userAuthToken,
      track_id: trackId,
      format_id: formatId,
      intent: 'stream',
      request_ts: ts,
      request_sig: requestSig,
    })
    const json = await this.fetchJson(`${QOBUZ_BASE}/track/getFileUrl?${params.toString()}`, signal)
    const url = asString((json as { url?: unknown }).url).trim()
    if (!url) throw new ProviderDownloadUnavailableError('Qobuz did not return a downloadable file URL for this track.')
    return url
  }

  private mapTrack(value: unknown): OnlineTrackResult | null {
    if (!value || typeof value !== 'object') return null
    const row = value as Record<string, unknown>
    const album = (row['album'] && typeof row['album'] === 'object') ? row['album'] as Record<string, unknown> : {}
    const performer = (row['performer'] && typeof row['performer'] === 'object') ? row['performer'] as Record<string, unknown> : {}
    const artist = (row['artist'] && typeof row['artist'] === 'object') ? row['artist'] as Record<string, unknown> : {}
    const albumArtist = (album['artist'] && typeof album['artist'] === 'object') ? album['artist'] as Record<string, unknown> : {}
    const id = asString(row['id']).trim()
    if (!id) return null

    const bitDepth = asNumber(row['maximum_bit_depth'] ?? album['maximum_bit_depth'])
    const sampleRate = asNumber(row['maximum_sampling_rate'] ?? album['maximum_sampling_rate'])
    const qualityLabel = bitDepth && sampleRate
      ? `${bitDepth}/${Math.round(sampleRate / 1000)}`
      : null
    const artistName =
      asString(performer['name']).trim() ||
      asString(artist['name']).trim() ||
      asString(albumArtist['name']).trim() ||
      'Unknown Artist'

    return {
      provider: 'qobuz',
      providerTrackId: id,
      title: asString(row['title'], `Qobuz ${id}`).trim() || `Qobuz ${id}`,
      artist: artistName,
      album: asString(album['title'], 'Unknown Album').trim() || 'Unknown Album',
      durationSec: asNumber(row['duration']),
      artworkUrl: imageUrl(album['image']),
      qualityLabel,
      bitDepth,
      sampleRate,
      explicit: Boolean(row['parental_warning']),
      availability: 'downloadable',
      unavailableReason: null,
      sourceUrl: sourceUrl(id),
    }
  }

  private requireSearchCredentials(): Partial<QobuzCredentials> & { appId: string } {
    const credentials = this.store.getQobuzCredentials()
    if (!credentials.appId) throw new Error('Qobuz app id is required before searching.')
    return credentials as Partial<QobuzCredentials> & { appId: string }
  }

  private requireDownloadCredentials(): QobuzCredentials {
    const credentials = this.store.getQobuzCredentials()
    if (!credentials.appId || !credentials.appSecret || !credentials.userAuthToken) {
      throw new Error('Qobuz app id, app secret and user auth token are required before downloading.')
    }
    return credentials as QobuzCredentials
  }

  private async fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal,
    })
    const text = await response.text()
    let json: unknown = null
    try { json = text ? JSON.parse(text) : null } catch { /* handled below */ }
    if (!response.ok) {
      const message = asString((json as { message?: unknown; error?: unknown } | null)?.message)
        || asString((json as { message?: unknown; error?: unknown } | null)?.error)
        || text
        || `Qobuz request failed (${response.status})`
      throw new Error(message)
    }
    if (json && typeof json === 'object') {
      const error = asString((json as Record<string, unknown>)['error']).trim()
      const message = asString((json as Record<string, unknown>)['message']).trim()
      if (error) throw new Error(message || error)
    }
    return json
  }
}
