import { create } from 'zustand'
import type {
  DeviceCandidate,
  DeviceConnectPayload,
  DeviceLibraryResult,
  DevicePendingJournal,
  DeviceRecord,
  DeviceScanProgressEvent,
  DeviceScanResult,
  DeviceSettingsUpdate,
  DeviceSyncApplyResult,
  DeviceSyncMode,
  DeviceSyncPlan,
  DeviceSyncProgressEvent,
  DeviceUnknownVolume,
  DeviceVolumeSnapshot,
  RockboxThemeInstallResult,
  RockboxThemeLibraryResult,
} from '@shared/types/device-sync'

interface DeviceState {
  devices: DeviceRecord[]
  candidates: DeviceCandidate[]
  unknownVolumes: DeviceUnknownVolume[]
  pendingJournals: DevicePendingJournal[]
  deviceLibraries: Record<string, DeviceLibraryResult>
  rockboxThemeLibraries: Record<string, RockboxThemeLibraryResult>
  scanResult: DeviceScanResult | null
  plan: DeviceSyncPlan | null
  scanProgress: DeviceScanProgressEvent | null
  syncProgress: DeviceSyncProgressEvent | null
  themeInstallResult: RockboxThemeInstallResult | null
  selectedDeviceId: string | null
  loading: boolean
  error: string | null
  load(): Promise<void>
  loadPendingJournals(): Promise<void>
  detectCandidates(): Promise<void>
  refreshVolumes(): Promise<void>
  ignoreVolume(rootPath: string): Promise<void>
  connect(payload: DeviceConnectPayload): Promise<DeviceRecord>
  updateSettings(deviceId: string, settings: DeviceSettingsUpdate): Promise<DeviceRecord>
  loadDeviceLibrary(deviceId: string, force?: boolean): Promise<DeviceLibraryResult>
  loadRockboxThemes(deviceId: string, force?: boolean): Promise<RockboxThemeLibraryResult>
  installRockboxThemes(deviceId: string, files: unknown[]): Promise<RockboxThemeInstallResult>
  selectDevice(id: string): void
  scan(deviceId?: string): Promise<void>
  planSync(mode: DeviceSyncMode, pcTargetPath?: string): Promise<DeviceSyncPlan>
  applyPlan(planId: string): Promise<DeviceSyncApplyResult>
  resumeJournal(journalId: string): Promise<DeviceSyncApplyResult>
  discardJournal(journalId: string): Promise<void>
  clearPlan(): void
}

function currentDeviceId(state: DeviceState, explicit?: string): string {
  const deviceId = explicit ?? state.selectedDeviceId
  if (!deviceId) throw new Error('No device selected')
  return deviceId
}

function nextSelectedDeviceId(
  current: string | null,
  devices: DeviceRecord[],
  fallback?: string | null,
): string | null {
  if (fallback && devices.some(device => device.id === fallback)) return fallback
  if (current && devices.some(device => device.id === current)) return current
  return devices[0]?.id ?? null
}

function rockboxThemesFromLibrary(library: DeviceLibraryResult): RockboxThemeLibraryResult {
  return {
    device: library.device,
    themes: library.rockboxThemes,
    scan: library.rockboxThemeScan,
  }
}

function canReuseDeviceLibrary(library: DeviceLibraryResult, device?: DeviceRecord): boolean {
  const storage = library.storage
  if (!storage) return false
  const isAvailable = device?.isAvailable ?? library.device.isAvailable
  if (!isAvailable) return true
  return !storage.error && storage.totalBytes > 0
}

export const useDeviceStore = create<DeviceState>((set, get) => ({
  devices: [],
  candidates: [],
  unknownVolumes: [],
  pendingJournals: [],
  deviceLibraries: {},
  rockboxThemeLibraries: {},
  scanResult: null,
  plan: null,
  scanProgress: null,
  syncProgress: null,
  themeInstallResult: null,
  selectedDeviceId: null,
  loading: false,
  error: null,

  async load() {
    set({ loading: true, error: null })
    try {
      const [devices, pendingJournals] = await Promise.all([
        window.api.devices.list(),
        window.api.devices.listPendingJournals(),
      ])
      set(state => ({
        devices,
        pendingJournals,
        selectedDeviceId: nextSelectedDeviceId(state.selectedDeviceId, devices),
        loading: false,
      }))
    } catch (err) {
      set({ loading: false, error: (err as Error).message })
    }
  },

  async loadPendingJournals() {
    try {
      const pendingJournals = await window.api.devices.listPendingJournals()
      set({ pendingJournals })
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  async detectCandidates() {
    try {
      const candidates = await window.api.devices.detectCandidates()
      set({ candidates })
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  async refreshVolumes() {
    try {
      const snapshot = await window.api.devices.volumes()
      set(state => ({
        devices: snapshot.devices,
        candidates: snapshot.candidates,
        unknownVolumes: snapshot.unknownVolumes,
        selectedDeviceId: nextSelectedDeviceId(state.selectedDeviceId, snapshot.devices),
      }))
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  async ignoreVolume(rootPath) {
    try {
      const snapshot = await window.api.devices.ignoreVolume(rootPath)
      set(state => ({
        devices: snapshot.devices,
        candidates: snapshot.candidates,
        unknownVolumes: snapshot.unknownVolumes,
        selectedDeviceId: nextSelectedDeviceId(state.selectedDeviceId, snapshot.devices),
      }))
    } catch (err) {
      set({ error: (err as Error).message })
      throw err
    }
  },

  async connect(payload) {
    set({ loading: true, error: null })
    try {
      const device = await window.api.devices.connect(payload)
      const [devices, pendingJournals, library] = await Promise.all([
        window.api.devices.list(),
        window.api.devices.listPendingJournals(),
        window.api.devices.library(device.id).catch(() => null),
      ])
      set(state => ({
        devices,
        pendingJournals,
        selectedDeviceId: device.id,
        loading: false,
        unknownVolumes: state.unknownVolumes.filter(volume => volume.rootPath !== device.rootPath),
        candidates: state.candidates.filter(candidate => candidate.rootPath !== device.rootPath),
        deviceLibraries: library
          ? { ...state.deviceLibraries, [device.id]: library }
          : state.deviceLibraries,
        rockboxThemeLibraries: library
          ? { ...state.rockboxThemeLibraries, [device.id]: rockboxThemesFromLibrary(library) }
          : state.rockboxThemeLibraries,
      }))
      return device
    } catch (err) {
      set({ loading: false, error: (err as Error).message })
      throw err
    }
  },

  async updateSettings(deviceId, settings) {
    set({ loading: true, error: null })
    try {
      const device = await window.api.devices.updateSettings(deviceId, settings)
      const devices = await window.api.devices.list()
      set(state => ({
        devices,
        selectedDeviceId: device.id,
        scanResult: state.scanResult?.device.id === device.id
          ? { ...state.scanResult, device }
          : state.scanResult,
        deviceLibraries: state.deviceLibraries[device.id]
          ? { ...state.deviceLibraries, [device.id]: { ...state.deviceLibraries[device.id], device } }
          : state.deviceLibraries,
        rockboxThemeLibraries: state.rockboxThemeLibraries[device.id]
          ? { ...state.rockboxThemeLibraries, [device.id]: { ...state.rockboxThemeLibraries[device.id], device } }
          : state.rockboxThemeLibraries,
        loading: false,
      }))
      return device
    } catch (err) {
      set({ loading: false, error: (err as Error).message })
      throw err
    }
  },

  async loadDeviceLibrary(deviceId, force = false) {
    const state = get()
    const cached = state.deviceLibraries[deviceId]
    const device = state.devices.find(item => item.id === deviceId) ?? cached?.device
    if (cached && !force && canReuseDeviceLibrary(cached, device)) return cached
    set({ loading: true, error: null })
    try {
      const library = await window.api.devices.library(deviceId)
      set(state => ({
        deviceLibraries: { ...state.deviceLibraries, [deviceId]: library },
        rockboxThemeLibraries: {
          ...state.rockboxThemeLibraries,
          [deviceId]: rockboxThemesFromLibrary(library),
        },
        selectedDeviceId: deviceId,
        loading: false,
      }))
      return library
    } catch (err) {
      set({ loading: false, error: (err as Error).message })
      throw err
    }
  },

  async loadRockboxThemes(deviceId, force = false) {
    const cached = get().rockboxThemeLibraries[deviceId]
    if (cached && !force) return cached
    set({ loading: true, error: null })
    try {
      let library: DeviceLibraryResult | null = null
      let themes: RockboxThemeLibraryResult
      if (typeof window.api.devices.rockboxThemes === 'function') {
        themes = await window.api.devices.rockboxThemes(deviceId)
      } else {
        library = await window.api.devices.library(deviceId)
        themes = rockboxThemesFromLibrary(library)
      }
      set(state => ({
        devices: state.devices.map(device => device.id === themes.device.id ? themes.device : device),
        deviceLibraries: library
          ? { ...state.deviceLibraries, [deviceId]: library }
          : state.deviceLibraries,
        rockboxThemeLibraries: { ...state.rockboxThemeLibraries, [deviceId]: themes },
        selectedDeviceId: deviceId,
        loading: false,
      }))
      return themes
    } catch (err) {
      set({ loading: false, error: (err as Error).message })
      throw err
    }
  },

  async installRockboxThemes(deviceId, files) {
    set({ loading: true, error: null, themeInstallResult: null })
    try {
      const result = await window.api.devices.installRockboxThemesFromFiles(deviceId, files)
      const devices = await window.api.devices.list()
      set(state => {
        const cachedDevice =
          devices.find(device => device.id === deviceId) ??
          state.rockboxThemeLibraries[deviceId]?.device ??
          state.deviceLibraries[deviceId]?.device ??
          state.devices.find(device => device.id === deviceId)
        return {
          devices,
          deviceLibraries: state.deviceLibraries[deviceId]
            ? {
                ...state.deviceLibraries,
                [deviceId]: {
                  ...state.deviceLibraries[deviceId],
                  rockboxThemes: result.themes,
                  rockboxThemeScan: result.scan,
                  summary: {
                    ...state.deviceLibraries[deviceId].summary,
                    rockboxThemeCount: result.themes.length,
                  },
                },
              }
            : state.deviceLibraries,
          rockboxThemeLibraries: cachedDevice
            ? {
                ...state.rockboxThemeLibraries,
                [deviceId]: {
                  device: cachedDevice,
                  themes: result.themes,
                  scan: result.scan,
                },
              }
            : state.rockboxThemeLibraries,
          themeInstallResult: result,
          loading: false,
        }
      })
      return result
    } catch (err) {
      set({ loading: false, error: (err as Error).message })
      throw err
    }
  },

  selectDevice(id) {
    set({ selectedDeviceId: id, plan: null, scanResult: null, error: null })
  },

  async scan(deviceId) {
    const id = currentDeviceId(get(), deviceId)
    set({ loading: true, error: null, scanResult: null })
    try {
      const scanResult = await window.api.devices.scan(id)
      const [devices, library] = await Promise.all([
        window.api.devices.list(),
        window.api.devices.library(id).catch(() => null),
      ])
      set(state => ({
        devices,
        scanResult,
        selectedDeviceId: id,
        loading: false,
        scanProgress: null,
        deviceLibraries: library
          ? { ...state.deviceLibraries, [id]: library }
          : state.deviceLibraries,
        rockboxThemeLibraries: library
          ? { ...state.rockboxThemeLibraries, [id]: rockboxThemesFromLibrary(library) }
          : state.rockboxThemeLibraries,
      }))
    } catch (err) {
      set({ loading: false, error: (err as Error).message, scanProgress: null })
    }
  },

  async planSync(mode, pcTargetPath) {
    const deviceId = currentDeviceId(get())
    set({ loading: true, error: null, plan: null })
    try {
      const plan = await window.api.devices.planSync({ deviceId, mode, pcTargetPath })
      set({ plan, loading: false })
      return plan
    } catch (err) {
      set({ loading: false, error: (err as Error).message })
      throw err
    }
  },

  async applyPlan(planId) {
    set({ loading: true, error: null })
    try {
      const result = await window.api.devices.applySync(planId)
      const [devices, pendingJournals] = await Promise.all([
        window.api.devices.list(),
        window.api.devices.listPendingJournals(),
      ])
      set({
        devices,
        pendingJournals,
        plan: null,
        loading: false,
        syncProgress: null,
      })
      return result
    } catch (err) {
      set({ loading: false, error: (err as Error).message, syncProgress: null })
      throw err
    }
  },

  async resumeJournal(journalId) {
    set({ loading: true, error: null })
    try {
      const result = await window.api.devices.resumeJournal(journalId)
      const [devices, pendingJournals] = await Promise.all([
        window.api.devices.list(),
        window.api.devices.listPendingJournals(),
      ])
      set({
        devices,
        pendingJournals,
        loading: false,
        syncProgress: null,
      })
      return result
    } catch (err) {
      set({ loading: false, error: (err as Error).message, syncProgress: null })
      throw err
    }
  },

  async discardJournal(journalId) {
    set({ loading: true, error: null })
    try {
      await window.api.devices.discardJournal(journalId)
      const pendingJournals = await window.api.devices.listPendingJournals()
      set({ pendingJournals, loading: false })
    } catch (err) {
      set({ loading: false, error: (err as Error).message })
      throw err
    }
  },

  clearPlan() {
    set({ plan: null })
  },
}))

let deviceListenerCleanups: Array<() => void> | null = null

function initializeDeviceListeners(): void {
  if (typeof window === 'undefined' || !window.api?.devices) return
  if (deviceListenerCleanups) {
    for (const off of deviceListenerCleanups) off()
    deviceListenerCleanups = null
  }
  const offScan = window.api.devices.onScanProgress(event => {
    useDeviceStore.setState({ scanProgress: event })
  })
  const offSync = window.api.devices.onSyncProgress(event => {
    useDeviceStore.setState({ syncProgress: event })
  })
  const offVolumes = window.api.devices.onVolumesChanged((snapshot: DeviceVolumeSnapshot) => {
    useDeviceStore.setState(state => ({
      devices: snapshot.devices,
      candidates: snapshot.candidates,
      unknownVolumes: snapshot.unknownVolumes,
      selectedDeviceId: nextSelectedDeviceId(state.selectedDeviceId, snapshot.devices),
    }))
  })
  deviceListenerCleanups = [offScan, offSync, offVolumes]
}

initializeDeviceListeners()

if (typeof import.meta !== 'undefined' && (import.meta as { hot?: { dispose: (cb: () => void) => void } }).hot) {
  (import.meta as { hot: { dispose: (cb: () => void) => void } }).hot.dispose(() => {
    if (deviceListenerCleanups) {
      for (const off of deviceListenerCleanups) off()
      deviceListenerCleanups = null
    }
  })
}

export function useSelectedDevice(): DeviceRecord | null {
  return useDeviceStore(state =>
    state.devices.find(device => device.id === state.selectedDeviceId) ?? null,
  )
}

export function useDeviceLibrary(deviceId: string | null): DeviceLibraryResult | null {
  return useDeviceStore(state =>
    deviceId ? state.deviceLibraries[deviceId] ?? null : null,
  )
}

export function useRockboxThemeLibrary(deviceId: string | null): RockboxThemeLibraryResult | null {
  return useDeviceStore(state =>
    deviceId ? state.rockboxThemeLibraries[deviceId] ?? null : null,
  )
}
