import type { DownloadProvider, DownloadQuality, OnlineTrackResult, ProviderAuthState } from '@shared/types/downloads'

export interface QobuzCredentials {
  appId: string
  appSecret: string
  userAuthToken: string
  source?: 'manual' | 'har'
  importedAt?: number
  expiresAt?: number | null
}

export interface TidalCredentials {
  clientId?: string
  clientSecret?: string
  accessToken?: string
  refreshToken?: string
  webToken?: string
  countryCode?: string
  source?: 'manual' | 'har'
  importedAt?: number
  expiresAt?: number | null
}

export interface DownloadResolution {
  url: string
  extension: string
  bytesTotal: number | null
  track: OnlineTrackResult
}

export class ProviderDownloadUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderDownloadUnavailableError'
  }
}

export interface OnlineProvider {
  provider: DownloadProvider
  authState(): Promise<ProviderAuthState>
  search(query: string, limit: number): Promise<OnlineTrackResult[]>
  getTrack(providerTrackId: string): Promise<OnlineTrackResult>
  resolveDownload(track: OnlineTrackResult, quality: DownloadQuality, signal: AbortSignal): Promise<DownloadResolution>
}
