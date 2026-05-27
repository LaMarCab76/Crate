import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '@renderer/components/Icon'
import {
  useDeviceLibrary,
  useDeviceStore,
  useSelectedDevice,
} from '@renderer/stores/deviceStore'
import { useFolders } from '@renderer/stores/libraryStore'
import { DEVICE_ARTWORK_EDGE_MAX, DEVICE_ARTWORK_EDGE_MIN } from '@shared/constants/device-sync'
import { fmtFileSize, fmtTime } from '@renderer/utils/format'
import { basenameForPath, isValidDeviceMusicRoot, normalizeDeviceMusicRoot } from '@renderer/utils/devicePaths'
import type { DbFolder } from '@shared/types/db'
import type {
  DevicePendingJournal,
  DeviceSyncActionKind,
  DeviceSyncApplyResult,
  DeviceSyncMode,
  DeviceSyncPlan,
  DeviceStorageSummary,
  DeviceTrack,
  RockboxThemeScanDiagnostic,
} from '@shared/types/device-sync'

const MODES: Array<{ mode: DeviceSyncMode; label: string; description: string }> = [
  {
    mode: 'pc_to_device',
    label: 'PC -> Device',
    description: 'Copia las bibliotecas seleccionadas al MP3 y elimina del dispositivo lo que ya no corresponda.',
  },
  {
    mode: 'device_to_pc',
    label: 'Device -> PC',
    description: 'Importa desde el MP3 al destino PC y elimina en la PC lo que ya no corresponda para esas bibliotecas.',
  },
  {
    mode: 'bidirectional_safe',
    label: 'Both',
    description: 'Copia cambios nuevos de ambos lados y deja conflictos sin aplicar para revisión.',
  },
]

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

const LOSSLESS_FORMAT_RE = /\b(flac|alac|wav|aiff?|dsf|dff)\b/i

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

function formatStorageSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  return fmtFileSize(bytes)
}

function sameNumberSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every(value => set.has(value))
}

function isLosslessTrack(track: DeviceTrack): boolean {
  return LOSSLESS_FORMAT_RE.test(track.format)
}

function formatTrackFormat(track: DeviceTrack): string {
  return track.format?.trim() || 'Unknown'
}

function countPlanKinds(plan: DeviceSyncPlan, kinds: DeviceSyncActionKind[]): number {
  const allowed = new Set<DeviceSyncActionKind>(kinds)
  return plan.actions.filter(action => allowed.has(action.kind)).length
}

function trackSwatchStyle(track: DeviceTrack): { background: string } {
  let hash = 0
  for (let i = 0; i < track.key.length; i += 1) {
    hash = (hash * 31 + track.key.charCodeAt(i)) % 360
  }
  return { background: `linear-gradient(135deg, hsl(${hash} 38% 36%), hsl(${(hash + 28) % 360} 46% 22%))` }
}

function MetricTile({
  label,
  value,
  detail,
  muted = false,
}: {
  label: string
  value: string | number
  detail: string
  muted?: boolean
}) {
  return (
    <div className="device-stat-tile">
      <span>{label}</span>
      <strong className={muted ? 'muted' : undefined}>{value}</strong>
      <em>{detail}</em>
    </div>
  )
}

function rockboxThemeDashboardStatus(
  hasRockbox: boolean,
  scan: RockboxThemeScanDiagnostic | undefined,
  themeCount: number,
): string {
  if (!hasRockbox) return 'Sin Rockbox'
  if (!scan) return 'Pendiente de scan'
  const misplaced = scan.misplacedConfigPaths.length
  const suffix = misplaced > 0 ? ` · ${misplaced} .cfg fuera de lugar` : ''
  if (scan.status === 'no-rockbox') return `Sin instalación Rockbox detectada${suffix}`
  if (scan.status === 'no-themes-dir') return `Falta .rockbox/themes${suffix}`
  if (scan.status === 'unreadable') return `No se pudo leer .rockbox/themes${suffix}`
  if (themeCount === 0) return `Sin .cfg directos${suffix}`
  return `${themeCount} theme${themeCount === 1 ? '' : 's'} válido${themeCount === 1 ? '' : 's'}${suffix}`
}

function folderLabel(folder: DbFolder): string {
  return folder.name || basenameForPath(folder.path)
}

function StorageBar({ storage }: { storage: DeviceStorageSummary | null }) {
  const available = Boolean(storage && !storage.error && storage.totalBytes > 0)
  if (!available || !storage) {
    return (
      <div className="device-storage unavailable">
        <div className="device-storage-line">
          <strong>Espacio no disponible</strong>
          <span>{storage?.error || 'Montá el dispositivo para leer capacidad real.'}</span>
        </div>
        <div className="device-storage-track" aria-hidden="true" />
      </div>
    )
  }

  const segments = [
    { key: 'music', label: 'Music', bytes: storage.musicBytes },
    { key: 'rockbox', label: 'Rockbox', bytes: storage.rockboxBytes },
    { key: 'other', label: 'Other', bytes: storage.otherBytes },
    { key: 'free', label: 'Free', bytes: storage.freeBytes },
  ].map(segment => ({
    ...segment,
    pct: storage.totalBytes > 0 ? Math.max(0, Math.min(100, (segment.bytes / storage.totalBytes) * 100)) : 0,
  }))

  return (
    <div className="device-storage">
      <div className="device-storage-line">
        <strong>{formatStorageSize(storage.usedBytes)} <span>of {formatStorageSize(storage.totalBytes)} used</span></strong>
        <span>{formatStorageSize(storage.freeBytes)} free</span>
      </div>
      <div className="device-storage-track" aria-label="Device storage usage">
        {segments.map(segment => (
          <i
            className={`device-storage-segment ${segment.key}`}
            key={segment.key}
            style={{ width: `${segment.pct}%`, minWidth: segment.bytes > 0 ? 2 : 0 }}
            title={`${segment.label}: ${formatStorageSize(segment.bytes)}`}
          />
        ))}
      </div>
      <div className="device-storage-legend">
        {segments.map(segment => (
          <span key={segment.key} className={segment.key}>
            <i /> {segment.label} · {formatStorageSize(segment.bytes)}
          </span>
        ))}
      </div>
    </div>
  )
}

function TrackRows({ tracks }: { tracks: DeviceTrack[] }) {
  if (tracks.length === 0) {
    return <div className="device-empty device-track-empty">No hay temas escaneados todavía.</div>
  }

  return (
    <div className="device-track-table">
      <div className="device-track-row device-track-header">
        <span>Title</span>
        <span>Artist</span>
        <span>Album</span>
        <span>Format</span>
        <span>Duration</span>
        <span>Size</span>
      </div>
      {tracks.slice(0, 250).map(track => (
        <div className="device-track-row" key={track.key}>
          <span className="device-track-title">
            <i style={trackSwatchStyle(track)} />
            <b>{track.title}</b>
          </span>
          <span>{track.artist || 'Unknown Artist'}</span>
          <span>{track.album || 'Unknown Album'}</span>
          <span className={`device-format ${isLosslessTrack(track) ? 'lossless' : ''}`}>{formatTrackFormat(track)}</span>
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

function SyncPlanPanel({
  plan,
  loading,
  result,
  applyBlockedReason,
  canPreview,
  onPreview,
  onClear,
  onApply,
}: {
  plan: DeviceSyncPlan | null
  loading: boolean
  result: DeviceSyncApplyResult | null
  applyBlockedReason: string | null
  canPreview: boolean
  onPreview: () => void
  onClear: () => void
  onApply: () => void
}) {
  const executable = plan?.actions.filter(action => action.kind !== 'skip_conflict').length ?? 0
  const addToDevice = plan ? countPlanKinds(plan, ['copy_pc_to_device']) : 0
  const pullToPc = plan ? countPlanKinds(plan, ['copy_device_to_pc']) : 0
  const update = plan ? countPlanKinds(plan, ['replace_device', 'replace_pc']) : 0
  const remove = plan ? countPlanKinds(plan, ['delete_device', 'delete_pc']) : 0
  const conflicts = plan?.summary.conflicts ?? 0
  const netDevice = plan ? plan.summary.deviceAfter - plan.summary.deviceBefore : 0

  return (
    <section className="device-side-card device-plan-card">
      <div className="device-card-head">
        <div>
          <h2>Sync plan</h2>
          <span>{plan ? 'Estimated diff against the device.' : 'Create a preview to estimate the next run.'}</span>
        </div>
        <button className="btn" type="button" disabled={loading || !canPreview} onClick={onPreview}>
          <Icon name="play" size={12} /> Preview
        </button>
      </div>

      {plan ? (
        <>
          <div className="device-plan-rows">
            <div className="device-plan-row add">
              <span><i><Icon name="plus" size={11} /></i>Add to device</span>
              <strong>{addToDevice}</strong>
            </div>
            <div className="device-plan-row pull">
              <span><i><Icon name="download" size={11} /></i>Pull to PC</span>
              <strong>{pullToPc}</strong>
            </div>
            <div className="device-plan-row update">
              <span><i><Icon name="sync" size={11} /></i>Update tags & artwork</span>
              <strong>{update}</strong>
            </div>
            <div className="device-plan-row remove">
              <span><i><Icon name="trash" size={11} /></i>Remove</span>
              <strong>{remove}</strong>
            </div>
            {conflicts > 0 && (
              <div className="device-plan-row conflict">
                <span><i><Icon name="info" size={11} /></i>Conflicts</span>
                <strong>{conflicts}</strong>
              </div>
            )}
          </div>
          <div className="device-plan-transfer">
            <span>Transfer · <strong>{formatStorageSize(plan.summary.bytesToCopy)}</strong></span>
            <span className={netDevice >= 0 ? 'positive' : 'negative'}>
              {netDevice >= 0 ? '+' : ''}{netDevice} net
            </span>
          </div>
          {applyBlockedReason && <div className="device-warning inline">{applyBlockedReason}</div>}
          {result && (
            <div className={result.failed.length > 0 ? 'device-error inline' : 'sync-result-ok inline'}>
              {result.failed.length > 0
                ? `${result.failed.length} operations failed. ${result.failed[0]?.error ?? ''}`
                : `Applied ${result.applied} operations. Optimized ${result.artwork.optimized} artwork files and saved ${fmtFileSize(result.artwork.bytesSaved)}.`}
            </div>
          )}
          <div className="device-plan-actions">
            <button className="btn ghost" type="button" disabled={loading} onClick={onClear}>
              Clear
            </button>
            <button
              className="btn primary"
              type="button"
              disabled={loading || executable === 0 || result != null || applyBlockedReason != null}
              onClick={onApply}
            >
              <Icon name="sync" size={13} /> Sync now
            </button>
          </div>
        </>
      ) : (
        <div className="device-empty compact">No hay preview activo.</div>
      )}
    </section>
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
  const scanResult = useDeviceStore(s => s.scanResult)
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
  const [musicRoot, setMusicRoot] = useState('')
  const [pcTargetPath, setPcTargetPath] = useState('')
  const [artworkMaxEdge, setArtworkMaxEdge] = useState('')
  const [sourceLibraryIds, setSourceLibraryIds] = useState<number[]>([])
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false)
  const [pathError, setPathError] = useState<string | null>(null)
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
    setMusicRoot(selectedDevice.musicRoot)
    setPcTargetPath(selectedDevice.pcTargetPath)
    setArtworkMaxEdge(String(selectedDevice.artworkMaxEdge))
    const folderIds = new Set(folders.map(folder => folder.id))
    setSourceLibraryIds(
      selectedDevice.sourceLibraryIds.length > 0
        ? selectedDevice.sourceLibraryIds.filter(id => folderIds.has(id))
        : folders.map(folder => folder.id),
    )
    setLibraryPickerOpen(false)
    setPathError(null)
  }, [
    selectedDevice?.id,
    selectedDevice?.defaultMode,
    selectedDevice?.musicRoot,
    selectedDevice?.pcTargetPath,
    selectedDevice?.artworkMaxEdge,
    selectedDevice?.sourceLibraryIds,
    folders,
  ])

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
  const rockboxThemeStatus = rockboxThemeDashboardStatus(
    selectedDevice?.hasRockbox ?? false,
    library?.rockboxThemeScan,
    stats.rockboxThemeCount,
  )
  const tracks = library?.tracks ?? []
  const latestScanStorage = scanResult && scanResult.device.id === selectedDevice?.id
    ? scanResult.storage
    : null
  const storage = library?.storage ?? latestScanStorage
  const visiblePlan = plan?.deviceId === selectedDevice?.id ? plan : null
  const losslessCount = useMemo(() => tracks.filter(isLosslessTrack).length, [tracks])
  const losslessPct = stats.trackCount > 0 ? Math.round((losslessCount / stats.trackCount) * 100) : 0
  const libraryBytes = useMemo(
    () => tracks.reduce((sum, track) => sum + (track.fileSize ?? 0), 0),
    [tracks],
  )
  const selectedDeviceId = selectedDevice?.id
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

  const artworkMaxEdgeValue = Number(artworkMaxEdge)
  const artworkMaxEdgeValid =
    Number.isInteger(artworkMaxEdgeValue) &&
    artworkMaxEdgeValue >= DEVICE_ARTWORK_EDGE_MIN &&
    artworkMaxEdgeValue <= DEVICE_ARTWORK_EDGE_MAX
  const musicRootValid = isValidDeviceMusicRoot(musicRoot)
  const normalizedMusicRoot = normalizeDeviceMusicRoot(musicRoot)
  const selectedSourceFolders = useMemo(
    () => folders.filter(folder => sourceLibraryIds.includes(folder.id)),
    [folders, sourceLibraryIds],
  )
  const availableSourceFolders = useMemo(
    () => folders.filter(folder => !sourceLibraryIds.includes(folder.id)),
    [folders, sourceLibraryIds],
  )
  const sourceLibrariesValid = selectedSourceFolders.length > 0

  const existingFolderIds = new Set(folders.map(folder => folder.id))
  const originalLibraryIds = selectedDevice
    ? selectedDevice.sourceLibraryIds.length > 0
      ? selectedDevice.sourceLibraryIds.filter(id => existingFolderIds.has(id))
      : folders.map(folder => folder.id)
    : []
  const settingsChanged = !!selectedDevice && (
    mode !== selectedDevice.defaultMode ||
    normalizedMusicRoot !== selectedDevice.musicRoot ||
    pcTargetPath.trim() !== selectedDevice.pcTargetPath ||
    artworkMaxEdgeValue !== selectedDevice.artworkMaxEdge ||
    !sameNumberSet(sourceLibraryIds, originalLibraryIds)
  )

  const portableState = selectedDevice?.portableState
  const portableWarning = portableState?.writable === false
    ? portableState.error ?? 'La configuración local se guardó, pero .crate no se pudo actualizar en el dispositivo.'
    : null
  const applyBlockedReason = portableState?.writable === false
    ? 'No se puede aplicar la sincronización hasta que .crate sea escribible en el dispositivo.'
    : null

  const addSourceLibrary = (folderId: number) => {
    setSourceLibraryIds(current => (current.includes(folderId) ? current : [...current, folderId]))
    setLibraryPickerOpen(false)
  }

  const removeSourceLibrary = (folderId: number) => {
    setSourceLibraryIds(current => (current.length <= 1 ? current : current.filter(id => id !== folderId)))
  }

  const pickMusicRoot = async () => {
    if (!selectedDevice) return
    setPathError(null)
    try {
      const picked = await window.api.devices.pickMusicRoot(selectedDevice.rootPath, normalizedMusicRoot)
      if (!picked.canceled && picked.musicRoot) setMusicRoot(picked.musicRoot)
    } catch (err) {
      setPathError(err instanceof Error ? err.message : String(err))
    }
  }

  const pickPcTargetPath = async () => {
    setPathError(null)
    try {
      const picked = await window.api.library.pickFolder()
      if (!picked.canceled && picked.path) setPcTargetPath(picked.path)
    } catch (err) {
      setPathError(err instanceof Error ? err.message : String(err))
    }
  }

  const saveSettings = useCallback(async () => {
    if (!selectedDevice || !artworkMaxEdgeValid || !musicRootValid || !sourceLibrariesValid) return null
    return updateSettings(selectedDevice.id, {
      defaultMode: mode,
      musicRoot: normalizedMusicRoot,
      pcTargetPath: pcTargetPath.trim() || selectedDevice.pcTargetPath,
      artworkMaxEdge: artworkMaxEdgeValue,
      sourceLibraryIds: selectedSourceFolders.map(folder => folder.id),
    })
  }, [selectedDevice, artworkMaxEdgeValid, musicRootValid, sourceLibrariesValid, updateSettings, mode, normalizedMusicRoot, pcTargetPath, artworkMaxEdgeValue, selectedSourceFolders])

  const buildPlan = useCallback(async () => {
    if (!selectedDevice || !sourceLibrariesValid || !musicRootValid || !artworkMaxEdgeValid) return
    setApplyResult(null)
    if (settingsChanged) await saveSettings()
    await planSync(mode, pcTargetPath.trim() || selectedDevice.pcTargetPath)
  }, [selectedDevice, sourceLibrariesValid, musicRootValid, artworkMaxEdgeValid, settingsChanged, saveSettings, planSync, mode, pcTargetPath])

  const applyCurrentPlan = useCallback(async () => {
    if (!visiblePlan || applyBlockedReason) return
    if (!devices.some(device => device.id === visiblePlan.deviceId)) {
      setPathError('El dispositivo asociado a este plan ya no está conectado.')
      clearPlan()
      return
    }
    const result = await applyPlan(visiblePlan.id)
    setApplyResult(result)
    await scan(visiblePlan.deviceId)
  }, [visiblePlan, applyBlockedReason, devices, applyPlan, scan, clearPlan])

  const resumePendingJournal = useCallback(async (journalId: string) => {
    const result = await resumeJournal(journalId)
    if (!devices.some(device => device.id === result.deviceId)) {
      setPathError('El dispositivo asociado al journal ya no está conectado.')
      return
    }
    await scan(result.deviceId)
  }, [devices, resumeJournal, scan])

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
      <div className="device-dashboard-nav">
        <div className="device-breadcrumb">
          <span>Devices</span>
          <Icon name="chevR" size={12} />
          <strong>{selectedDevice.name}</strong>
        </div>
      </div>

      {error && <div className="device-error">{error}</div>}
      {portableWarning && <div className="device-warning">{portableWarning}</div>}

      <section className="device-hero-panel">
        <div className="device-hero-main">
          <div className="device-kicker">
            <span>{selectedDevice.versions.rockboxVersion ? `ROCKBOX ${selectedDevice.versions.rockboxVersion}` : 'ROCKBOX'} · CRATE STATE {selectedDevice.versions.crateStateVersion ?? 'n/a'}</span>
            <span className={`device-connect-dot ${selectedDevice.isAvailable ? 'online' : ''}`}>
              {selectedDevice.isAvailable ? 'Connected' : 'Offline'}
            </span>
          </div>
          <h1>{selectedDevice.name}</h1>
          <p title={selectedDevice.rootPath}>{selectedDevice.rootPath}</p>
          <StorageBar storage={storage} />
        </div>
        <div className="device-hero-side">
          <div className="device-hero-times">
            <span>Last sync · <strong>{shortDate(selectedDevice.lastSyncAt)}</strong></span>
            <span>Last scanned · <strong>{shortDate(selectedDevice.lastScanAt)}</strong></span>
          </div>
          <div className="device-hero-buttons">
            <button className="btn" type="button" disabled={loading || !selectedDevice.isAvailable} onClick={() => void scan(selectedDevice.id)}>
              <Icon name="rotate" size={13} /> Re-scan
            </button>
            <button className="btn primary" type="button" disabled={loading || !selectedDevice.isAvailable || !artworkMaxEdgeValid || !musicRootValid || !sourceLibrariesValid} onClick={() => void buildPlan()}>
              <Icon name="sync" size={13} /> Preview sync
            </button>
          </div>
        </div>
      </section>

      <div className="device-metric-strip">
        <MetricTile label="Tracks" value={stats.trackCount.toLocaleString()} detail={`${formatStorageSize(libraryBytes)} scanned`} />
        <MetricTile label="Albums" value={stats.albumCount.toLocaleString()} detail={`${stats.artistCount.toLocaleString()} artists`} />
        <MetricTile label="Lossless" value={`${losslessPct}%`} detail={`${losslessCount.toLocaleString()} FLAC + ALAC`} />
        <MetricTile label="Playlists" value={stats.playlistCount.toLocaleString()} detail={stats.playlistCount > 0 ? 'ready to sync' : 'Create one to sync'} muted={stats.playlistCount === 0} />
        <MetricTile label="Rockbox Themes" value={stats.rockboxThemeCount.toLocaleString()} detail={rockboxThemeStatus} />
      </div>

      <div className="device-dashboard-body">
        <section className="device-main-card device-config-tile">
          <div className="device-card-head">
            <div>
              <h2>Sync setup</h2>
              <span>Direction, libraries and destination for the next sync run.</span>
            </div>
            {settingsChanged && <span className="device-unsaved">Sin guardar</span>}
          </div>

          <div className="device-sync-flow">
            <div className="device-flow-node">
              <Icon name="computer" size={20} />
              <strong>This Mac</strong>
              <span title={pcTargetPath || selectedDevice.pcTargetPath}>{pcTargetPath || selectedDevice.pcTargetPath}</span>
            </div>
            <div className="device-flow-modes">
              {MODES.map(item => (
                <button
                  key={item.mode}
                  className={`device-flow-mode ${mode === item.mode ? 'active' : ''}`}
                  type="button"
                  title={item.description}
                  onClick={() => setMode(item.mode)}
                >
                  {item.mode === 'pc_to_device' ? 'Push' : item.mode === 'device_to_pc' ? 'Pull' : 'Both'}
                  <Icon name="info" size={11} />
                </button>
              ))}
            </div>
            <div className="device-flow-node device">
              <Icon name="device" size={20} />
              <strong>{selectedDevice.name}</strong>
              <span title={selectedDevice.rootPath}>{selectedDevice.rootPath} · {stats.trackCount.toLocaleString()} tracks</span>
            </div>
          </div>

          <div className="device-config-stack">
            <section className="device-config-section">
              <div className="device-config-section-head">
                <span>Libraries to include</span>
                <em>{selectedSourceFolders.length} of {folders.length} selected · {selectedSourceFolders.reduce((sum, folder) => sum + folder.track_count, 0).toLocaleString()} tracks</em>
              </div>
              <div className="device-source-library-grid">
                {folders.length === 0 ? (
                  <div className="device-empty compact">No hay bibliotecas locales.</div>
                ) : selectedSourceFolders.length === 0 ? (
                  <div className="device-empty compact">No hay bibliotecas agregadas al sync.</div>
                ) : (
                  selectedSourceFolders.map(folder => (
                    <div className="device-source-library-row" key={folder.id} title={folder.path}>
                      <Icon name="folder" size={14} />
                      <span className="device-source-library-main">
                        <strong>{folderLabel(folder)}</strong>
                        <em>{folder.path}</em>
                      </span>
                      <span className="mono">{folder.track_count.toLocaleString()}</span>
                      <button
                        className="btn icon"
                        type="button"
                        disabled={loading || selectedSourceFolders.length <= 1}
                        title="Quitar biblioteca fuente"
                        aria-label={`Quitar ${folderLabel(folder)}`}
                        onClick={() => removeSourceLibrary(folder.id)}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="device-config-section">
              <div className="device-config-section-head">
                <span>Paths</span>
              </div>
              <div className="device-route-stack">
                <label className="device-field device-route-field">
                  <span>MP3 folder on device</span>
                  <div className="device-path-control">
                    <input
                      value={musicRoot}
                      onChange={event => setMusicRoot(event.target.value)}
                      placeholder="."
                      aria-invalid={!musicRootValid}
                    />
                    <button
                      className="btn icon"
                      type="button"
                      disabled={loading || !selectedDevice.isAvailable}
                      title="Elegir carpeta en el MP3"
                      onClick={() => void pickMusicRoot()}
                    >
                      <Icon name="folder" size={13} />
                    </button>
                  </div>
                </label>

                <label className="device-field device-route-field">
                  <span>PC destination (pull)</span>
                  <div className="device-path-control with-add">
                    <input
                      value={pcTargetPath}
                      onChange={event => setPcTargetPath(event.target.value)}
                      placeholder="PC import target"
                    />
                    <button
                      className="btn icon"
                      type="button"
                      disabled={loading}
                      title="Elegir destino PC"
                      onClick={() => void pickPcTargetPath()}
                    >
                      <Icon name="folder" size={13} />
                    </button>
                    <button
                      className="btn icon"
                      type="button"
                      disabled={loading || availableSourceFolders.length === 0}
                      title="Agregar biblioteca fuente"
                      aria-expanded={libraryPickerOpen}
                      onClick={() => setLibraryPickerOpen(open => !open)}
                    >
                      <Icon name="plus" size={13} />
                    </button>
                  </div>
                </label>

                {libraryPickerOpen && (
                  <div className="device-source-picker">
                    {availableSourceFolders.length === 0 ? (
                      <div className="device-empty compact">Todas las bibliotecas ya están agregadas.</div>
                    ) : (
                      availableSourceFolders.map(folder => (
                        <button
                          className="device-source-picker-row"
                          type="button"
                          key={folder.id}
                          onClick={() => addSourceLibrary(folder.id)}
                        >
                          <Icon name="folder" size={13} />
                          <span>
                            <strong>{folderLabel(folder)}</strong>
                            <em>{folder.path}</em>
                          </span>
                          <b>{folder.track_count}</b>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </section>

            <div className="device-config-bottom">
              <label className="device-field device-artwork-field">
                <span>Artwork size</span>
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
          </div>

          {!musicRootValid && (
            <div className="device-error inline">La carpeta del MP3 no puede usar segmentos ..</div>
          )}
          {!sourceLibrariesValid && (
            <div className="device-error inline">Agregá al menos una biblioteca fuente para sincronizar.</div>
          )}
          {pathError && <div className="device-error inline">{pathError}</div>}
          <div className="device-library-note">
            PC -&gt; Device copia desde las bibliotecas agregadas a <code>{normalizedMusicRoot}</code>. Device -&gt; PC importa a <code>{pcTargetPath || selectedDevice.pcTargetPath}</code>.
          </div>
          <div className="device-config-actions">
            <button
              className="btn"
              type="button"
              disabled={loading || !selectedDevice.isAvailable || !artworkMaxEdgeValid || !musicRootValid || !sourceLibrariesValid || !settingsChanged}
              onClick={() => void saveSettings()}
            >
              <Icon name="save" size={13} /> Guardar config
            </button>
            <button
              className="btn primary"
              type="button"
              disabled={loading || !selectedDevice.isAvailable || !artworkMaxEdgeValid || !musicRootValid || !sourceLibrariesValid}
              onClick={() => void buildPlan()}
            >
              <Icon name="play" size={13} /> Preview run
            </button>
          </div>
        </section>

        <div className="device-side-stack">
          <SyncPlanPanel
            plan={visiblePlan}
            loading={loading}
            result={applyResult}
            applyBlockedReason={applyBlockedReason}
            canPreview={selectedDevice.isAvailable && artworkMaxEdgeValid && musicRootValid && sourceLibrariesValid}
            onPreview={() => void buildPlan()}
            onClear={() => {
              clearPlan()
              setApplyResult(null)
            }}
            onApply={() => void applyCurrentPlan()}
          />

          <section className="device-side-card device-activity-card">
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
              ) : applyResult ? (
                <div className={`device-activity-row ${applyResult.failed.length > 0 ? 'failed' : 'done'}`}>
                  <i />
                  <div>
                    <span>Now</span>
                    <strong>{applyResult.failed.length > 0 ? `${applyResult.failed.length} operations failed` : `Sync complete · ${applyResult.applied} operations`}</strong>
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
                  <strong>Scan complete · {stats.trackCount.toLocaleString()} tracks indexed</strong>
                </div>
              </div>
              <div className={`device-activity-row ${selectedDevice.hasRockbox ? 'done' : ''}`}>
                <i />
                <div>
                  <span>Rockbox</span>
                  <strong>{rockboxThemeStatus}</strong>
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
        </div>
      </div>

      <section className="device-library-panel">
        <div className="device-library-head dashboard">
          <h2>Device library</h2>
          <span>{tracks.length.toLocaleString()} tracks · {formatStorageSize(libraryBytes)}</span>
        </div>
        <TrackRows tracks={tracks} />
      </section>

      <div className="device-technical-bar">
        <span><Icon name="info" size={13} /> Technical details</span>
        <strong>
          Rockbox {selectedDevice.versions.rockboxVersion ?? 'not detected'} · Crate state {selectedDevice.versions.crateStateVersion ?? 'n/a'} · Machine {selectedDevice.versions.machineStateVersion ?? 'n/a'} · Firmware {selectedDevice.versions.firmwareVersion ?? 'not detected'}
        </strong>
      </div>
    </div>
  )
}
