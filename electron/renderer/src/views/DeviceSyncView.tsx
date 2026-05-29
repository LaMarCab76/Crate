import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '@renderer/components/Icon'
import { useDeviceLibrary, useDeviceStore, useSelectedDevice } from '@renderer/stores/deviceStore'
import { useFolders, usePlaylists } from '@renderer/stores/libraryStore'
import { DEVICE_ARTWORK_EDGE_MAX, DEVICE_ARTWORK_EDGE_MIN } from '@shared/constants/device-sync'
import { fmtFileSize } from '@renderer/utils/format'
import { basenameForPath, isValidDeviceMusicRoot, normalizeDeviceMusicRoot } from '@renderer/utils/devicePaths'
import {
  actionKindForSelection,
  bulkResolveSelection,
  conflictResolutionOptions,
  defaultDeviceSyncSelection,
  groupDeviceSyncActions,
  selectionPayload,
  selectedActionIds,
  summarizeDeviceSyncSelection,
  type DeviceSyncBase,
  type DeviceSyncPlanGroupBy,
} from '@renderer/utils/deviceSyncPlan'
import type { DbFolder } from '@shared/types/db'
import type { Playlist } from '@shared/types/library'
import type {
  DevicePlaylistSummary,
  DevicePendingJournal,
  DeviceSyncAction,
  DeviceSyncActionKind,
  DeviceSyncApplyResult,
  DeviceSyncApplySelection,
  DeviceSyncMode,
  DeviceSyncPlan,
} from '@shared/types/device-sync'

const MODES: Array<{ mode: DeviceSyncMode; label: string; short: string; description: string }> = [
  {
    mode: 'pc_to_device',
    label: 'PC -> Device',
    short: 'Push',
    description: 'Copia las bibliotecas seleccionadas al MP3 y elimina del dispositivo lo que ya no corresponda.',
  },
  {
    mode: 'device_to_pc',
    label: 'Device -> PC',
    short: 'Pull',
    description: 'Importa desde el MP3 a la raíz de la biblioteca elegida y elimina en la PC lo que ya no corresponda.',
  },
  {
    mode: 'bidirectional_safe',
    label: 'Both',
    short: 'Both',
    description: 'Copia cambios nuevos de ambos lados; las diferencias se resuelven con la base elegida abajo.',
  },
]

const SYNC_BASES: Array<{ value: DeviceSyncBase; label: string }> = [
  { value: 'pc', label: 'Preferir PC' },
  { value: 'device', label: 'Preferir dispositivo' },
  { value: 'review', label: 'Revisar c/u' },
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

const SYNC_ACTION_LABELS: Record<DeviceSyncActionKind, string> = {
  copy_pc_to_device: 'PC -> Device',
  copy_device_to_pc: 'Device -> PC',
  replace_device: 'Usar PC',
  replace_pc: 'Usar Device',
  delete_device: 'Eliminar device',
  delete_pc: 'Eliminar PC',
  skip_conflict: 'Omitir',
}

const SYNC_ACTION_SHORT_LABELS: Record<DeviceSyncActionKind, string> = {
  copy_pc_to_device: 'Push',
  copy_device_to_pc: 'Pull',
  replace_device: 'PC',
  replace_pc: 'Device',
  delete_device: 'Borrar device',
  delete_pc: 'Borrar PC',
  skip_conflict: 'Omitir',
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

function folderLabel(folder: DbFolder): string {
  return folder.name || basenameForPath(folder.path)
}

function SyncCurrentRunPanel({
  phase,
  completed,
  total,
  percent,
  currentPath,
}: {
  phase: string
  completed: number
  total: number
  percent: number
  currentPath: string | null
}) {
  return (
    <section className="device-side-card device-sync-run-card">
      <div className="device-card-head">
        <div>
          <h2>Sync en curso</h2>
          <span>Estado actual de la operación activa.</span>
        </div>
        <strong>{progressText(completed, total)}</strong>
      </div>
      <div className="device-sync-run-status">
        <span>{SYNC_PHASE_LABELS[phase] ?? phase}</span>
        <div className="device-progress-track" aria-label="Sync progress">
          <b style={{ width: `${percent}%` }} />
        </div>
        {currentPath && <em title={currentPath}>{currentPath}</em>}
      </div>
    </section>
  )
}

function SyncPlanPanel({
  plan,
  selection,
  loading,
  result,
  applyBlockedReason,
  canRecalculate,
  base,
  devicePlaylists,
  pcPlaylists,
  onRecalculate,
  onClear,
  onApply,
  onToggleAction,
  onToggleGroup,
  onSelectAll,
  onClearSelection,
  onResolveConflict,
  onSetBase,
}: {
  plan: DeviceSyncPlan | null
  selection: DeviceSyncApplySelection | null
  loading: boolean
  result: DeviceSyncApplyResult | null
  applyBlockedReason: string | null
  canRecalculate: boolean
  base: DeviceSyncBase
  devicePlaylists: DevicePlaylistSummary[]
  pcPlaylists: Playlist[]
  onRecalculate: () => void
  onClear: () => void
  onApply: () => void
  onToggleAction: (actionId: string) => void
  onToggleGroup: (actions: DeviceSyncAction[], selected: boolean) => void
  onSelectAll: () => void
  onClearSelection: () => void
  onResolveConflict: (actionId: string, kind: DeviceSyncActionKind) => void
  onSetBase: (base: DeviceSyncBase) => void
}) {
  const [groupBy, setGroupBy] = useState<DeviceSyncPlanGroupBy>('artist')
  const selectedIds = useMemo(() => selectedActionIds(selection), [selection])
  const selectedSummary = useMemo(
    () => plan ? summarizeDeviceSyncSelection(plan, selection) : null,
    [plan, selection],
  )
  const addToDevice = selectedSummary?.copyPcToDevice ?? 0
  const pullToPc = selectedSummary?.copyDeviceToPc ?? 0
  const update = selectedSummary ? selectedSummary.replaceDevice + selectedSummary.replacePc : 0
  const remove = selectedSummary ? selectedSummary.deleteDevice + selectedSummary.deletePc : 0
  const conflicts = selectedSummary?.conflicts ?? 0
  const executable = selectedSummary
    ? addToDevice + pullToPc + update + remove
    : 0
  const netDevice = selectedSummary ? selectedSummary.deviceAfter - selectedSummary.deviceBefore : 0
  const visibleActions = useMemo(() => plan?.actions ?? [], [plan])
  const groups = useMemo(
    () => groupDeviceSyncActions(visibleActions, groupBy, pcPlaylists, devicePlaylists),
    [devicePlaylists, groupBy, pcPlaylists, visibleActions],
  )
  const isBidirectional = plan?.mode === 'bidirectional_safe'

  return (
    <section className="device-side-card device-plan-card">
      <div className="device-card-head">
        <div>
          <h2>Cambios a sincronizar</h2>
          <span>{plan ? 'Revisá las diferencias antes de aplicar el sync.' : 'Calculando las diferencias del dispositivo…'}</span>
        </div>
        <button className="btn" type="button" disabled={loading || !canRecalculate} onClick={onRecalculate}>
          <Icon name="rotate" size={12} /> Recalcular
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
            <span>Transfer · <strong>{fmtFileSize(selectedSummary?.bytesToCopy ?? 0)}</strong></span>
            <span className={netDevice >= 0 ? 'positive' : 'negative'}>
              {netDevice >= 0 ? '+' : ''}{netDevice} net
            </span>
          </div>

          {isBidirectional && (
            <div className="device-plan-base" role="radiogroup" aria-label="Base para las diferencias">
              <span>Base de las diferencias</span>
              <div className="device-plan-base-options">
                {SYNC_BASES.map(item => (
                  <button
                    key={item.value}
                    className={base === item.value ? 'active' : ''}
                    type="button"
                    role="radio"
                    aria-checked={base === item.value}
                    disabled={loading}
                    onClick={() => onSetBase(item.value)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="device-plan-toolbar">
            <div className="device-plan-tabs" role="tablist" aria-label="Agrupar cambios de sincronización">
              {(['artist', 'album', 'playlist', 'track'] as DeviceSyncPlanGroupBy[]).map(item => (
                <button
                  key={item}
                  className={groupBy === item ? 'active' : ''}
                  type="button"
                  onClick={() => setGroupBy(item)}
                >
                  {item === 'artist' ? 'Artista' : item === 'album' ? 'Álbum' : item === 'playlist' ? 'Playlist' : 'Tema'}
                </button>
              ))}
            </div>
            <div className="device-plan-bulk">
              <button className="btn ghost" type="button" disabled={loading} onClick={onSelectAll}>
                Todo
              </button>
              <button className="btn ghost" type="button" disabled={loading} onClick={onClearSelection}>
                Nada
              </button>
            </div>
          </div>
          <div className="device-plan-groups">
            {groups.length === 0 ? (
              <div className="device-empty compact">No hay cambios para aplicar.</div>
            ) : groups.slice(0, 12).map(group => {
              const selectedInGroup = group.actions.filter(action => {
                const kind = actionKindForSelection(action, selection)
                return kind != null && kind !== 'skip_conflict'
              }).length
              const allSelected = selectedInGroup === group.actions.length && group.actions.length > 0
              return (
                <section className="device-plan-group" key={group.id}>
                  <button
                    className={`device-plan-group-head ${allSelected ? 'selected' : ''}`}
                    type="button"
                    disabled={loading}
                    onClick={() => onToggleGroup(group.actions, !allSelected)}
                  >
                    <span>
                      <strong>{group.label}</strong>
                      <em>{selectedInGroup}/{group.actions.length} cambios · {fmtFileSize(group.bytes)}</em>
                    </span>
                    <Icon name={allSelected ? 'check' : 'plus'} size={13} />
                  </button>
                  <div className="device-plan-action-list">
                    {group.actions.slice(0, 8).map(action => {
                      const selectedKind = actionKindForSelection(action, selection)
                      const isConflict = action.kind === 'skip_conflict'
                      return (
                        <div className={`device-plan-action ${isConflict ? 'conflict' : ''}`} key={action.id}>
                          <button
                            className={`device-plan-action-toggle ${selectedIds.has(action.id) ? 'active' : ''}`}
                            type="button"
                            disabled={loading || isConflict}
                            onClick={() => onToggleAction(action.id)}
                            aria-label={selectedIds.has(action.id) ? 'Quitar cambio' : 'Agregar cambio'}
                          >
                            <Icon name={selectedIds.has(action.id) ? 'check' : 'plus'} size={12} />
                          </button>
                          <span className="device-plan-action-main">
                            <strong>{action.title}</strong>
                            <em title={action.relativePath}>{action.artist || 'Unknown Artist'} · {action.album || 'Unknown Album'} · {action.reason}</em>
                          </span>
                          {isConflict ? (
                            <span className="device-conflict-choices">
                              {conflictResolutionOptions(action).map(kind => (
                                <button
                                  key={kind}
                                  className={selectedKind === kind ? 'active' : ''}
                                  type="button"
                                  disabled={loading}
                                  title={SYNC_ACTION_LABELS[kind]}
                                  onClick={() => onResolveConflict(action.id, kind)}
                                >
                                  {SYNC_ACTION_SHORT_LABELS[kind]}
                                </button>
                              ))}
                            </span>
                          ) : (
                            <strong className="device-plan-action-kind">{SYNC_ACTION_LABELS[action.kind]}</strong>
                          )}
                        </div>
                      )
                    })}
                    {group.actions.length > 8 && (
                      <div className="device-empty compact">{group.actions.length - 8} cambios más en este grupo</div>
                    )}
                  </div>
                </section>
              )
            })}
            {groups.length > 12 && (
              <div className="device-empty compact">{groups.length - 12} grupos más ocultos</div>
            )}
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
        <div className="device-empty compact">{loading ? 'Calculando cambios…' : 'No hay cambios calculados todavía.'}</div>
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

export function DeviceSyncView({ deviceId }: { deviceId: string }) {
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
  const pcPlaylists = usePlaylists()

  const [mode, setMode] = useState<DeviceSyncMode>('bidirectional_safe')
  const [musicRoot, setMusicRoot] = useState('')
  const [artworkMaxEdge, setArtworkMaxEdge] = useState('')
  const [sourceLibraryIds, setSourceLibraryIds] = useState<number[]>([])
  const [destinationFolderId, setDestinationFolderId] = useState<number | null>(null)
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false)
  const [pathError, setPathError] = useState<string | null>(null)
  const [applyResult, setApplyResult] = useState<DeviceSyncApplyResult | null>(null)
  const [selectedPlanActionIds, setSelectedPlanActionIds] = useState<Set<string>>(new Set())
  const [conflictResolutions, setConflictResolutions] = useState<Record<string, DeviceSyncActionKind>>({})
  const [syncBase, setSyncBase] = useState<DeviceSyncBase>('review')

  useEffect(() => {
    void load()
    void refreshVolumes()
  }, [load, refreshVolumes])

  useEffect(() => {
    selectDevice(deviceId)
  }, [deviceId, selectDevice])

  const library = useDeviceLibrary(selectedDevice?.id ?? null)

  useEffect(() => {
    if (!selectedDevice) return
    void loadDeviceLibrary(selectedDevice.id).catch(() => undefined)
  }, [selectedDevice?.id, loadDeviceLibrary])

  // Reset the editable config from the device record whenever it changes (incl.
  // after an auto-save round-trips the new values back).
  useEffect(() => {
    if (!selectedDevice) return
    setMode(selectedDevice.defaultMode)
    setMusicRoot(selectedDevice.musicRoot)
    setArtworkMaxEdge(String(selectedDevice.artworkMaxEdge))
    const folderIds = new Set(folders.map(folder => folder.id))
    const nextSourceIds = selectedDevice.sourceLibraryIds.length > 0
      ? selectedDevice.sourceLibraryIds.filter(id => folderIds.has(id))
      : folders.map(folder => folder.id)
    setSourceLibraryIds(nextSourceIds)
    // Destination = the included library whose root matches the saved pcTargetPath,
    // otherwise the first included library.
    const match = folders.find(folder => nextSourceIds.includes(folder.id) && folder.path === selectedDevice.pcTargetPath)
    setDestinationFolderId(match?.id ?? nextSourceIds[0] ?? null)
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
  const visiblePlan = plan?.deviceId === selectedDevice?.id ? plan : null
  const currentPlanSelection = useMemo(
    () => visiblePlan ? selectionPayload(selectedPlanActionIds, conflictResolutions) : null,
    [conflictResolutions, selectedPlanActionIds, visiblePlan],
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
  const selectedSourceTrackCount = selectedSourceFolders.reduce((sum, folder) => sum + folder.track_count, 0)

  const needsDestination = mode === 'device_to_pc' || mode === 'bidirectional_safe'
  const destinationFolder = useMemo(
    () => selectedSourceFolders.find(folder => folder.id === destinationFolderId) ?? null,
    [selectedSourceFolders, destinationFolderId],
  )
  const planPcTargetPath = destinationFolder?.path ?? selectedDevice?.pcTargetPath ?? ''

  // Keep the destination pointing at an included library.
  useEffect(() => {
    if (destinationFolderId != null && selectedSourceFolders.some(folder => folder.id === destinationFolderId)) return
    setDestinationFolderId(selectedSourceFolders[0]?.id ?? null)
  }, [selectedSourceFolders, destinationFolderId])

  useEffect(() => {
    if (!visiblePlan) {
      setSelectedPlanActionIds(new Set())
      setConflictResolutions({})
      setSyncBase('review')
      return
    }
    const defaults = defaultDeviceSyncSelection(visiblePlan)
    setSelectedPlanActionIds(new Set(defaults.actionIds ?? []))
    setConflictResolutions({})
    setSyncBase('review')
  }, [visiblePlan?.id])

  const existingFolderIds = new Set(folders.map(folder => folder.id))
  const originalLibraryIds = selectedDevice
    ? selectedDevice.sourceLibraryIds.length > 0
      ? selectedDevice.sourceLibraryIds.filter(id => existingFolderIds.has(id))
      : folders.map(folder => folder.id)
    : []
  const settingsChanged = !!selectedDevice && (
    mode !== selectedDevice.defaultMode ||
    normalizedMusicRoot !== selectedDevice.musicRoot ||
    planPcTargetPath !== selectedDevice.pcTargetPath ||
    artworkMaxEdgeValue !== selectedDevice.artworkMaxEdge ||
    !sameNumberSet(sourceLibraryIds, originalLibraryIds)
  )

  const portableState = selectedDevice?.portableState
  const portableWarning = portableState?.writable === false
    ? portableState.error ?? 'La configuración local se guardó, pero .crate no se pudo actualizar en el dispositivo.'
    : null
  const portableBlocked = portableState?.writable === false
    ? 'No se puede aplicar la sincronización hasta que .crate sea escribible en el dispositivo.'
    : null
  const destinationBlocked = needsDestination && !destinationFolder
    ? 'Elegí una biblioteca destino para los archivos entrantes.'
    : null
  const applyBlockedReason = portableBlocked ?? destinationBlocked

  const configValid = artworkMaxEdgeValid && musicRootValid && sourceLibrariesValid

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

  const saveSettings = useCallback(async () => {
    if (!selectedDevice || !configValid) return null
    return updateSettings(selectedDevice.id, {
      defaultMode: mode,
      musicRoot: normalizedMusicRoot,
      pcTargetPath: planPcTargetPath || selectedDevice.pcTargetPath,
      artworkMaxEdge: artworkMaxEdgeValue,
      sourceLibraryIds: selectedSourceFolders.map(folder => folder.id),
    })
  }, [selectedDevice, configValid, updateSettings, mode, normalizedMusicRoot, planPcTargetPath, artworkMaxEdgeValue, selectedSourceFolders])

  const buildPlan = useCallback(async () => {
    if (!selectedDevice || !configValid) return
    setApplyResult(null)
    await planSync(mode, planPcTargetPath || selectedDevice.pcTargetPath)
  }, [selectedDevice, configValid, planSync, mode, planPcTargetPath])

  // Persisted config signature: changing any of these auto-saves and (when the
  // device is reachable) recomputes the diff after a short debounce.
  const configSignature = [
    selectedDevice?.id ?? '',
    mode,
    normalizedMusicRoot,
    artworkMaxEdgeValue,
    [...sourceLibraryIds].sort((a, b) => a - b).join(','),
    planPcTargetPath,
  ].join('|')
  const deviceAvailable = selectedDevice?.isAvailable ?? false

  useEffect(() => {
    if (!selectedDevice || !configValid) return
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          if (settingsChanged) await saveSettings()
          if (deviceAvailable) await buildPlan()
        } catch {
          /* store surfaces the error */
        }
      })()
    }, 500)
    return () => window.clearTimeout(handle)
    // settingsChanged/saveSettings/buildPlan are intentionally captured per
    // configSignature change to avoid re-fire loops after the save round-trip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configSignature, configValid, deviceAvailable])

  const togglePlanAction = useCallback((actionId: string) => {
    setSelectedPlanActionIds(current => {
      const next = new Set(current)
      if (next.has(actionId)) next.delete(actionId)
      else next.add(actionId)
      return next
    })
  }, [])

  const togglePlanGroup = useCallback((actions: DeviceSyncAction[], selected: boolean) => {
    setSelectedPlanActionIds(current => {
      const next = new Set(current)
      for (const action of actions) {
        if (action.kind === 'skip_conflict') continue
        if (selected) next.add(action.id)
        else next.delete(action.id)
      }
      return next
    })
    if (!selected) {
      setConflictResolutions(current => {
        const next = { ...current }
        for (const action of actions) delete next[action.id]
        return next
      })
    }
  }, [])

  const selectAllPlanActions = useCallback(() => {
    if (!visiblePlan) return
    const defaults = defaultDeviceSyncSelection(visiblePlan)
    setSelectedPlanActionIds(new Set(defaults.actionIds ?? []))
  }, [visiblePlan])

  const clearPlanSelection = useCallback(() => {
    setSelectedPlanActionIds(new Set())
    setConflictResolutions({})
    setSyncBase('review')
  }, [])

  const resolvePlanConflict = useCallback((actionId: string, kind: DeviceSyncActionKind) => {
    setConflictResolutions(current => {
      const next = { ...current }
      if (kind === 'skip_conflict') delete next[actionId]
      else next[actionId] = kind
      return next
    })
    setSelectedPlanActionIds(current => {
      const next = new Set(current)
      if (kind === 'skip_conflict') next.delete(actionId)
      else next.add(actionId)
      return next
    })
  }, [])

  const applyPlanBase = useCallback((base: DeviceSyncBase) => {
    setSyncBase(base)
    if (!visiblePlan) return
    const { actionIds, conflictResolutions: resolutions } = bulkResolveSelection(visiblePlan, base)
    setSelectedPlanActionIds(actionIds)
    setConflictResolutions(resolutions)
  }, [visiblePlan])

  const applyCurrentPlan = useCallback(async () => {
    if (!visiblePlan || applyBlockedReason) return
    if (!devices.some(device => device.id === visiblePlan.deviceId)) {
      setPathError('El dispositivo asociado a este plan ya no está conectado.')
      clearPlan()
      return
    }
    const result = await applyPlan(visiblePlan.id, currentPlanSelection ?? undefined)
    setApplyResult(result)
    await scan(visiblePlan.deviceId)
  }, [visiblePlan, applyBlockedReason, devices, applyPlan, currentPlanSelection, scan, clearPlan])

  const resumePendingJournal = useCallback(async (journalId: string) => {
    const result = await resumeJournal(journalId)
    if (!devices.some(device => device.id === result.deviceId)) {
      setPathError('El dispositivo asociado al journal ya no está conectado.')
      return
    }
    await scan(result.deviceId)
  }, [devices, resumeJournal, scan])

  const activeProgressPath = activeProgress === syncProgress ? syncProgress?.currentPath ?? null : null

  if (!selectedDevice) {
    return (
      <div className="devices-page">
        <div className="lib-head">
          <div>
            <h1>Device Sync</h1>
            <div className="sub">Seleccioná un dispositivo desde el sidebar.</div>
          </div>
        </div>
        <div className="device-empty large">No hay un dispositivo seleccionado.</div>
      </div>
    )
  }

  return (
    <div className="devices-page device-sync-page">
      {error && <div className="device-error">{error}</div>}
      {portableWarning && <div className="device-warning">{portableWarning}</div>}

      <header className="device-sync-control-hero device-sync-page-header">
        <span className={`device-connect-dot ${selectedDevice.isAvailable ? 'online' : ''}`}>
          {selectedDevice.isAvailable ? 'Connected' : 'Offline'}
        </span>
        <h1>{selectedDevice.name} Sync</h1>
        <p title={selectedDevice.rootPath}>{selectedDevice.rootPath} · {stats.trackCount.toLocaleString()} temas indexados</p>
        {activeProgress && (
          <div className="device-sync-inline-progress">
            <span>{SYNC_PHASE_LABELS[activeProgress.phase] ?? activeProgress.phase} · {progressText(progressCompleted, progressTotal)}</span>
            <div className="device-progress-track" aria-hidden="true">
              <b style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        )}
      </header>

      <section className="device-main-card device-config-tile device-sync-control-card device-sync-setup-card">
        <div className="device-card-head compact">
          <div>
            <h2>Configuración de sync</h2>
            <span>Se guarda automáticamente y recalcula los cambios.</span>
          </div>
          {settingsChanged && <span className="device-unsaved">Guardando…</span>}
        </div>

        <div className="device-sync-setup-grid">
          <div className="device-sync-setup-col">
            <div className={`device-sync-direction ${mode}`}>
              <div className="device-sync-direction-head">
                <span>Dirección del sync</span>
                <em>{MODES.find(item => item.mode === mode)?.description}</em>
              </div>
              <div className="device-flow-modes" role="radiogroup" aria-label="Sync direction">
                {MODES.map(item => (
                  <button
                    key={item.mode}
                    className={`device-flow-mode ${item.mode} ${mode === item.mode ? 'active' : ''}`}
                    type="button"
                    title={item.description}
                    aria-checked={mode === item.mode}
                    role="radio"
                    onClick={() => setMode(item.mode)}
                  >
                    <strong>{item.short}</strong>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <label className="device-field device-node-field">
              <span>Carpeta de música en {selectedDevice.name}</span>
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

            {needsDestination && (
              <label className="device-field">
                <span>Importar a la biblioteca</span>
                <select
                  className="device-select"
                  value={destinationFolderId ?? ''}
                  disabled={loading || selectedSourceFolders.length === 0}
                  onChange={event => setDestinationFolderId(event.target.value ? Number(event.target.value) : null)}
                >
                  {selectedSourceFolders.length === 0 && <option value="">Sin bibliotecas</option>}
                  {selectedSourceFolders.map(folder => (
                    <option key={folder.id} value={folder.id}>{folderLabel(folder)}</option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="device-sync-setup-col">
            <div className="device-config-stack">
              <section className="device-config-section">
                <div className="device-config-section-head">
                  <span>Libraries to include</span>
                  <em>{selectedSourceFolders.length} of {folders.length} selected · {selectedSourceTrackCount.toLocaleString()} tracks</em>
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

                <div className="device-source-library-actions">
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={loading || availableSourceFolders.length === 0}
                    title="Agregar biblioteca fuente"
                    aria-expanded={libraryPickerOpen}
                    onClick={() => setLibraryPickerOpen(open => !open)}
                  >
                    <Icon name="plus" size={13} /> Agregar biblioteca
                  </button>
                </div>

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
          PC -&gt; Device copia desde las bibliotecas agregadas a <code>{normalizedMusicRoot}</code>.
          {needsDestination && <> Device -&gt; PC importa a la raíz de <code>{destinationFolder ? folderLabel(destinationFolder) : '—'}</code>.</>}
        </div>
      </section>

      <section className="device-sync-stage device-sync-activity-tab">
        {activeProgress ? (
          <SyncCurrentRunPanel
            phase={activeProgress.phase}
            completed={progressCompleted}
            total={progressTotal}
            percent={progressPct}
            currentPath={activeProgressPath}
          />
        ) : (
          <SyncPlanPanel
            plan={visiblePlan}
            selection={currentPlanSelection}
            loading={loading}
            result={applyResult}
            applyBlockedReason={applyBlockedReason}
            canRecalculate={selectedDevice.isAvailable && configValid}
            base={syncBase}
            devicePlaylists={library?.playlists ?? []}
            pcPlaylists={pcPlaylists}
            onRecalculate={() => void buildPlan()}
            onClear={() => {
              clearPlan()
              setApplyResult(null)
              clearPlanSelection()
            }}
            onApply={() => void applyCurrentPlan()}
            onToggleAction={togglePlanAction}
            onToggleGroup={togglePlanGroup}
            onSelectAll={selectAllPlanActions}
            onClearSelection={clearPlanSelection}
            onResolveConflict={resolvePlanConflict}
            onSetBase={applyPlanBase}
          />
        )}
        <PendingJournalList
          journals={devicePendingJournals}
          loading={loading}
          onResume={journalId => void resumePendingJournal(journalId)}
          onDiscard={journalId => void discardJournal(journalId)}
        />
      </section>
    </div>
  )
}
