import { create } from 'zustand'
import type { ActivityStatus } from './activityCenterStore'
import type {
  DeviceArtworkAnalysisProgressEvent,
  DeviceArtworkAnalysisResult,
  DeviceArtworkOptimizationSelection,
  DeviceArtworkOptimizationSummary,
  DeviceCandidate,
  DeviceConnectPayload,
  DeviceLibraryResult,
  DevicePendingJournal,
  DeviceOverviewResult,
  DeviceRecord,
  DeviceScanProgressEvent,
  DeviceScanResult,
  DeviceSettingsUpdate,
  DeviceSyncApplySelection,
  DeviceSyncApplyResult,
  DeviceSyncMode,
  DeviceSyncPlan,
  DeviceSyncProgressEvent,
  DeviceUnknownVolume,
  DeviceVolumeSnapshot,
  RockboxThemeDeleteResult,
  RockboxThemeInstallResult,
  RockboxThemeLibraryResult,
} from '@shared/types/device-sync'

interface DeviceState {
  devices: DeviceRecord[]
  candidates: DeviceCandidate[]
  unknownVolumes: DeviceUnknownVolume[]
  pendingJournals: DevicePendingJournal[]
  deviceLibraries: Record<string, DeviceLibraryResult>
  deviceOverviews: Record<string, DeviceOverviewResult>
  rockboxThemeLibraries: Record<string, RockboxThemeLibraryResult>
  artworkAnalysis: Record<string, DeviceArtworkAnalysisResult>
  scanResult: DeviceScanResult | null
  plan: DeviceSyncPlan | null
  scanProgress: DeviceScanProgressEvent | null
  syncProgress: DeviceSyncProgressEvent | null
  artworkAnalyzeProgress: DeviceArtworkAnalysisProgressEvent | null
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
  loadDeviceOverview(deviceId: string, force?: boolean): Promise<DeviceOverviewResult>
  loadDeviceLibrary(deviceId: string, force?: boolean): Promise<DeviceLibraryResult>
  loadRockboxThemes(deviceId: string, force?: boolean): Promise<RockboxThemeLibraryResult>
  installRockboxThemes(deviceId: string, files: unknown[]): Promise<RockboxThemeInstallResult>
  deleteRockboxTheme(deviceId: string, themeId: string): Promise<RockboxThemeDeleteResult>
  selectDevice(id: string): void
  scan(deviceId?: string): Promise<void>
  analyzeArtwork(deviceId?: string): Promise<DeviceArtworkAnalysisResult>
  planSync(mode: DeviceSyncMode, pcTargetPath?: string): Promise<DeviceSyncPlan>
  applyPlan(planId: string, selection?: DeviceSyncApplySelection): Promise<DeviceSyncApplyResult>
  optimizeArtwork(
    deviceId?: string,
    selection?: DeviceArtworkOptimizationSelection,
  ): Promise<DeviceArtworkOptimizationSummary>
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

function overviewFromStorage(
  device: DeviceRecord,
  storage: DeviceScanResult['storage'],
): DeviceOverviewResult {
  return {
    device,
    capacity: {
      totalBytes: storage.totalBytes,
      usedBytes: storage.usedBytes,
      freeBytes: storage.freeBytes,
      scannedAt: storage.scannedAt,
      error: storage.error,
    },
  }
}

function overviewFromScan(scanResult: DeviceScanResult): DeviceOverviewResult {
  return overviewFromStorage(scanResult.device, scanResult.storage)
}

function activeArtworkOptimizationPlan(progress: DeviceSyncProgressEvent | null, deviceId: string): string | null {
  return progress?.deviceId === deviceId && progress.phase === 'optimizing_artwork'
    ? progress.planId
    : null
}

function artworkOptimizationActivityDetail(summary: DeviceArtworkOptimizationSummary): string {
  if (summary.failed > 0) {
    return `${summary.failed} carátulas fallaron. Se optimizaron ${summary.optimized}.`
  }
  if (summary.optimized === 0) return 'No se optimizaron carátulas.'
  return `Se optimizaron ${summary.optimized} carátulas.`
}

async function resolveArtworkOptimizationActivity(
  deviceId: string,
  planId: string | null,
  status: ActivityStatus,
  detail: string,
): Promise<void> {
  const { useActivityCenterStore } = await import('./activityCenterStore')
  useActivityCenterStore.getState().resolveDeviceArtworkOptimization(deviceId, planId, status, detail)
}

export function mergeDeviceRecord(devices: DeviceRecord[], next: DeviceRecord): DeviceRecord[] {
  let found = false
  const merged = devices.map(device => {
    if (device.id !== next.id) return device
    found = true
    return next
  })
  return found ? merged : [next, ...merged]
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
  deviceOverviews: {},
  rockboxThemeLibraries: {},
  artworkAnalysis: {},
  scanResult: null,
  plan: null,
  scanProgress: null,
  syncProgress: null,
  artworkAnalyzeProgress: null,
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
        deviceOverviews: library
          ? { ...state.deviceOverviews, [device.id]: overviewFromStorage(library.device, library.storage) }
          : state.deviceOverviews,
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
        deviceOverviews: state.deviceOverviews[device.id]
          ? { ...state.deviceOverviews, [device.id]: { ...state.deviceOverviews[device.id], device } }
          : state.deviceOverviews,
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

  async loadDeviceOverview(deviceId, force = false) {
    const cached = get().deviceOverviews[deviceId]
    if (cached && !force) return cached
    set({ loading: true, error: null })
    try {
      const overview = await window.api.devices.overview(deviceId)
      set(state => ({
        devices: mergeDeviceRecord(state.devices, overview.device),
        deviceOverviews: { ...state.deviceOverviews, [deviceId]: overview },
        selectedDeviceId: deviceId,
        loading: false,
      }))
      return overview
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
        devices: mergeDeviceRecord(state.devices, library.device),
        deviceLibraries: { ...state.deviceLibraries, [deviceId]: library },
        deviceOverviews: {
          ...state.deviceOverviews,
          [deviceId]: overviewFromStorage(library.device, library.storage),
        },
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
        devices: mergeDeviceRecord(state.devices, themes.device),
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

  async deleteRockboxTheme(deviceId, themeId) {
    set({ loading: true, error: null, themeInstallResult: null })
    try {
      const result = await window.api.devices.deleteRockboxTheme(deviceId, themeId)
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
        devices: library
          ? mergeDeviceRecord(mergeDeviceRecord(devices, scanResult.device), library.device)
          : mergeDeviceRecord(devices, scanResult.device),
        scanResult,
        selectedDeviceId: id,
        loading: false,
        scanProgress: null,
        deviceOverviews: { ...state.deviceOverviews, [id]: overviewFromScan(scanResult) },
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

  async analyzeArtwork(deviceId) {
    const id = currentDeviceId(get(), deviceId)
    set({ loading: true, error: null, artworkAnalyzeProgress: null })
    try {
      const result = await window.api.devices.analyzeArtwork(id)
      set(state => ({
        artworkAnalysis: { ...state.artworkAnalysis, [id]: result },
        selectedDeviceId: id,
        loading: false,
        artworkAnalyzeProgress: null,
      }))
      return result
    } catch (err) {
      set({ loading: false, error: (err as Error).message, artworkAnalyzeProgress: null })
      throw err
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

  async applyPlan(planId, selection) {
    set({ loading: true, error: null })
    try {
      const result = await window.api.devices.applySync(planId, selection)
      const [devices, pendingJournals, library] = await Promise.all([
        window.api.devices.list(),
        window.api.devices.listPendingJournals(),
        window.api.devices.library(result.deviceId).catch(() => null),
      ])
      set(state => ({
        devices: library ? mergeDeviceRecord(devices, library.device) : devices,
        pendingJournals,
        deviceLibraries: library
          ? { ...state.deviceLibraries, [result.deviceId]: library }
          : state.deviceLibraries,
        deviceOverviews: library
          ? { ...state.deviceOverviews, [result.deviceId]: overviewFromStorage(library.device, library.storage) }
          : state.deviceOverviews,
        rockboxThemeLibraries: library
          ? { ...state.rockboxThemeLibraries, [result.deviceId]: rockboxThemesFromLibrary(library) }
          : state.rockboxThemeLibraries,
        plan: null,
        loading: false,
        syncProgress: null,
      }))
      return result
    } catch (err) {
      set({ loading: false, error: (err as Error).message, syncProgress: null })
      throw err
    }
  },

  async optimizeArtwork(deviceId, selection) {
    const id = currentDeviceId(get(), deviceId)
    set({ loading: true, error: null })
    try {
      const result = await window.api.devices.optimizeArtwork(id, selection)
      const artworkPlanId = activeArtworkOptimizationPlan(get().syncProgress, id)
      const [devices, library] = await Promise.all([
        window.api.devices.list(),
        window.api.devices.library(id).catch(() => null),
      ])
      await resolveArtworkOptimizationActivity(
        id,
        artworkPlanId,
        result.failed > 0 ? 'warning' : 'success',
        artworkOptimizationActivityDetail(result),
      )
      set(state => ({
        devices: library ? mergeDeviceRecord(devices, library.device) : devices,
        deviceLibraries: library
          ? { ...state.deviceLibraries, [id]: library }
          : state.deviceLibraries,
        deviceOverviews: library
          ? { ...state.deviceOverviews, [id]: overviewFromStorage(library.device, library.storage) }
          : state.deviceOverviews,
        rockboxThemeLibraries: library
          ? { ...state.rockboxThemeLibraries, [id]: rockboxThemesFromLibrary(library) }
          : state.rockboxThemeLibraries,
        selectedDeviceId: id,
        loading: false,
        syncProgress: null,
      }))
      return result
    } catch (err) {
      const artworkPlanId = activeArtworkOptimizationPlan(get().syncProgress, id)
      await resolveArtworkOptimizationActivity(id, artworkPlanId, 'error', (err as Error).message)
      set({ loading: false, error: (err as Error).message, syncProgress: null })
      throw err
    }
  },

  async resumeJournal(journalId) {
    set({ loading: true, error: null })
    try {
      const result = await window.api.devices.resumeJournal(journalId)
      const [devices, pendingJournals, library] = await Promise.all([
        window.api.devices.list(),
        window.api.devices.listPendingJournals(),
        window.api.devices.library(result.deviceId).catch(() => null),
      ])
      set(state => ({
        devices: library ? mergeDeviceRecord(devices, library.device) : devices,
        pendingJournals,
        deviceLibraries: library
          ? { ...state.deviceLibraries, [result.deviceId]: library }
          : state.deviceLibraries,
        deviceOverviews: library
          ? { ...state.deviceOverviews, [result.deviceId]: overviewFromStorage(library.device, library.storage) }
          : state.deviceOverviews,
        rockboxThemeLibraries: library
          ? { ...state.rockboxThemeLibraries, [result.deviceId]: rockboxThemesFromLibrary(library) }
          : state.rockboxThemeLibraries,
        loading: false,
        syncProgress: null,
      }))
      return result
    } catch (err) {
      set({ loading: false, error: (err as Error).message, syncProgress: null })
      throw err
    }
  },

  async discardJournal(journalId) {
    set({ loading: true, error: null })
    try {
      const discardedJournal = get().pendingJournals.find(journal => journal.id === journalId) ?? null
      await window.api.devices.discardJournal(journalId)
      const pendingJournals = await window.api.devices.listPendingJournals()
      set(state => ({
        pendingJournals,
        loading: false,
        syncProgress: discardedJournal && state.syncProgress?.planId === discardedJournal.planId
          ? null
          : state.syncProgress,
      }))
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
  const offArtwork = window.api.devices.onArtworkAnalyzeProgress(event => {
    useDeviceStore.setState({ artworkAnalyzeProgress: event })
  })
  const offVolumes = window.api.devices.onVolumesChanged((snapshot: DeviceVolumeSnapshot) => {
    useDeviceStore.setState(state => ({
      devices: snapshot.devices,
      candidates: snapshot.candidates,
      unknownVolumes: snapshot.unknownVolumes,
      selectedDeviceId: nextSelectedDeviceId(state.selectedDeviceId, snapshot.devices),
    }))
  })
  deviceListenerCleanups = [offScan, offSync, offArtwork, offVolumes]
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

export function useDeviceArtworkAnalysis(deviceId: string | null): DeviceArtworkAnalysisResult | null {
  return useDeviceStore(state =>
    deviceId ? state.artworkAnalysis[deviceId] ?? null : null,
  )
}

export function useDeviceOverview(deviceId: string | null): DeviceOverviewResult | null {
  return useDeviceStore(state =>
    deviceId ? state.deviceOverviews[deviceId] ?? null : null,
  )
}

export function useRockboxThemeLibrary(deviceId: string | null): RockboxThemeLibraryResult | null {
  return useDeviceStore(state =>
    deviceId ? state.rockboxThemeLibraries[deviceId] ?? null : null,
  )
}
