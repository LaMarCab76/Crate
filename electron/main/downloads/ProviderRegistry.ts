import type { DownloadProvider } from '@shared/types/downloads'
import { getCredentialStore } from './CredentialStore'
import { QobuzProvider } from './QobuzProvider'
import { TidalProvider } from './TidalProvider'
import type { OnlineProvider } from './types'

export class ProviderRegistry {
  private providers: Record<DownloadProvider, OnlineProvider>

  constructor() {
    const store = getCredentialStore()
    this.providers = {
      qobuz: new QobuzProvider(store),
      tidal: new TidalProvider(store),
    }
  }

  get(provider: DownloadProvider): OnlineProvider {
    return this.providers[provider]
  }
}

let instance: ProviderRegistry | null = null
export function getProviderRegistry(): ProviderRegistry {
  if (!instance) instance = new ProviderRegistry()
  return instance
}
