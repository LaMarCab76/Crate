import { useCallback, useEffect, useMemo } from 'react'
import { Icon } from '@renderer/components/Icon'
import {
  useDeviceOverview,
  useDeviceStore,
  useSelectedDevice,
} from '@renderer/stores/deviceStore'
import { fmtFileSize } from '@renderer/utils/format'
import {
  isUsableDeviceCapacity,
  selectDeviceDashboardCapacity,
} from '@renderer/utils/deviceOverview'
import type {
  DeviceCapacitySummary,
  DevicePendingJournal,
} from '@shared/types/device-sync'

const SYNC_PHASE_LABELS: Record<string, string> = {
  discovering: 'Buscando',
  reading: 'Leyendo',
  copying: 'Copiando',
  deleting: 'Eliminando',
  refreshing: 'Actualizando',
  optimizing_artwork: 'Optimizando artwork',
  writing_state: 'Guardando estado',
  complete: 'Completado',
}

export type DeviceDashboardTab = 'overview' | 'activity'

type DevicesViewProps = {
  deviceId?: string
  dashboardTab?: DeviceDashboardTab
}

function shortDate(value: string | null): string {
  if (!value) return 'never'
  try {
    return new Date(value).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return value
  }
}

function formatDate(value: string | null): string {
  if (!value) return 'No registrado'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function progressText(completed: number, total: number): string {
  if (total <= 0) return 'Trabajando'
  return `${completed}/${total}`
}

function formatStorageSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  return fmtFileSize(bytes)
}

function CapacityBar({ capacity }: { capacity: DeviceCapacitySummary | null }) {
  if (capacity == null) {
    return (
      <div className="device-capacity unavailable">
        <div className="device-capacity-line">
          <strong>Espacio no disponible</strong>
          <span>Montá el dispositivo para leer capacidad real.</span>
        </div>
        <div className="device-capacity-track" aria-hidden="true" />
      </div>
    )
  }

  if (capacity.error || capacity.totalBytes <= 0) {
    return (
      <div className="device-capacity unavailable">
        <div className="device-capacity-line">
          <strong>Espacio no disponible</strong>
          <span>{capacity.error || 'Montá el dispositivo para leer capacidad real.'}</span>
        </div>
        <div className="device-capacity-track" aria-hidden="true" />
      </div>
    )
  }

  const usedPct = Math.max(0, Math.min(100, (capacity.usedBytes / capacity.totalBytes) * 100))
  return (
    <div className="device-capacity">
      <div className="device-capacity-line">
        <strong>{formatStorageSize(capacity.freeBytes)} <span>libres</span></strong>
        <span>{formatStorageSize(capacity.usedBytes)} de {formatStorageSize(capacity.totalBytes)} usados</span>
      </div>
      <div className="device-capacity-track" aria-label="Device storage usage">
        <i style={{ width: `${usedPct}%` }} />
      </div>
    </div>
  )
}

function PendingJournalList({
  journals,
  loading,
  onResume,
  onDiscard,
}: {
  journals: DevicePendingJournal[]
  loading: boolean
  onResume: (journalId: string) => void
  onDiscard: (journalId: string) => void
}) {
  if (journals.length === 0) return null
  return (
    <div className="device-journal-list">
      {journals.map(journal => (
        <div className="device-journal-row" key={journal.id}>
          <div>
            <strong>{journal.status === 'failed' ? 'Sync fallida' : 'Sync interrumpida'}</strong>
            <span>{journal.completedActions}/{journal.totalActions} operaciones · {formatDate(journal.updatedAt)}</span>
          </div>
          <div className="device-journal-actions">
            <button className="btn" type="button" disabled={loading} onClick={() => onResume(journal.id)}>
              Continue
            </button>
            <button className="btn ghost" type="button" disabled={loading} onClick={() => onDiscard(journal.id)}>
              Discard
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

export function DevicesView({ deviceId, dashboardTab }: DevicesViewProps = {}) {
  const devices = useDeviceStore(s => s.devices)
  const pendingJournals = useDeviceStore(s => s.pendingJournals)
  const scanResult = useDeviceStore(s => s.scanResult)
  const scanProgress = useDeviceStore(s => s.scanProgress)
  const syncProgress = useDeviceStore(s => s.syncProgress)
  const loading = useDeviceStore(s => s.loading)
  const error = useDeviceStore(s => s.error)
  const load = useDeviceStore(s => s.load)
  const refreshVolumes = useDeviceStore(s => s.refreshVolumes)
  const loadDeviceOverview = useDeviceStore(s => s.loadDeviceOverview)
  const scan = useDeviceStore(s => s.scan)
  const resumeJournal = useDeviceStore(s => s.resumeJournal)
  const discardJournal = useDeviceStore(s => s.discardJournal)
  const selectDevice = useDeviceStore(s => s.selectDevice)
  const selectedDevice = useSelectedDevice()
  const overview = useDeviceOverview(selectedDevice?.id ?? null)
  const tab = dashboardTab ?? 'overview'

  useEffect(() => {
    void load()
    void refreshVolumes()
  }, [load, refreshVolumes])

  useEffect(() => {
    if (deviceId) selectDevice(deviceId)
  }, [deviceId, selectDevice])

  useEffect(() => {
    if (!selectedDevice) return
    void loadDeviceOverview(selectedDevice.id).catch(() => undefined)
  }, [selectedDevice?.id, loadDeviceOverview])

  const selectedDeviceId = selectedDevice?.id
  const capacity = selectDeviceDashboardCapacity({
    deviceId: selectedDeviceId,
    overview,
    scanResult,
  })
  const activeProgress = useMemo(() => {
    if (selectedDeviceId && syncProgress?.deviceId === selectedDeviceId) return syncProgress
    if (selectedDeviceId && scanProgress?.deviceId === selectedDeviceId) return scanProgress
    return null
  }, [selectedDeviceId, syncProgress, scanProgress])
  const progressCompleted = activeProgress
    ? activeProgress === syncProgress
      ? syncProgress!.completed
      : activeProgress === scanProgress
        ? scanProgress!.scanned
        : 0
    : 0
  const progressTotal = activeProgress?.total ?? 0
  const progressPct = progressTotal > 0 ? Math.min(100, Math.round((progressCompleted / progressTotal) * 100)) : 0
  const devicePendingJournals = useMemo(
    () => selectedDevice ? pendingJournals.filter(journal => journal.deviceId === selectedDevice.id) : [],
    [pendingJournals, selectedDevice?.id],
  )

  const rescan = useCallback(async () => {
    if (!selectedDevice) return
    await scan(selectedDevice.id)
    await loadDeviceOverview(selectedDevice.id, true).catch(() => undefined)
  }, [loadDeviceOverview, scan, selectedDevice])

  const resumePendingJournal = useCallback(async (journalId: string) => {
    const result = await resumeJournal(journalId)
    if (!devices.some(device => device.id === result.deviceId)) return
    await scan(result.deviceId)
    await loadDeviceOverview(result.deviceId, true).catch(() => undefined)
  }, [devices, loadDeviceOverview, resumeJournal, scan])

  if (!selectedDevice) {
    return (
      <div className="devices-page">
        <div className="lib-head">
          <div>
            <h1>Devices</h1>
            <div className="sub">Seleccioná un dispositivo desde el sidebar o agregalo desde Ajustes.</div>
          </div>
        </div>
        <div className="device-empty large">No hay un dispositivo seleccionado.</div>
      </div>
    )
  }

  return (
    <div className="devices-page device-dashboard-page compact">
      <div className="device-dashboard-nav">
        <div className="device-breadcrumb">
          <span>Devices</span>
          <Icon name="chevR" size={12} />
          <strong>{selectedDevice.name}</strong>
        </div>
      </div>

      {error && <div className="device-error">{error}</div>}

      {tab === 'overview' ? (
        <section className="device-summary-panel">
          <div className="device-summary-main">
            <div className="device-kicker">
              <span>{selectedDevice.hasRockbox ? 'ROCKBOX' : 'DEVICE'}</span>
              <span className={`device-connect-dot ${selectedDevice.isAvailable ? 'online' : ''}`}>
                {selectedDevice.isAvailable ? 'Connected' : 'Offline'}
              </span>
            </div>
            <h1>{selectedDevice.name}</h1>
            <p title={selectedDevice.rootPath}>{selectedDevice.rootPath}</p>
            <div className="device-summary-facts">
              <span>
                <em>Canciones</em>
                <strong>{selectedDevice.trackCount.toLocaleString()}</strong>
              </span>
              <span>
                <em>Espacio libre</em>
                <strong>{capacity && isUsableDeviceCapacity(capacity) ? formatStorageSize(capacity.freeBytes) : 'No disponible'}</strong>
              </span>
              <span>
                <em>Último scan</em>
                <strong>{shortDate(selectedDevice.lastScanAt)}</strong>
              </span>
            </div>
            <CapacityBar capacity={capacity} />
          </div>
          <div className="device-summary-actions">
            {activeProgress && (
              <div className="device-summary-progress">
                <span>{SYNC_PHASE_LABELS[activeProgress.phase] ?? activeProgress.phase} · {progressText(progressCompleted, progressTotal)}</span>
                <div className="device-progress-track" aria-hidden="true">
                  <b style={{ width: `${progressPct}%` }} />
                </div>
              </div>
            )}
            <button className="btn primary" type="button" disabled={loading || !selectedDevice.isAvailable} onClick={() => void rescan()}>
              <Icon name="rotate" size={13} /> Re-scan
            </button>
          </div>
        </section>
      ) : (
        <section className="device-side-card device-activity-card device-activity-tab">
          <div className="device-card-head">
            <div>
              <h2>Activity</h2>
              <span>Device state and recent sync signals.</span>
            </div>
          </div>
          <div className="device-activity-list">
            {activeProgress ? (
              <div className="device-activity-row active">
                <i />
                <div>
                  <span>Now</span>
                  <strong>{SYNC_PHASE_LABELS[activeProgress.phase] ?? activeProgress.phase} · {progressText(progressCompleted, progressTotal)}</strong>
                  <div className="device-progress-track" aria-hidden="true">
                    <b style={{ width: `${progressPct}%` }} />
                  </div>
                </div>
              </div>
            ) : (
              <div className={`device-activity-row ${selectedDevice.isAvailable ? 'done' : ''}`}>
                <i />
                <div>
                  <span>Now</span>
                  <strong>{selectedDevice.isAvailable ? `Mounted ${selectedDevice.rootPath}` : 'Device offline'}</strong>
                </div>
              </div>
            )}
            <div className="device-activity-row done">
              <i />
              <div>
                <span>{shortDate(selectedDevice.lastScanAt)}</span>
                <strong>Scan complete · {selectedDevice.trackCount.toLocaleString()} tracks indexed</strong>
              </div>
            </div>
            <div className="device-activity-row">
              <i />
              <div>
                <span>{shortDate(selectedDevice.lastSyncAt)}</span>
                <strong>Last sync recorded</strong>
              </div>
            </div>
          </div>
          <PendingJournalList
            journals={devicePendingJournals}
            loading={loading}
            onResume={journalId => void resumePendingJournal(journalId)}
            onDiscard={journalId => void discardJournal(journalId)}
          />
        </section>
      )}
    </div>
  )
}
