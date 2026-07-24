import { create } from 'zustand'
import type { LibraryLocationsApi } from '@shared/types/ipc-contract'
import type {
  LibraryLocation as SharedLibraryLocation,
  LibraryProvider,
  LibraryRole,
  LocalAccessState,
  LocalAccessStatus,
} from '@shared/types/library-locations'

export type { LibraryProvider, LibraryRole }

export interface LibraryLocation extends SharedLibraryLocation {
  available: boolean
}

export interface LocalLocationSelection {
  canceled: boolean
  token: string | null
  displayPath: string | null
}

export interface OneDriveFolderEntry {
  driveId: string
  itemId: string
  name: string
  path: string
  childCount: number | null
}

export interface OneDriveConnection {
  connected: boolean
  clientIdConfigured: boolean
  displayName: string | null
  email: string | null
}

interface AddLocationOptions {
  role: LibraryRole
  backupSourceFolderId?: number | null
}

interface LibraryLocationsState {
  locations: LibraryLocation[]
  oneDrive: OneDriveConnection | null
  initialized: boolean
  loading: boolean
  pickerBusy: boolean
  error: string | null
  load(): Promise<void>
  clearError(): void
  setOneDriveClientId(clientId: string): Promise<boolean>
  connectOneDrive(): Promise<boolean>
  listOneDriveFolders(driveId: string | null, itemId: string | null): Promise<OneDriveFolderEntry[]>
  pickAndAddLocal(options: AddLocationOptions): Promise<LibraryLocation | null>
  addOneDriveFolder(entry: OneDriveFolderEntry, options: AddLocationOptions): Promise<LibraryLocation | null>
  requestLocalAccess(folderId: number): Promise<boolean>
  openFilePrivacySettings(): Promise<void>
  removeLocation(folderId: number): Promise<void>
  updatePresentation(folderId: number, input: { name: string; displayIcon: string | null }): Promise<void>
}

function locationsApi(): LibraryLocationsApi {
  return window.api.libraryLocations
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function stringValue(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function numberValue(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function booleanValue(record: Record<string, unknown>, fallback: boolean, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') return value
    if (value === 1) return true
    if (value === 0) return false
  }
  return fallback
}

function normalizeLocalAccess(raw: unknown): LocalAccessStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const rawState = stringValue(value, 'state')
  const validStates: LocalAccessState[] = ['ready', 'permission_required', 'unavailable', 'read_only']
  if (!rawState || !validStates.includes(rawState as LocalAccessState)) return null
  return {
    state: rawState as LocalAccessState,
    canRead: booleanValue(value, false, 'canRead', 'can_read'),
    canWrite: booleanValue(value, false, 'canWrite', 'can_write'),
    detail: stringValue(value, 'detail'),
  }
}

function normalizeLocation(raw: unknown): LibraryLocation {
  const value = asRecord(raw)
  const providerValue = stringValue(value, 'provider', 'source')
  const roleValue = stringValue(value, 'role')
  const provider: LibraryProvider = providerValue === 'onedrive' ? 'onedrive' : 'local'
  const role: LibraryRole = roleValue === 'backup' ? 'backup' : 'library'
  const name = stringValue(value, 'name') ?? (provider === 'onedrive' ? 'OneDrive' : 'Biblioteca local')
  const remotePath = stringValue(value, 'remotePath', 'remote_path')
  const path = stringValue(value, 'displayPath', 'path') ?? remotePath ?? name

  return {
    id: numberValue(value, 'id', 'folderId', 'folder_id') ?? 0,
    name,
    provider,
    role,
    path,
    trackCount: numberValue(value, 'trackCount', 'track_count') ?? 0,
    backupSourceFolderId: numberValue(value, 'backupSourceFolderId', 'backup_source_folder_id'),
    available: booleanValue(value, true, 'available', 'isAvailable', 'is_available'),
    accountId: stringValue(value, 'accountId', 'account_id'),
    driveId: stringValue(value, 'driveId', 'drive_id'),
    itemId: stringValue(value, 'itemId', 'item_id'),
    remotePath,
    deltaCursor: stringValue(value, 'deltaCursor', 'delta_cursor'),
    displayIcon: stringValue(value, 'displayIcon', 'display_icon'),
    dateAdded: stringValue(value, 'dateAdded', 'date_added') ?? '',
    dateUpdated: stringValue(value, 'dateUpdated', 'date_updated') ?? '',
    localAccess: normalizeLocalAccess(value.localAccess ?? value.local_access),
  }
}

function normalizeSelection(raw: unknown): LocalLocationSelection {
  const value = asRecord(raw)
  return {
    canceled: booleanValue(value, false, 'canceled', 'cancelled'),
    token: stringValue(value, 'token', 'pathToken', 'path_token'),
    displayPath: stringValue(value, 'displayPath', 'display_path', 'path'),
  }
}

function normalizeOneDriveEntry(raw: unknown): OneDriveFolderEntry | null {
  const value = asRecord(raw)
  const driveId = stringValue(value, 'driveId', 'drive_id')
  const itemId = stringValue(value, 'itemId', 'item_id', 'id')
  if (!driveId || !itemId) return null
  const name = stringValue(value, 'name') ?? 'Carpeta'
  return {
    driveId,
    itemId,
    name,
    path: stringValue(value, 'path', 'remotePath', 'remote_path') ?? name,
    childCount: numberValue(value, 'childCount', 'child_count'),
  }
}

function normalizeConnection(raw: unknown): OneDriveConnection {
  const value = asRecord(raw)
  return {
    connected: booleanValue(value, false, 'connected'),
    clientIdConfigured: booleanValue(value, true, 'clientIdConfigured', 'client_id_configured'),
    displayName: stringValue(value, 'displayName', 'display_name'),
    email: stringValue(value, 'email', 'username'),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function upsertLocation(locations: LibraryLocation[], location: LibraryLocation): LibraryLocation[] {
  const exists = locations.some(item => item.id === location.id)
  return exists
    ? locations.map(item => item.id === location.id ? location : item)
    : [...locations, location]
}

export const useLibraryLocationsStore = create<LibraryLocationsState>((set, get) => ({
  locations: [],
  oneDrive: null,
  initialized: false,
  loading: false,
  pickerBusy: false,
  error: null,

  async load() {
    set({ loading: true, error: null })
    try {
      const api = locationsApi()
      const rawLocations = await api.list()
      let rawStatus: unknown = null
      try {
        rawStatus = await api.getOneDriveStatus()
      } catch {
        // Listing locations is the source of truth for onboarding. A cloud
        // status failure must not make an existing local library look empty.
      }
      set({
        locations: rawLocations.map(normalizeLocation),
        oneDrive: rawStatus == null ? null : normalizeConnection(rawStatus),
        initialized: true,
        loading: false,
      })
    } catch (error) {
      set({ initialized: true, loading: false, error: errorMessage(error) })
    }
  },

  clearError() {
    set({ error: null })
  },

  async setOneDriveClientId(clientId) {
    set({ pickerBusy: true, error: null })
    try {
      const api = locationsApi()
      const status = normalizeConnection(await api.setOneDriveClientId(clientId))
      set({ oneDrive: status, pickerBusy: false })
      return status.clientIdConfigured
    } catch (error) {
      set({ pickerBusy: false, error: errorMessage(error) })
      return false
    }
  },

  async connectOneDrive() {
    set({ pickerBusy: true, error: null })
    try {
      const api = locationsApi()
      const status = normalizeConnection(await api.connectOneDrive())
      set({ oneDrive: status, pickerBusy: false })
      return status.connected
    } catch (error) {
      set({ pickerBusy: false, error: errorMessage(error) })
      return false
    }
  },

  async listOneDriveFolders(driveId, itemId) {
    set({ pickerBusy: true, error: null })
    try {
      const entries = await locationsApi().listOneDriveFolders(driveId, itemId)
      set({ pickerBusy: false })
      return entries.map(normalizeOneDriveEntry).filter((entry): entry is OneDriveFolderEntry => entry != null)
    } catch (error) {
      set({ pickerBusy: false, error: errorMessage(error) })
      return []
    }
  },

  async pickAndAddLocal(options) {
    set({ pickerBusy: true, error: null })
    try {
      const api = locationsApi()
      const selection = normalizeSelection(await api.pickLocal())
      if (selection.canceled) {
        set({ pickerBusy: false })
        return null
      }
      if (!selection.token) throw new Error('La carpeta elegida no devolvió una autorización válida.')
      const location = normalizeLocation(await api.addLocal({
        token: selection.token,
        role: options.role,
        backupSourceFolderId: options.backupSourceFolderId ?? null,
      }))
      if (location.id <= 0) throw new Error('No se pudo registrar la carpeta elegida.')
      set(state => ({ locations: upsertLocation(state.locations, location), pickerBusy: false }))
      return location
    } catch (error) {
      set({ pickerBusy: false, error: errorMessage(error) })
      return null
    }
  },

  async addOneDriveFolder(entry, options) {
    set({ pickerBusy: true, error: null })
    try {
      const location = normalizeLocation(await locationsApi().addOneDrive({
        driveId: entry.driveId,
        itemId: entry.itemId,
        name: entry.name,
        remotePath: entry.path,
        role: options.role,
        backupSourceFolderId: options.backupSourceFolderId ?? null,
      }))
      if (location.id <= 0) throw new Error('No se pudo registrar la carpeta de OneDrive.')
      set(state => ({ locations: upsertLocation(state.locations, location), pickerBusy: false }))
      return location
    } catch (error) {
      set({ pickerBusy: false, error: errorMessage(error) })
      return null
    }
  },

  async requestLocalAccess(folderId) {
    set({ pickerBusy: true, error: null })
    try {
      const result = await locationsApi().requestLocalAccess(folderId)
      set(state => ({
        locations: state.locations.map(location => location.id === folderId
          ? {
              ...location,
              localAccess: result.status,
              available: result.status.state !== 'unavailable',
            }
          : location),
        pickerBusy: false,
      }))
      return !result.canceled && result.status.canRead
    } catch (error) {
      set({ pickerBusy: false, error: errorMessage(error) })
      return false
    }
  },

  async openFilePrivacySettings() {
    try {
      await locationsApi().openFilePrivacySettings()
    } catch (error) {
      set({ error: errorMessage(error) })
    }
  },

  async removeLocation(folderId) {
    set({ error: null })
    try {
      const api = locationsApi()
      await api.remove(folderId)
      set({ locations: get().locations.filter(item => item.id !== folderId) })
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },

  async updatePresentation(folderId, input) {
    set({ error: null })
    try {
      const location = normalizeLocation(await locationsApi().updatePresentation(folderId, input))
      set(state => ({ locations: upsertLocation(state.locations, location) }))
    } catch (error) {
      set({ error: errorMessage(error) })
      throw error
    }
  },
}))
