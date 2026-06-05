import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CloudMoveDisposition, CloudPrefs } from '@shared/types/cloud'

// Non-token OneDrive state: the connected account's display identity, the
// optional user-supplied Azure clientId, and user preferences. The MSAL token
// cache itself lives in a separate encrypted blob owned by OneDriveAuth.
//
// Tokens are the only truly secret values, but we still encrypt this file too
// (clientId + email) with safeStorage to match the downloads CredentialStore
// posture and avoid leaving identifiers in plaintext under userData.

export interface StoredAccount {
  homeAccountId: string
  displayName: string | null
  email: string | null
}

interface StoredCloudFile {
  account?: string // encrypted StoredAccount
  clientId?: string // encrypted string
  prefs?: CloudPrefs // not secret; stored as-is
}

const DEFAULT_PREFS: CloudPrefs = {
  moveDisposition: 'trash',
}

function normalizeDisposition(value: unknown): CloudMoveDisposition {
  return value === 'keep' || value === 'delete' || value === 'ask' || value === 'trash'
    ? value
    : DEFAULT_PREFS.moveDisposition
}

export class OneDriveCredentialStore {
  private dir: string
  private filePath: string

  constructor() {
    this.dir = join(app.getPath('userData'), 'cloud')
    this.filePath = join(this.dir, 'account.json')
  }

  getAccount(): StoredAccount | null {
    return this.read().account ?? null
  }

  setAccount(account: StoredAccount | null): void {
    const all = this.readRaw()
    all.account = account ? this.encrypt(account) : undefined
    this.writeRaw(all)
  }

  // clientId resolution order: user-pasted (this store) → build-time env var →
  // empty (caller treats as "not configured"). Lets us ship a default while
  // still allowing advanced users to bring their own Azure app registration.
  getClientId(): string {
    const stored = this.read().clientId
    if (stored && stored.trim()) return stored.trim()
    const fromEnv = process.env['CRATE_ONEDRIVE_CLIENT_ID']
    if (fromEnv && fromEnv.trim()) return fromEnv.trim()
    return ''
  }

  setClientId(clientId: string | null): void {
    const all = this.readRaw()
    const trimmed = clientId?.trim()
    all.clientId = trimmed ? this.encrypt(trimmed) : undefined
    this.writeRaw(all)
  }

  getPrefs(): CloudPrefs {
    const prefs = this.read().prefs
    return { moveDisposition: normalizeDisposition(prefs?.moveDisposition) }
  }

  setPrefs(patch: Partial<CloudPrefs>): CloudPrefs {
    const current = this.getPrefs()
    const next: CloudPrefs = {
      moveDisposition: patch.moveDisposition === undefined
        ? current.moveDisposition
        : normalizeDisposition(patch.moveDisposition),
    }
    const all = this.readRaw()
    all.prefs = next
    this.writeRaw(all)
    return next
  }

  private read(): { account?: StoredAccount; clientId?: string; prefs?: CloudPrefs } {
    const raw = this.readRaw()
    return {
      account: this.decrypt<StoredAccount>(raw.account),
      clientId: this.decrypt<string>(raw.clientId),
      prefs: raw.prefs,
    }
  }

  private readRaw(): StoredCloudFile {
    try {
      if (!existsSync(this.filePath)) return {}
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as StoredCloudFile
    } catch (err) {
      console.warn('[cloud] failed to read account file:', (err as Error).message)
      return {}
    }
  }

  private writeRaw(value: StoredCloudFile): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(value, null, 2))
  }

  private encrypt(value: unknown): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is unavailable on this system.')
    }
    return safeStorage.encryptString(JSON.stringify(value)).toString('base64')
  }

  private decrypt<T>(encoded: string | undefined): T | undefined {
    if (!encoded) return undefined
    if (!safeStorage.isEncryptionAvailable()) return undefined
    try {
      const json = safeStorage.decryptString(Buffer.from(encoded, 'base64'))
      return JSON.parse(json) as T
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
