import { app, safeStorage, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  InteractionRequiredAuthError,
  LogLevel,
  PublicClientApplication,
  type AccountInfo,
  type Configuration,
  type ICachePlugin,
  type TokenCacheContext,
} from '@azure/msal-node'
import { getOneDriveCredentialStore } from './OneDriveCredentialStore'

// Personal Microsoft accounts only (the user chose "Personal"). For work/school
// or mixed accounts this would become `.../organizations` or `.../common` and the
// Azure app registration's supported-account-types would have to match.
const AUTHORITY = 'https://login.microsoftonline.com/consumers'

// Delegated Graph scopes: read+write files (stream + move + upload), keep a
// refresh token for silent renewal, and read the signed-in user's basic profile.
const SCOPES = ['Files.ReadWrite', 'offline_access', 'User.Read']

export type CloudAuthErrorCode =
  | 'not-configured' // no Azure clientId set yet
  | 'not-connected' // no account in the cache
  | 'interaction-required' // silent refresh failed; user must reconnect
  | 'unavailable' // safeStorage / platform issue

export class CloudAuthError extends Error {
  readonly code: CloudAuthErrorCode
  constructor(code: CloudAuthErrorCode, message: string) {
    super(message)
    this.name = 'CloudAuthError'
    this.code = code
  }
}

// MSAL persists its serialized token cache through this plugin. We encrypt the
// blob with Electron safeStorage (OS keychain-backed) so refresh tokens never
// sit in plaintext under userData. This is the single source of truth for tokens.
function buildCachePlugin(): ICachePlugin {
  const cacheFilePath = join(app.getPath('userData'), 'cloud', 'onedrive-msal-cache.bin')
  return {
    async beforeCacheAccess(ctx: TokenCacheContext): Promise<void> {
      try {
        if (!existsSync(cacheFilePath) || !safeStorage.isEncryptionAvailable()) return
        const json = safeStorage.decryptString(readFileSync(cacheFilePath))
        ctx.tokenCache.deserialize(json)
      } catch (err) {
        console.warn('[cloud] failed to load MSAL cache:', (err as Error).message)
      }
    },
    async afterCacheAccess(ctx: TokenCacheContext): Promise<void> {
      if (!ctx.cacheHasChanged) return
      try {
        if (!safeStorage.isEncryptionAvailable()) return
        mkdirSync(dirname(cacheFilePath), { recursive: true })
        const encrypted = safeStorage.encryptString(ctx.tokenCache.serialize())
        writeFileSync(cacheFilePath, encrypted)
      } catch (err) {
        console.warn('[cloud] failed to persist MSAL cache:', (err as Error).message)
      }
    },
  }
}

export class OneDriveAuth {
  private pca: PublicClientApplication | null = null
  private pcaClientId: string | null = null
  private readonly cachePlugin = buildCachePlugin()

  // The PublicClientApplication is rebuilt if the configured clientId changes
  // (e.g. the user pastes their own Azure app registration). Throws
  // 'not-configured' until a clientId exists.
  private getPca(): PublicClientApplication {
    const clientId = getOneDriveCredentialStore().getClientId()
    if (!clientId) {
      throw new CloudAuthError(
        'not-configured',
        'No OneDrive client ID configured. Register an Azure public-client app and set its Application (client) ID.',
      )
    }
    if (this.pca && this.pcaClientId === clientId) return this.pca

    const config: Configuration = {
      auth: { clientId, authority: AUTHORITY },
      cache: { cachePlugin: this.cachePlugin },
      system: {
        loggerOptions: {
          loggerCallback: (_level, message) => {
            if (process.env['CRATE_CLOUD_DEBUG'] === '1') console.log('[msal]', message)
          },
          piiLoggingEnabled: false,
          logLevel: LogLevel.Error,
        },
      },
    }
    this.pca = new PublicClientApplication(config)
    this.pcaClientId = clientId
    return this.pca
  }

  isClientIdConfigured(): boolean {
    return getOneDriveCredentialStore().getClientId().length > 0
  }

  // Interactive sign-in: opens the system browser to the Microsoft login page
  // and listens on an ephemeral loopback port (redirect URI http://localhost) for
  // the authorization code. PKCE, no client secret. Persists the account identity.
  async connect(): Promise<AccountInfo> {
    const pca = this.getPca()
    const result = await pca.acquireTokenInteractive({
      scopes: SCOPES,
      openBrowser: async (url: string) => {
        await shell.openExternal(url)
      },
      successTemplate:
        '<html><body style="font-family:-apple-system,sans-serif;text-align:center;padding-top:3rem"><h2>Conectado a OneDrive ✓</h2><p>Ya podés cerrar esta ventana y volver a la app.</p></body></html>',
      errorTemplate:
        '<html><body style="font-family:-apple-system,sans-serif;text-align:center;padding-top:3rem"><h2>Algo salió mal</h2><p>Cerrá esta ventana e intentá de nuevo desde la app.</p></body></html>',
    })
    if (!result?.account) {
      throw new CloudAuthError('interaction-required', 'Sign-in did not return an account.')
    }
    getOneDriveCredentialStore().setAccount({
      homeAccountId: result.account.homeAccountId,
      displayName: result.account.name ?? null,
      email: result.account.username ?? null,
    })
    return result.account
  }

  // Resolve the active account from the MSAL cache, preferring the one we
  // persisted at connect time. Returns null when nothing is cached.
  async getAccount(): Promise<AccountInfo | null> {
    let pca: PublicClientApplication
    try {
      pca = this.getPca()
    } catch {
      return null
    }
    const cache = pca.getTokenCache()
    const stored = getOneDriveCredentialStore().getAccount()
    if (stored?.homeAccountId) {
      const byId = await cache.getAccountByHomeId(stored.homeAccountId)
      if (byId) return byId
    }
    const all = await cache.getAllAccounts()
    return all[0] ?? null
  }

  async isConnected(): Promise<boolean> {
    return (await this.getAccount()) != null
  }

  // Silent access-token acquisition for Graph calls. Uses the cached refresh
  // token; never pops a browser. On expiry/revocation throws 'interaction-required'
  // so background callers (streaming, delta poll) can surface "reconnect" instead
  // of hijacking the UI with a login window.
  async getAccessToken(): Promise<string> {
    const pca = this.getPca()
    const account = await this.getAccount()
    if (!account) throw new CloudAuthError('not-connected', 'OneDrive account is not connected.')
    try {
      const result = await pca.acquireTokenSilent({ account, scopes: SCOPES })
      return result.accessToken
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError) {
        throw new CloudAuthError('interaction-required', 'OneDrive session expired; reconnect required.')
      }
      throw err
    }
  }

  async disconnect(): Promise<void> {
    try {
      const pca = this.getPca()
      const account = await this.getAccount()
      if (account) await pca.getTokenCache().removeAccount(account)
    } catch (err) {
      console.warn('[cloud] disconnect cleanup failed:', (err as Error).message)
    }
    getOneDriveCredentialStore().setAccount(null)
  }
}

let instance: OneDriveAuth | null = null
export function getOneDriveAuth(): OneDriveAuth {
  if (!instance) instance = new OneDriveAuth()
  return instance
}
