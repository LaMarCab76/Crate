import { create } from 'zustand'
import type {
  CloudAccountStatus,
  CloudFolderRef,
  CloudMoveProgressEvent,
  CloudPrefs,
  CloudSyncProgressEvent,
  MoveToCloudRequest,
  RemoteFolderEntry,
} from '@shared/types/cloud'

interface CloudStoreState {
  account: CloudAccountStatus | null
  prefs: CloudPrefs | null
  syncProgress: CloudSyncProgressEvent | null
  moveProgress: CloudMoveProgressEvent | null
  busy: boolean
  error: string | null
  load(): Promise<void>
  connect(): Promise<void>
  disconnect(): Promise<void>
  setClientId(clientId: string): Promise<void>
  setPrefs(patch: Partial<CloudPrefs>): Promise<void>
  listRemoteFolders(driveId: string | null, itemId: string | null): Promise<RemoteFolderEntry[]>
  addFolder(driveId: string, itemId: string, name: string): Promise<CloudFolderRef | null>
  syncFolder(folderId: number): Promise<void>
  moveToCloud(req: MoveToCloudRequest): Promise<void>
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const useCloudStore = create<CloudStoreState>((set, get) => ({
  account: null,
  prefs: null,
  syncProgress: null,
  moveProgress: null,
  busy: false,
  error: null,

  async load() {
    try {
      const [account, prefs] = await Promise.all([
        window.api.cloud.accountStatus(),
        window.api.cloud.getPrefs(),
      ])
      set({ account, prefs, error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async connect() {
    set({ busy: true, error: null })
    try {
      const account = await window.api.cloud.connect()
      set({ account, busy: false })
    } catch (err) {
      set({ busy: false, error: errorMessage(err) })
    }
  },

  async disconnect() {
    set({ busy: true, error: null })
    try {
      const account = await window.api.cloud.disconnect()
      set({ account, busy: false })
    } catch (err) {
      set({ busy: false, error: errorMessage(err) })
    }
  },

  async setClientId(clientId) {
    set({ busy: true, error: null })
    try {
      const account = await window.api.cloud.setClientId(clientId)
      set({ account, busy: false })
    } catch (err) {
      set({ busy: false, error: errorMessage(err) })
    }
  },

  async setPrefs(patch) {
    try {
      const prefs = await window.api.cloud.setPrefs(patch)
      set({ prefs, error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async listRemoteFolders(driveId, itemId) {
    try {
      return await window.api.cloud.listRemoteFolders(driveId, itemId)
    } catch (err) {
      set({ error: errorMessage(err) })
      return []
    }
  },

  async addFolder(driveId, itemId, name) {
    try {
      const ref = await window.api.cloud.addFolder(driveId, itemId, name)
      set({ error: null })
      return ref
    } catch (err) {
      set({ error: errorMessage(err) })
      return null
    }
  },

  async syncFolder(folderId) {
    try {
      await window.api.cloud.syncFolder(folderId)
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },

  async moveToCloud(req) {
    try {
      await window.api.cloud.moveToCloud(req)
      set({ error: null })
    } catch (err) {
      set({ error: errorMessage(err) })
    }
  },
}))

if (typeof window !== 'undefined' && window.api?.cloud) {
  window.api.cloud.onAccountChanged(account => {
    useCloudStore.setState({ account })
  })
  window.api.cloud.onSyncProgress(syncProgress => {
    useCloudStore.setState({ syncProgress })
  })
  window.api.cloud.onMoveProgress(moveProgress => {
    useCloudStore.setState({ moveProgress })
  })
}
