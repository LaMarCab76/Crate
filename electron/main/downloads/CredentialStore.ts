import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  DownloadSettings,
  ProviderCredentialsPayload,
  QobuzCredentialsPayload,
  ServiceTutorialState,
  TidalCredentialsPayload,
} from '@shared/types/downloads'
import type { QobuzCredentials, TidalCredentials } from './types'

interface StoredCredentialFile {
  qobuz?: string
  tidal?: string
}

const DEFAULT_SETTINGS: DownloadSettings = {
  folderId: null,
  quality: 'lossless',
  concurrency: 2,
}

const DEFAULT_TUTORIAL_STATE: ServiceTutorialState = {
  seen: false,
  lastShownAt: null,
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function clampConcurrency(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : DEFAULT_SETTINGS.concurrency
  return Math.max(1, Math.min(4, n))
}

function normalizeSettings(value: Partial<DownloadSettings> | null): DownloadSettings {
  const quality = value?.quality
  return {
    folderId: typeof value?.folderId === 'number' && Number.isInteger(value.folderId) && value.folderId > 0
      ? value.folderId
      : null,
    quality: quality === 'best' || quality === 'hires' || quality === 'lossless' || quality === 'mp3-320'
      ? quality
      : DEFAULT_SETTINGS.quality,
    concurrency: clampConcurrency(value?.concurrency),
  }
}

function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  const tempPath = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2), { mode })
    renameSync(tempPath, path)
  } catch (err) {
    try { unlinkSync(tempPath) } catch { /* best-effort cleanup */ }
    throw err
  }
}

export class CredentialStore {
  private dir: string
  private credentialsPath: string
  private settingsPath: string
  private tutorialPath: string

  constructor() {
    this.dir = join(app.getPath('userData'), 'downloads')
    this.credentialsPath = join(this.dir, 'credentials.json')
    this.settingsPath = join(this.dir, 'settings.json')
    this.tutorialPath = join(this.dir, 'tutorial.json')
  }

  getSettings(): DownloadSettings {
    try {
      if (!existsSync(this.settingsPath)) return DEFAULT_SETTINGS
      return normalizeSettings(JSON.parse(readFileSync(this.settingsPath, 'utf8')) as Partial<DownloadSettings>)
    } catch {
      return DEFAULT_SETTINGS
    }
  }

  setSettings(patch: Partial<DownloadSettings>): DownloadSettings {
    const current = this.getSettings()
    const next = normalizeSettings({ ...current, ...patch })
    mkdirSync(this.dir, { recursive: true })
    writeJsonAtomic(this.settingsPath, next)
    return next
  }

  getTutorialState(): ServiceTutorialState {
    try {
      if (!existsSync(this.tutorialPath)) return DEFAULT_TUTORIAL_STATE
      const parsed = JSON.parse(readFileSync(this.tutorialPath, 'utf8')) as Partial<ServiceTutorialState>
      return {
        seen: parsed.seen === true,
        lastShownAt: typeof parsed.lastShownAt === 'number' ? parsed.lastShownAt : null,
      }
    } catch {
      return DEFAULT_TUTORIAL_STATE
    }
  }

  setTutorialState(patch: Partial<ServiceTutorialState>): ServiceTutorialState {
    const current = this.getTutorialState()
    const next: ServiceTutorialState = {
      seen: patch.seen ?? current.seen,
      lastShownAt: patch.lastShownAt === undefined
        ? current.lastShownAt
        : typeof patch.lastShownAt === 'number' ? patch.lastShownAt : null,
    }
    mkdirSync(this.dir, { recursive: true })
    writeJsonAtomic(this.tutorialPath, next)
    return next
  }

  getQobuzCredentials(): Partial<QobuzCredentials> {
    return this.readCredentials().qobuz ?? {}
  }

  getTidalCredentials(): Partial<TidalCredentials> {
    return this.readCredentials().tidal ?? {}
  }

  saveCredentials(payload: ProviderCredentialsPayload): void {
    const all = this.readCredentials()
    if (payload.provider === 'qobuz') {
      all.qobuz = this.mergeQobuz(all.qobuz ?? {}, payload)
    } else {
      all.tidal = this.mergeTidal(all.tidal ?? {}, payload)
    }
    this.writeCredentials(all)
  }

  clearCredentials(provider: 'qobuz' | 'tidal'): void {
    const all = this.readCredentials()
    delete all[provider]
    this.writeCredentials(all)
  }

  private mergeQobuz(current: Partial<QobuzCredentials>, patch: QobuzCredentialsPayload): Partial<QobuzCredentials> {
    const now = Date.now()
    return {
      appId: clean(patch.appId) ?? current.appId,
      appSecret: clean(patch.appSecret) ?? current.appSecret,
      userAuthToken: clean(patch.userAuthToken) ?? current.userAuthToken,
      source: patch.source ?? current.source ?? 'manual',
      importedAt: patch.importedAt ?? current.importedAt ?? now,
      expiresAt: patch.expiresAt === undefined ? current.expiresAt : patch.expiresAt,
    }
  }

  private mergeTidal(current: Partial<TidalCredentials>, patch: TidalCredentialsPayload): Partial<TidalCredentials> {
    const now = Date.now()
    return {
      clientId: clean(patch.clientId) ?? current.clientId,
      clientSecret: clean(patch.clientSecret) ?? current.clientSecret,
      accessToken: clean(patch.accessToken) ?? current.accessToken,
      refreshToken: clean(patch.refreshToken) ?? current.refreshToken,
      webToken: clean(patch.webToken) ?? current.webToken,
      countryCode: clean(patch.countryCode) ?? current.countryCode,
      source: patch.source ?? current.source ?? 'manual',
      importedAt: patch.importedAt ?? current.importedAt ?? now,
      expiresAt: patch.expiresAt === undefined ? current.expiresAt : patch.expiresAt,
    }
  }

  private readCredentials(): { qobuz?: Partial<QobuzCredentials>; tidal?: Partial<TidalCredentials> } {
    try {
      if (!existsSync(this.credentialsPath)) return {}
      const raw = JSON.parse(readFileSync(this.credentialsPath, 'utf8')) as StoredCredentialFile
      return {
        qobuz: this.decrypt<Partial<QobuzCredentials>>(raw.qobuz),
        tidal: this.decrypt<Partial<TidalCredentials>>(raw.tidal),
      }
    } catch (err) {
      console.warn('[downloads] failed to read stored credentials:', (err as Error).message)
      return {}
    }
  }

  private writeCredentials(value: { qobuz?: Partial<QobuzCredentials>; tidal?: Partial<TidalCredentials> }): void {
    mkdirSync(this.dir, { recursive: true })
    const out: StoredCredentialFile = {
      qobuz: value.qobuz ? this.encrypt(value.qobuz) : undefined,
      tidal: value.tidal ? this.encrypt(value.tidal) : undefined,
    }
    writeJsonAtomic(this.credentialsPath, out)
  }

  private encrypt(value: unknown): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure credential storage is unavailable on this system.')
    }
    return safeStorage.encryptString(JSON.stringify(value)).toString('base64')
  }

  private decrypt<T>(encoded: string | undefined): T | undefined {
    if (!encoded) return undefined
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure credential storage is unavailable on this system.')
    }
    const json = safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    return JSON.parse(json) as T
  }
}

let instance: CredentialStore | null = null
export function getCredentialStore(): CredentialStore {
  if (!instance) instance = new CredentialStore()
  return instance
}
