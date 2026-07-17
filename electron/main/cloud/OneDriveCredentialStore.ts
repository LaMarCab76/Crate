import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CloudMoveDisposition, CloudPrefs } from '@shared/types/cloud'

export interface StoredOneDriveAccount {
  homeAccountId: string
  displayName: string | null
  email: string | null
}

interface StoredCloudFile {
  account?: string
  clientId?: string
  prefs?: CloudPrefs
}

const DEFAULT_PREFS: CloudPrefs = { moveDisposition: 'trash' }

function normalizeDisposition(value: unknown): CloudMoveDisposition {
  return value === 'keep' || value === 'delete' || value === 'ask' || value === 'trash'
    ? value
    : DEFAULT_PREFS.moveDisposition
}

/**
 * Persists account identity and the optional public-client id. Both values are
 * encrypted with Electron safeStorage; OAuth tokens are stored separately by
 * the MSAL cache plugin in OneDriveAuth.
 */
export class OneDriveCredentialStore {
  private readonly filePath: string

  constructor(filePath = join(app.getPath('userData'), 'cloud', 'account.json')) {
    this.filePath = filePath
  }

  getAccount(): StoredOneDriveAccount | null {
    return this.decrypt<StoredOneDriveAccount>(this.readRaw().account) ?? null
  }

  setAccount(account: StoredOneDriveAccount | null): void {
    const state = this.readRaw()
    state.account = account ? this.encrypt(account) : undefined
    this.writeRaw(state)
  }

  getClientId(): string {
    const stored = this.decrypt<string>(this.readRaw().clientId)?.trim()
    if (stored) return stored
    return process.env['CRATE_ONEDRIVE_CLIENT_ID']?.trim() ?? ''
  }

  setClientId(clientId: string | null): void {
    const state = this.readRaw()
    const normalized = clientId?.trim()
    state.clientId = normalized ? this.encrypt(normalized) : undefined
    this.writeRaw(state)
  }

  getPrefs(): CloudPrefs {
    return { moveDisposition: normalizeDisposition(this.readRaw().prefs?.moveDisposition) }
  }

  setPrefs(patch: Partial<CloudPrefs>): CloudPrefs {
    const current = this.getPrefs()
    const prefs: CloudPrefs = {
      moveDisposition: patch.moveDisposition === undefined
        ? current.moveDisposition
        : normalizeDisposition(patch.moveDisposition),
    }
    const state = this.readRaw()
    state.prefs = prefs
    this.writeRaw(state)
    return prefs
  }

  private readRaw(): StoredCloudFile {
    try {
      if (!existsSync(this.filePath)) return {}
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as StoredCloudFile
        : {}
    } catch (error) {
      console.warn('[cloud] failed to read account state:', (error as Error).message)
      return {}
    }
  }

  private writeRaw(state: StoredCloudFile): void {
    const temp = `${this.filePath}.tmp`
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.filePath)
  }

  private encrypt(value: unknown): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is unavailable on this system.')
    }
    return safeStorage.encryptString(JSON.stringify(value)).toString('base64')
  }

  private decrypt<T>(encoded: string | undefined): T | undefined {
    if (!encoded || !safeStorage.isEncryptionAvailable()) return undefined
    try {
      return JSON.parse(safeStorage.decryptString(Buffer.from(encoded, 'base64'))) as T
    } catch {
      return undefined
    }
  }
}

let instance: OneDriveCredentialStore | null = null

export function getOneDriveCredentialStore(): OneDriveCredentialStore {
  if (!instance) instance = new OneDriveCredentialStore()
  return instance
}
