import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@renderer/components/Icon'
import { ModalShell } from '@renderer/components/ModalShell'
import {
  useDeviceLibrary,
  useDeviceStore,
  useSelectedDevice,
} from '@renderer/stores/deviceStore'
import { useFolders } from '@renderer/stores/libraryStore'
import { DEVICE_ARTWORK_EDGE_MAX, DEVICE_ARTWORK_EDGE_MIN } from '@shared/constants/device-sync'
import { fmtFileSize, fmtTime } from '@renderer/utils/format'
import type {
  DevicePendingJournal,
  DeviceSyncAction,
  DeviceSyncActionKind,
  DeviceSyncApplyResult,
  DeviceSyncMode,
  DeviceSyncPlan,
  DeviceTrack,
} from '@shared/types/device-sync'

const MODES: Array<{ mode: DeviceSyncMode; label: string }> = [
  { mode: 'pc_to_device', label: 'PC -> Device' },
  { mode: 'device_to_pc', label: 'Device -> PC' },
  { mode: 'bidirectional_safe', label: 'Both' },
]

const ACTION_LABELS: Record<DeviceSyncActionKind, string> = {
  copy_pc_to_device: 'Copy to device',
  copy_device_to_pc: 'Copy to PC',
  replace_device: 'Replace on device',
  replace_pc: 'Replace on PC',
  delete_device: 'Remove from device',
  delete_pc: 'Remove from PC',
  skip_conflict: 'Conflict',
}

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

function sameNumberSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every(value => set.has(value))
}

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="device-stat-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="device-info-row">
      <span>{label}</span>
      <strong title={String(value)}>{value}</strong>
    </div>
  )
}

function TrackRows({ tracks }: { tracks: DeviceTrack[] }) {
  if (tracks.length === 0) {
    return <div className="device-empty">No hay temas escaneados todavía.</div>
  }

  return (
    <div className="device-track-table">
      {tracks.slice(0, 250).map(track => (
        <div className="device-track-row" key={track.key}>
          <span className="device-track-title">{track.title}</span>
          <span>{track.artist || 'Unknown Artist'}</span>
          <span>{track.album || 'Unknown Album'}</span>
          <span className="mono">{fmtTime(track.duration)}</span>
          <span className="mono">{fmtFileSize(track.fileSize)}</span>
        </div>
      ))}
      {tracks.length > 250 && (
        <div className="device-empty compact">{tracks.length - 250} temas más ocultos</div>
      )}
    </div>
  )
}

function groupedActions(plan: DeviceSyncPlan): Array<[DeviceSyncActionKind, DeviceSyncAction[]]> {
  const order: DeviceSyncActionKind[] = [
    'copy_pc_to_device',
    'copy_device_to_pc',
    'replace_device',
    'replace_pc',
    'delete_device',
    'delete_pc',
    'skip_conflict',
  ]
  return order
    .map(kind => [kind, plan.actions.filter(action => action.kind === kind)] as [DeviceSyncActionKind, DeviceSyncAction[]])
    .filter(([, actions]) => actions.length > 0)
}

function PlanPreviewModal({
  plan,
  applying,
  result,
  applyBlockedReason,
  onClose,
  onApply,
}: {
  plan: DeviceSyncPlan
  applying: boolean
  result: DeviceSyncApplyResult | null
  applyBlockedReason: string | null
  onClose: () => void
  onApply: () => void
}) {
  const executable = plan.actions.filter(action => action.kind !== 'skip_conflict').length
  return (
    <ModalShell
      title="Sync Preview"
      onClose={onClose}
      footer={(
        <>
          <button className="btn ghost" type="button" onClick={onClose}>
            Close
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={applying || executable === 0 || result != null || applyBlockedReason != null}
            onClick={onApply}
          >
            <Icon name="sync" size={13} />
            Apply Sync
          </button>
        </>
      )}
    >
      <div className="sync-summary-grid">
        <div><span>PC</span><strong>{plan.summary.pcBefore} {'->'} {plan.summary.pcAfter}</strong></div>
        <div><span>Device</span><strong>{plan.summary.deviceBefore} {'->'} {plan.summary.deviceAfter}</strong></div>
        <div><span>Copy</span><strong>{fmtFileSize(plan.summary.bytesToCopy)}</strong></div>
        <div><span>Conflicts</span><strong>{plan.summary.conflicts}</strong></div>
      </div>

      {applyBlockedReason && (
        <div className="device-warning inline">
          {applyBlockedReason}
        </div>
      )}

      {groupedActions(plan).length === 0 ? (
        <div className="device-empty">No changes to apply.</div>
      ) : (
        groupedActions(plan).map(([kind, actions]) => (
          <div className="sync-action-group" key={kind}>
            <h3>{ACTION_LABELS[kind]} <span>{actions.length}</span></h3>
            <div className="sync-action-list">
              {actions.slice(0, 80).map(action => (
                <div className="sync-action-row" key={action.id}>
                  <span>{action.title}</span>
                  <em>{action.relativePath}</em>
                  <strong>{action.reason}</strong>
                </div>
              ))}
              {actions.length > 80 && (
                <div className="device-empty compact">{actions.length - 80} more changes hidden</div>
              )}
            </div>
          </div>
        ))
      )}

      {result && (
        <div className={result.failed.length > 0 ? 'modal-error' : 'sync-result-ok'}>
          {result.failed.length > 0
            ? `${result.failed.length} operations failed. ${result.failed[0]?.error ?? ''}`
            : `Applied ${result.applied} operations. Optimized ${result.artwork.optimized} artwork files and saved ${fmtFileSize(result.artwork.bytesSaved)}.`}
        </div>
      )}
    </ModalShell>
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

export function DevicesView({ deviceId }: { deviceId?: string } = {}) {
  const devices = useDeviceStore(s => s.devices)
  const pendingJournals = useDeviceStore(s => s.pendingJournals)
  const plan = useDeviceStore(s => s.plan)
  const scanProgress = useDeviceStore(s => s.scanProgress)
  const syncProgress = useDeviceStore(s => s.syncProgress)
  const loading = useDeviceStore(s => s.loading)
  const error = useDeviceStore(s => s.error)
  const load = useDeviceStore(s => s.load)
  const refreshVolumes = useDeviceStore(s => s.refreshVolumes)
  const loadDeviceLibrary = useDeviceStore(s => s.loadDeviceLibrary)
  const scan = useDeviceStore(s => s.scan)
  const planSync = useDeviceStore(s => s.planSync)
  const applyPlan = useDeviceStore(s => s.applyPlan)
  const resumeJournal = useDeviceStore(s => s.resumeJournal)
  const discardJournal = useDeviceStore(s => s.discardJournal)
  const updateSettings = useDeviceStore(s => s.updateSettings)
  const clearPlan = useDeviceStore(s => s.clearPlan)
  const selectedDevice = useSelectedDevice()
  const selectDevice = useDeviceStore(s => s.selectDevice)
  const folders = useFolders()

  const [mode, setMode] = useState<DeviceSyncMode>('bidirectional_safe')
  const [pcTargetPath, setPcTargetPath] = useState('')
  const [artworkMaxEdge, setArtworkMaxEdge] = useState('')
  const [sourceLibraryIds, setSourceLibraryIds] = useState<number[]>([])
  const [applyResult, setApplyResult] = useState<DeviceSyncApplyResult | null>(null)

  useEffect(() => {
    void load()
    void refreshVolumes()
  }, [load, refreshVolumes])

  useEffect(() => {
    if (deviceId) selectDevice(deviceId)
  }, [deviceId, selectDevice])

  const library = useDeviceLibrary(selectedDevice?.id ?? null)

  useEffect(() => {
    if (!selectedDevice) return
    void loadDeviceLibrary(selectedDevice.id).catch(() => undefined)
  }, [selectedDevice?.id, loadDeviceLibrary])

  useEffect(() => {
    if (!selectedDevice) return
    setMode(selectedDevice.defaultMode)
    setPcTargetPath(selectedDevice.pcTargetPath)
    setArtworkMaxEdge(String(selectedDevice.artworkMaxEdge))
    setSourceLibraryIds(
      selectedDevice.sourceLibraryIds.length > 0
        ? selectedDevice.sourceLibraryIds
        : folders.map(folder => folder.id),
    )
  }, [selectedDevice?.id, selectedDevice?.artworkMaxEdge, folders])

  const devicePendingJournals = useMemo(
    () => selectedDevice ? pendingJournals.filter(journal => journal.deviceId === selectedDevice.id) : [],
    [pendingJournals, selectedDevice?.id],
  )

  const stats = library?.summary ?? {
    trackCount: selectedDevice?.trackCount ?? 0,
    albumCount: 0,
    artistCount: 0,
    playlistCount: 0,
    rockboxThemeCount: 0,
  }
  const tracks = library?.tracks ?? []
  const activeProgress = selectedDevice && syncProgress?.deviceId === selectedDevice.id
    ? syncProgress
    : selectedDevice && scanProgress?.deviceId === selectedDevice.id
      ? scanProgress
      : null
  const progressCompleted = syncProgress && activeProgress === syncProgress
    ? syncProgress.completed
    : scanProgress && activeProgress === scanProgress
      ? scanProgress.scanned
      : 0
  const progressTotal = activeProgress?.total ?? 0
  const progressPct = progressTotal > 0 ? Math.min(100, Math.round((progressCompleted / progressTotal) * 100)) : 0

  const artworkMaxEdgeValue = Number(artworkMaxEdge)
  const artworkMaxEdgeValid =
    Number.isInteger(artworkMaxEdgeValue) &&
    artworkMaxEdgeValue >= DEVICE_ARTWORK_EDGE_MIN &&
    artworkMaxEdgeValue <= DEVICE_ARTWORK_EDGE_MAX

  const originalLibraryIds = selectedDevice
    ? selectedDevice.sourceLibraryIds.length > 0
      ? selectedDevice.sourceLibraryIds
      : folders.map(folder => folder.id)
    : []
  const settingsChanged = !!selectedDevice && (
    mode !== selectedDevice.defaultMode ||
    pcTargetPath.trim() !== selectedDevice.pcTargetPath ||
    artworkMaxEdgeValue !== selectedDevice.artworkMaxEdge ||
    !sameNumberSet(sourceLibraryIds, originalLibraryIds)
  )

  const selectedLibraryLabel = sourceLibraryIds.length === folders.length
    ? 'Todas las bibliotecas'
    : folders
      .filter(folder => sourceLibraryIds.includes(folder.id))
      .map(folder => folder.name)
      .join(', ') || 'Sin bibliotecas'
  const portableState = selectedDevice?.portableState
  const portableWarning = portableState?.writable === false
    ? portableState.error ?? 'La configuración local se guardó, pero .crate no se pudo actualizar en el dispositivo.'
    : null
  const applyBlockedReason = portableState?.writable === false
    ? 'No se puede aplicar la sincronización hasta que .crate sea escribible en el dispositivo.'
    : null

  const toggleLibrary = (folderId: number) => {
    setSourceLibraryIds(current =>
      current.includes(folderId)
        ? current.filter(id => id !== folderId)
        : [...current, folderId],
    )
  }

  const saveSettings = async () => {
    if (!selectedDevice || !artworkMaxEdgeValid) return null
    return updateSettings(selectedDevice.id, {
      defaultMode: mode,
      pcTargetPath: pcTargetPath.trim() || selectedDevice.pcTargetPath,
      artworkMaxEdge: artworkMaxEdgeValue,
      sourceLibraryIds,
    })
  }

  const buildPlan = async () => {
    if (!selectedDevice) return
    setApplyResult(null)
    if (settingsChanged) await saveSettings()
    await planSync(mode, pcTargetPath.trim() || selectedDevice.pcTargetPath)
  }

  const applyCurrentPlan = async () => {
    if (!plan || applyBlockedReason) return
    const result = await applyPlan(plan.id)
    setApplyResult(result)
    await scan(plan.deviceId)
  }

  const resumePendingJournal = async (journalId: string) => {
    const result = await resumeJournal(journalId)
    await scan(result.deviceId)
  }

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
    <div className="devices-page device-dashboard-page">
      <div className="lib-head">
        <div>
          <h1>{selectedDevice.name}</h1>
          <div className="sub">{selectedDevice.rootPath}</div>
        </div>
        <div className="actions">
          <button className="btn" type="button" disabled={loading || !selectedDevice.isAvailable} onClick={() => void scan(selectedDevice.id)}>
            <Icon name="rotate" size={13} /> Scan
          </button>
          <button className="btn primary" type="button" disabled={loading || !selectedDevice.isAvailable || !artworkMaxEdgeValid} onClick={() => void buildPlan()}>
            <Icon name="sync" size={13} /> Preview
          </button>
        </div>
      </div>

      {error && <div className="device-error">{error}</div>}
      {portableWarning && <div className="device-warning">{portableWarning}</div>}

      <div className="device-dashboard-grid">
        <section className="device-dashboard-tile device-overview-tile">
          <div className="device-tile-head">
            <div>
              <h2>Biblioteca conectada</h2>
              <span>{selectedDevice.isAvailable ? 'Montado' : 'Offline'} · {selectedDevice.hasRockbox ? 'Rockbox detectado' : 'Sin Rockbox'}</span>
            </div>
            <span className={`device-state ${selectedDevice.isAvailable ? 'online' : ''}`}>
              {selectedDevice.isAvailable ? 'Mounted' : 'Offline'}
            </span>
          </div>
          <div className="device-stats-grid">
            <StatTile label="Temas" value={stats.trackCount} />
            <StatTile label="Álbumes" value={stats.albumCount} />
            <StatTile label="Artistas" value={stats.artistCount} />
            <StatTile label="Playlists" value={stats.playlistCount} />
            <StatTile label="Rockbox Themes" value={stats.rockboxThemeCount} />
          </div>
          <div className="device-info-grid">
            <InfoRow label="Raíz" value={selectedDevice.rootPath} />
            <InfoRow label="Music root" value={selectedDevice.musicRoot} />
            <InfoRow label="Bibliotecas fuente" value={selectedLibraryLabel} />
            <InfoRow label="Artwork" value={`${selectedDevice.artworkMaxEdge}px`} />
            <InfoRow label="Último scan" value={formatDate(selectedDevice.lastScanAt)} />
            <InfoRow label="Última sync" value={formatDate(selectedDevice.lastSyncAt)} />
          </div>
        </section>

        <section className="device-dashboard-tile">
          <div className="device-tile-head">
            <div>
              <h2>Versiones</h2>
              <span>Lectura best-effort desde archivos locales del dispositivo.</span>
            </div>
          </div>
          <div className="device-info-grid compact">
            <InfoRow label="Crate state" value={selectedDevice.versions.crateStateVersion ?? 'No detectada'} />
            <InfoRow label="Machine state" value={selectedDevice.versions.machineStateVersion ?? 'No detectada'} />
            <InfoRow label="Rockbox" value={selectedDevice.versions.rockboxVersion ?? 'No detectada'} />
            <InfoRow label="Firmware" value={selectedDevice.versions.firmwareVersion ?? 'No detectada'} />
          </div>
        </section>

        <section className="device-dashboard-tile">
          <div className="device-tile-head">
            <div>
              <h2>Estado</h2>
              <span>Scan, sincronización y journals pendientes.</span>
            </div>
          </div>
          {activeProgress ? (
            <div className="device-dashboard-progress">
              <div>
                <strong>{SYNC_PHASE_LABELS[activeProgress.phase] ?? activeProgress.phase}</strong>
                <span>{progressText(progressCompleted, progressTotal)}</span>
              </div>
              <div className="device-progress-track" aria-hidden="true">
                <i style={{ width: `${progressPct}%` }} />
              </div>
            </div>
          ) : applyResult ? (
            <div className={applyResult.failed.length > 0 ? 'device-error inline' : 'sync-result-ok inline'}>
              {applyResult.failed.length > 0
                ? `${applyResult.failed.length} operaciones fallaron.`
                : `Sync completada: ${applyResult.applied} operaciones, ${applyResult.artwork.optimized} artworks optimizados.`}
            </div>
          ) : (
            <div className="device-empty compact">Sin trabajos activos.</div>
          )}
          <PendingJournalList
            journals={devicePendingJournals}
            loading={loading}
            onResume={journalId => void resumePendingJournal(journalId)}
            onDiscard={journalId => void discardJournal(journalId)}
          />
        </section>

        <section className="device-dashboard-tile device-config-tile">
          <div className="device-tile-head">
            <div>
              <h2>Configuración de sync</h2>
              <span>Modo, destino de importación y bibliotecas incluidas.</span>
            </div>
            {settingsChanged && <span className="device-unsaved">Sin guardar</span>}
          </div>

          <div className="device-config-grid">
            <div className="rule-row" style={{ margin: 0 }}>
              {MODES.map(item => (
                <button
                  key={item.mode}
                  className={`select device-mode ${mode === item.mode ? 'active' : ''}`}
                  type="button"
                  onClick={() => setMode(item.mode)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <label className="device-field">
              <span>Destino PC</span>
              <input
                value={pcTargetPath}
                onChange={event => setPcTargetPath(event.target.value)}
                placeholder="PC import target"
              />
            </label>
            <label className="device-field compact-field">
              <span>Artwork px</span>
              <input
                type="number"
                min={DEVICE_ARTWORK_EDGE_MIN}
                max={DEVICE_ARTWORK_EDGE_MAX}
                step={1}
                value={artworkMaxEdge}
                onChange={event => setArtworkMaxEdge(event.target.value)}
                aria-label="Device artwork limit"
              />
            </label>
          </div>

          <div className="device-library-note">
            PC → Device copia desde las bibliotecas marcadas. Device → PC importa a <code>{pcTargetPath || selectedDevice.pcTargetPath}</code>.
          </div>
          <div className="device-library-list">
            {folders.length === 0 ? (
              <div className="device-empty compact">No hay bibliotecas locales.</div>
            ) : (
              folders.map(folder => (
                <label className="device-library-row" key={folder.id} title={folder.path}>
                  <input
                    type="checkbox"
                    checked={sourceLibraryIds.includes(folder.id)}
                    disabled={loading || !selectedDevice.isAvailable}
                    onChange={() => toggleLibrary(folder.id)}
                  />
                  <span className="device-library-name">{folder.name}</span>
                  <span className="mono">{folder.track_count}</span>
                </label>
              ))
            )}
          </div>
          <div className="device-config-actions">
            <button
              className="btn"
              type="button"
              disabled={loading || !selectedDevice.isAvailable || !artworkMaxEdgeValid || !settingsChanged}
              onClick={() => void saveSettings()}
            >
              <Icon name="save" size={13} /> Guardar config
            </button>
            <button
              className="btn primary"
              type="button"
              disabled={loading || !selectedDevice.isAvailable || !artworkMaxEdgeValid}
              onClick={() => void buildPlan()}
            >
              <Icon name="sync" size={13} /> Preview
            </button>
          </div>
        </section>
      </div>

      <div className="device-library-head dashboard">
        <h2>Device Library</h2>
        <span>{tracks.length} scanned tracks</span>
      </div>
      <TrackRows tracks={tracks} />

      {plan && (
        <PlanPreviewModal
          plan={plan}
          applying={loading}
          result={applyResult}
          applyBlockedReason={applyBlockedReason}
          onClose={() => {
            clearPlan()
            setApplyResult(null)
          }}
          onApply={() => void applyCurrentPlan()}
        />
      )}
    </div>
  )
}
