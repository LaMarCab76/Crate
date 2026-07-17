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

const PERSONAL_AUTHORITY = 'https://login.microsoftonline.com/consumers'
const GRAPH_SCOPES = ['Files.ReadWrite', 'User.Read']

export type CloudAuthErrorCode =
  | 'not-configured'
  | 'not-connected'
  | 'interaction-required'
  | 'unavailable'

export class CloudAuthError extends Error {
  readonly code: CloudAuthErrorCode

  constructor(code: CloudAuthErrorCode, message: string) {
    super(message)
    this.name = 'CloudAuthError'
    this.code = code
  }
}

function createEncryptedCachePlugin(cacheFilePath: string): ICachePlugin {
  return {
    async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
      try {
        if (!existsSync(cacheFilePath) || !safeStorage.isEncryptionAvailable()) return
        context.tokenCache.deserialize(safeStorage.decryptString(readFileSync(cacheFilePath)))
      } catch (error) {
        console.warn('[cloud] failed to load MSAL cache:', (error as Error).message)
      }
    },
    async afterCacheAccess(context: TokenCacheContext): Promise<void> {
      if (!context.cacheHasChanged) return
      if (!safeStorage.isEncryptionAvailable()) {
        throw new CloudAuthError('unavailable', 'Secure storage is unavailable on this system.')
      }
      mkdirSync(dirname(cacheFilePath), { recursive: true })
      writeFileSync(
        cacheFilePath,
        safeStorage.encryptString(context.tokenCache.serialize()),
        { mode: 0o600 },
      )
    },
  }
}

/** Personal-account OAuth client. MSAL's interactive flow performs PKCE and a
 * loopback redirect; no client secret is ever embedded in the application. */
export class OneDriveAuth {
  private application: PublicClientApplication | null = null
  private applicationClientId: string | null = null
  private readonly cachePlugin: ICachePlugin

  constructor(cacheFilePath = join(app.getPath('userData'), 'cloud', 'onedrive-msal-cache.bin')) {
    this.cachePlugin = createEncryptedCachePlugin(cacheFilePath)
  }

  isClientIdConfigured(): boolean {
    return getOneDriveCredentialStore().getClientId().length > 0
  }

  async connect(): Promise<AccountInfo> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new CloudAuthError('unavailable', 'Secure storage is unavailable on this system.')
    }
    const result = await this.getApplication().acquireTokenInteractive({
      scopes: GRAPH_SCOPES,
      openBrowser: async url => shell.openExternal(url),
      successTemplate:
        '<html><body style="font-family:system-ui;text-align:center;padding-top:3rem"><h2>OneDrive conectado</h2><p>Ya podés cerrar esta ventana.</p></body></html>',
      errorTemplate:
        '<html><body style="font-family:system-ui;text-align:center;padding-top:3rem"><h2>No se pudo conectar OneDrive</h2><p>Volvé a Crate e intentá nuevamente.</p></body></html>',
    })
    if (!result?.account) {
      throw new CloudAuthError('interaction-required', 'Microsoft did not return an account.')
    }
    getOneDriveCredentialStore().setAccount({
      homeAccountId: result.account.homeAccountId,
      displayName: result.account.name ?? null,
      email: result.account.username ?? null,
    })
    return result.account
  }

  async getAccount(): Promise<AccountInfo | null> {
    let application: PublicClientApplication
    try {
      application = this.getApplication()
    } catch (error) {
      if (error instanceof CloudAuthError && error.code === 'not-configured') return null
      throw error
    }
    const cache = application.getTokenCache()
    const stored = getOneDriveCredentialStore().getAccount()
    if (stored?.homeAccountId) {
      const account = await cache.getAccountByHomeId(stored.homeAccountId)
      if (account) return account
    }
    return (await cache.getAllAccounts())[0] ?? null
  }

  async isConnected(): Promise<boolean> {
    return (await this.getAccount()) !== null
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    const application = this.getApplication()
    const account = await this.getAccount()
    if (!account) throw new CloudAuthError('not-connected', 'OneDrive is not connected.')
    try {
      const result = await application.acquireTokenSilent({
        account,
        scopes: GRAPH_SCOPES,
        forceRefresh,
      })
      return result.accessToken
    } catch (error) {
      if (error instanceof InteractionRequiredAuthError) {
        throw new CloudAuthError(
          'interaction-required',
          'The OneDrive session expired; reconnect the account.',
        )
      }
      throw error
    }
  }

  async disconnect(): Promise<void> {
    try {
      const account = await this.getAccount()
      if (account) await this.getApplication().getTokenCache().removeAccount(account)
    } catch (error) {
      console.warn('[cloud] failed to remove cached account:', (error as Error).message)
    } finally {
      getOneDriveCredentialStore().setAccount(null)
    }
  }

  private getApplication(): PublicClientApplication {
    const clientId = getOneDriveCredentialStore().getClientId()
    if (!clientId) {
      throw new CloudAuthError(
        'not-configured',
        'Configure the Application (client) ID of a Microsoft public-client app.',
      )
    }
    if (this.application && this.applicationClientId === clientId) return this.application

    const configuration: Configuration = {
      auth: { clientId, authority: PERSONAL_AUTHORITY },
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
    this.application = new PublicClientApplication(configuration)
    this.applicationClientId = clientId
    return this.application
  }
}

let instance: OneDriveAuth | null = null

export function getOneDriveAuth(): OneDriveAuth {
  if (!instance) instance = new OneDriveAuth()
  return instance
}
