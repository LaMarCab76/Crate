import { create } from 'zustand'
import type {
  DownloadJob,
  DownloadProvider,
  DownloadSearchRequest,
  DownloadSettings,
  EnqueueDownloadRequest,
  HarImportPreview,
  OnlineTrackResult,
  ProviderAuthState,
  ProviderCredentialsPayload,
  ServiceTutorialState,
} from '@shared/types/downloads'

interface DownloadStoreState {
  settings: DownloadSettings | null
  jobs: DownloadJob[]
  results: OnlineTrackResult[]
  auth: Record<DownloadProvider, ProviderAuthState | null>
  tutorial: ServiceTutorialState | null
  loading: boolean
  searching: boolean
  error: string | null
  load(): Promise<void>
  refreshAuth(provider?: DownloadProvider): Promise<void>
  setSettings(patch: Partial<DownloadSettings>): Promise<void>
  saveCredentials(payload: ProviderCredentialsPayload): Promise<void>
  clearCredentials(provider: DownloadProvider): Promise<void>
  inspectHar(provider: DownloadProvider, files: File[]): Promise<HarImportPreview | null>
  applyHarImport(provider: DownloadProvider, previewId: string): Promise<void>
  setTutorialState(patch: Partial<ServiceTutorialState>): Promise<void>
  search(payload: DownloadSearchRequest): Promise<void>
  enqueue(payload: EnqueueDownloadRequest): Promise<void>
  cancel(jobId: string): Promise<void>
  retry(jobId: string): Promise<void>
}

const DEFAULT_AUTH: Record<DownloadProvider, ProviderAuthState | null> = {
  qobuz: null,
  tidal: null,
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const useDownloadStore = create<DownloadStoreState>((set, get) => ({
  settings: null,
  jobs: [],
  results: [],
  auth: DEFAULT_AUTH,
  tutorial: null,
  loading: false,
  searching: false,
  error: null,

  async load() {
    set({ loading: true, error: null })
    try {
      const [settings, jobs, qobuz, tidal, tutorial] = await Promise.all([
        window.api.downloads.getSettings(),
        window.api.downloads.jobs(),
        window.api.downloads.getAuthState('qobuz'),
        window.api.downloads.getAuthState('tidal'),
        window.api.downloads.getTutorialState(),
      ])
      set({ settings, jobs, auth: { qobuz, tidal }, tutorial, loading: false })
    } catch (err) {
      set({ loading: false, error: errorMessage(err) })
    }
  },

  async refreshAuth(provider) {
    try {
      if (provider) {
        const state = await window.api.downloads.getAuthState(provider)
        set(prev => ({ auth: { ...prev.auth, [provider]: state } }))
        return
      }
      const [qobuz, tidal] = await Promise.all([
        window.api.downloads.getAuthState('qobuz'),
        window.api.downloads.getAuthState('tidal'),
      ])
      set({ auth: { qobuz, tidal } })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async setSettings(patch) {
    try {
      const settings = await window.api.downloads.setSettings(patch)
      set({ settings, error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async saveCredentials(payload) {
    try {
      await window.api.downloads.saveCredentials(payload)
      await get().refreshAuth(payload.provider)
      set({ error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async clearCredentials(provider) {
    try {
      await window.api.downloads.clearCredentials(provider)
      await get().refreshAuth(provider)
      set({ error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async inspectHar(provider, files) {
    try {
      const preview = await window.api.downloads.inspectHar(provider, files)
      set({ error: null })
      return preview
    } catch (err) {
      set({ error: errorMessage(err) })
      return null
    }
  },

  async applyHarImport(provider, previewId) {
    try {
      await window.api.downloads.applyHarImport(provider, previewId)
      await get().refreshAuth(provider)
      set({ error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async setTutorialState(patch) {
    try {
      const tutorial = await window.api.downloads.setTutorialState(patch)
      set({ tutorial, error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async search(payload) {
    const query = payload.query.trim()
    if (!query) {
      set({ results: [], searching: false, error: null })
      return
    }
    set({ searching: true, error: null })
    try {
      const results = await window.api.downloads.search(payload)
      set({ results, searching: false })
    } catch (err) {
      set({ searching: false, results: [], error: errorMessage(err) })
    }
  },

  async enqueue(payload) {
    try {
      await window.api.downloads.enqueue(payload)
      const jobs = await window.api.downloads.jobs()
      set({ jobs, error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async cancel(jobId) {
    await window.api.downloads.cancel(jobId)
  },

  async retry(jobId) {
    await window.api.downloads.retry(jobId)
  },
}))

if (typeof window !== 'undefined' && window.api?.downloads) {
  const offProgress = window.api.downloads.onProgress(({ job }) => {
    useDownloadStore.setState(state => {
      const exists = state.jobs.some(item => item.id === job.id)
      const jobs = exists
        ? state.jobs.map(item => item.id === job.id ? job : item)
        : [job, ...state.jobs]
      return { jobs }
    })
  })

  const offJobsChanged = window.api.downloads.onJobsChanged(({ jobs }) => {
    useDownloadStore.setState({ jobs })
  })
  import.meta.hot?.dispose(() => {
    offProgress()
    offJobsChanged()
  })
}
