export type DownloadProvider = 'qobuz' | 'tidal'

export type DownloadQuality = 'best' | 'hires' | 'lossless' | 'mp3-320'

export type DownloadStatus =
  | 'queued'
  | 'authenticating'
  | 'resolving'
  | 'downloading'
  | 'verifying'
  | 'tagging'
  | 'importing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unavailable'
  | 'already_exists'

export type DownloadAvailability = 'downloadable' | 'search_only' | 'unavailable'

export type CredentialSource = 'manual' | 'har'

export interface HarExtractedCredential {
  key: string
  label: string
  status: 'found' | 'missing'
  valuePreview: string | null
  sourceHint: string | null
}

export interface HarImportPreview {
  previewId: string
  provider: DownloadProvider
  createdAt: number
  fields: HarExtractedCredential[]
  missingFields: string[]
  canApply: boolean
  summary: string
}

export interface ServiceTutorialState {
  seen: boolean
  lastShownAt: number | null
}

export interface OnlineTrackResult {
  provider: DownloadProvider
  providerTrackId: string
  title: string
  artist: string
  album: string
  durationSec: number | null
  artworkUrl: string | null
  qualityLabel: string | null
  bitDepth: number | null
  sampleRate: number | null
  explicit: boolean
  availability: DownloadAvailability
  unavailableReason: string | null
  sourceUrl: string | null
}

export interface DownloadJob {
  id: string
  provider: DownloadProvider
  providerTrackId: string
  status: DownloadStatus
  quality: DownloadQuality
  folderId: number | null
  title: string
  artist: string
  album: string
  artworkUrl: string | null
  sourceUrl: string | null
  path: string | null
  error: string | null
  bytesReceived: number
  bytesTotal: number | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface ProviderAuthState {
  provider: DownloadProvider
  configured: boolean
  authenticated: boolean
  canSearch: boolean
  canDownload: boolean
  displayName: string | null
  reason: string | null
  source: CredentialSource | null
  missingFields: string[]
  expiresAt: number | null
}

export interface DownloadSettings {
  folderId: number | null
  quality: DownloadQuality
  concurrency: number
}

export interface QobuzCredentialsPayload {
  appId?: string
  appSecret?: string
  userAuthToken?: string
  source?: CredentialSource
  importedAt?: number
  expiresAt?: number | null
}

export interface TidalCredentialsPayload {
  clientId?: string
  clientSecret?: string
  accessToken?: string
  refreshToken?: string
  webToken?: string
  countryCode?: string
  source?: CredentialSource
  importedAt?: number
  expiresAt?: number | null
}

export type ProviderCredentialsPayload =
  | ({ provider: 'qobuz' } & QobuzCredentialsPayload)
  | ({ provider: 'tidal' } & TidalCredentialsPayload)

export interface DownloadSearchRequest {
  provider: DownloadProvider
  query: string
  limit?: number
}

export interface EnqueueDownloadRequest {
  provider: DownloadProvider
  providerTrackIds: string[]
  folderId?: number | null
  quality?: DownloadQuality
}

export interface DownloadProgressEvent {
  job: DownloadJob
}

export interface DownloadJobsChangedEvent {
  jobs: DownloadJob[]
}
