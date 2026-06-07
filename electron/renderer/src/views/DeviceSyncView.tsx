import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '@renderer/components/Icon'
import { useActivityCenterStore } from '@renderer/stores/activityCenterStore'
import {
  useDeviceArtworkAnalysis,
  useDeviceLibrary,
  useDeviceStore,
  useSelectedDevice,
} from '@renderer/stores/deviceStore'
import { useFolders } from '@renderer/stores/libraryStore'
import { DEVICE_ARTWORK_EDGE_MAX, DEVICE_ARTWORK_EDGE_MIN } from '@shared/constants/device-sync'
import { fmtFileSize } from '@renderer/utils/format'
import { artworkOptimizationOwnsSyncProgress } from '@renderer/utils/artworkProgressOwnership'
import { artworkOptimizeActionState } from '@renderer/utils/artworkOptimizeAction'
import {
  filterArtworkItemsForSearch,
  groupArtworkItems,
  selectedArtworkItemsFromGroup,
  selectedArtworkItemsForSearch,
  shouldShowArtworkSearchResults,
  type ArtworkOptimizeGroup,
  type ArtworkOptimizeViewMode,
} from '@renderer/utils/artworkOptimizeSelection'
import { basenameForPath, isValidDeviceMusicRoot, normalizeDeviceMusicRoot } from '@renderer/utils/devicePaths'
import {
  actionKindForSelection,
  buildSelectionFromSides,
  groupDeviceSyncActions,
  naturalSideForAction,
  partitionActionsBySide,
  seedActionSides,
  summarizeDeviceSyncSelection,
  type DeviceSyncActionSide,
  type DeviceSyncBase,
  type DeviceSyncPlanGroupBy,
} from '@renderer/utils/deviceSyncPlan'
import type { DbFolder } from '@shared/types/db'
import type {
  DeviceArtworkAnalysisItem,
  DevicePendingJournal,
  DeviceSyncAction,
  DeviceSyncActionKind,
  DeviceSyncApplyResult,
  DeviceSyncApplySelection,
  DeviceSyncMode,
  DeviceSyncPlan,
  DeviceArtworkOptimizationSummary,
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
    description: 'Copia cambios nuevos de ambos lados; en la pestaña «Sincronización» elegís desde qué lado tomar las diferencias.',
  },
]

const SYNC_BASES: Array<{ value: DeviceSyncBase; label: string }> = [
  { value: 'pc', label: 'Preferir PC' },
  { value: 'device', label: 'Preferir dispositivo' },
  { value: 'review', label: 'Revisar c/u' },
]

function formatArtworkOptimizationSummary(summary: DeviceArtworkOptimizationSummary): string {
  if (summary.optimized === 0) return 'No se optimizaron carátulas.'
  if (summary.bytesSaved <= 0) {
    return `Se optimizaron ${summary.optimized} carátulas sin ahorro adicional.`
  }
  return `Se optimizaron ${summary.optimized} carátulas y se ahorraron ${fmtFileSize(summary.bytesSaved)}.`
}

function formatArtworkVerificationMessage(summary: DeviceArtworkOptimizationSummary, stillOversized: number | null): string {
  const base = formatArtworkOptimizationSummary(summary)
  if (stillOversized == null) return base
  if (stillOversized > 0) {
    return `${base} ${stillOversized} temas optimizados siguen superando el límite y vuelven a aparecer en el listado.`
  }
  return `${base} Verificado: los temas optimizados ya no superan el límite.`
}

// Persisted conflict base selector. Lives in the Configuración tab (only for
// bidirectional sync) — the chosen side wins when a track changed on both.
function SyncBaseSelector({
  base,
  disabled,
  onSetBase,
}: {
  base: DeviceSyncBase
  disabled: boolean
  onSetBase: (base: DeviceSyncBase) => void
}) {
  return (
    <div className="device-plan-base-question" role="radiogroup" aria-label="Lado base para resolver las diferencias">
      <div className="device-plan-base-question-head">
        <Icon name="sync" size={14} />
        <div>
          <strong>¿Desde qué lado tomar las diferencias?</strong>
          <em>En sync dual, si un tema cambió en ambos lados se conserva la versión del lado elegido. «Revisar c/u» decide tema por tema.</em>
        </div>
      </div>
      <div className="device-plan-base-options">
        {SYNC_BASES.map(item => (
          <button
            key={item.value}
            className={base === item.value ? 'active' : ''}
            type="button"
            role="radio"
            aria-checked={base === item.value}
            disabled={disabled}
            onClick={() => onSetBase(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  )
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

const ARTWORK_PHASE_LABELS: Record<string, string> = {
  scanning: 'Buscando temas',
  reading: 'Analizando artwork',
  complete: 'Completado',
}

const ARTWORK_REFRESH_PHASE_LABELS: Record<string, string> = {
  scanning: 'Actualizando listado',
  reading: 'Reanalizando artwork',
  complete: 'Listado actualizado',
}

const ARTWORK_VIEW_MODES: Array<{ value: ArtworkOptimizeViewMode; label: string }> = [
  { value: 'artist', label: 'Artistas' },
  { value: 'album', label: 'Álbumes' },
]

// Readable "qué tema y de/hacia qué lado" line for the live sync run (Paso 3).
const SYNC_DIRECTION_LABELS: Record<DeviceSyncActionKind, string> = {
  copy_pc_to_device: 'Copiando al MP3',
  replace_device: 'Actualizando en MP3',
  copy_device_to_pc: 'Trayendo a la PC',
  replace_pc: 'Actualizando en PC',
  delete_device: 'Eliminando del MP3',
  delete_pc: 'Eliminando de la PC',
  skip_conflict: 'Omitiendo',
}

function syncRunLine(
  kind: DeviceSyncActionKind | undefined,
  title: string | undefined,
  path: string | null,
): string | null {
  if (kind && title) return `${SYNC_DIRECTION_LABELS[kind]} · ${title}`
  return path
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
  currentTitle,
  currentKind,
}: {
  phase: string
  completed: number
  total: number
  percent: number
  currentPath: string | null
  currentTitle?: string
  currentKind?: DeviceSyncActionKind
}) {
  const line = syncRunLine(currentKind, currentTitle, currentPath)
  return (
    <section className="device-side-card device-sync-run-card">
      <div className="device-card-head">
        <div>
          <h2>Sincronizando…</h2>
          <span>No desconectes el dispositivo hasta que termine.</span>
        </div>
        <strong>{progressText(completed, total)}</strong>
      </div>
      <div className="device-sync-run-status">
        <span>{SYNC_PHASE_LABELS[phase] ?? phase}</span>
        <div className="device-progress-track" aria-label="Sync progress">
          <b style={{ width: `${percent}%` }} />
        </div>
        {line && <em title={currentPath ?? undefined}>{line}</em>}
      </div>
    </section>
  )
}

// ── Sync wizard (Sincronización tab) ────────────────────────────────────────
// Three steps: 1) Diferencias (two columns PC|MP3, choose the winning side per
// global/artist/album/track), 2) Resultado (how each library ends up), 3)
// Sincronizar (confirm + live progress). The parent owns the per-action side
// map; these components are presentational.

type WizardStep = 'diff' | 'result' | 'apply'

const WIZARD_STEPS: Array<{ key: WizardStep; label: string }> = [
  { key: 'diff', label: 'Diferencias' },
  { key: 'result', label: 'Resultado' },
  { key: 'apply', label: 'Sincronizar' },
]

function SyncWizardStepper({
  current,
  disabled,
  onStep,
}: {
  current: WizardStep
  disabled: boolean
  onStep: (step: WizardStep) => void
}) {
  return (
    <div className="device-sync-steps" role="tablist" aria-label="Pasos de la sincronización">
      {WIZARD_STEPS.map((step, index) => (
        <button
          key={step.key}
          type="button"
          role="tab"
          aria-selected={current === step.key}
          className={`device-sync-step ${current === step.key ? 'active' : ''}`}
          disabled={disabled}
          onClick={() => onStep(step.key)}
        >
          <b>{index + 1}</b>
          <span>{step.label}</span>
        </button>
      ))}
    </div>
  )
}

const SIDE_OPTIONS: Array<{ side: DeviceSyncActionSide; label: string; title: string }> = [
  { side: 'pc', label: 'PC', title: 'Usar la versión de la PC' },
  { side: 'device', label: 'MP3', title: 'Usar la versión del MP3' },
  { side: 'omit', label: '–', title: 'Omitir este tema' },
]

function SideToggle({
  value,
  disabled,
  onPick,
}: {
  value: DeviceSyncActionSide
  disabled: boolean
  onPick: (side: DeviceSyncActionSide) => void
}) {
  return (
    <span className="device-side-toggle" role="radiogroup" aria-label="Lado ganador">
      {SIDE_OPTIONS.map(option => (
        <button
          key={option.side}
          type="button"
          role="radio"
          aria-checked={value === option.side}
          className={value === option.side ? 'active' : ''}
          title={option.title}
          disabled={disabled}
          onClick={() => onPick(option.side)}
        >
          {option.label}
        </button>
      ))}
    </span>
  )
}

// One side of the diff view. Lists the actions that touch this side, grouped by
// artist/album, each row choosing which copy wins.
function SyncDiffColumn({
  side,
  title,
  actions,
  actionSides,
  groupBy,
  loading,
  onSetSide,
}: {
  side: 'pc' | 'device'
  title: string
  actions: DeviceSyncAction[]
  actionSides: Record<string, DeviceSyncActionSide>
  groupBy: DeviceSyncPlanGroupBy
  loading: boolean
  onSetSide: (actionIds: string[], side: DeviceSyncActionSide) => void
}) {
  const groups = useMemo(() => groupDeviceSyncActions(actions, groupBy), [actions, groupBy])
  const allIds = useMemo(() => actions.map(action => action.id), [actions])
  return (
    <section className={`device-sync-side ${side}`}>
      <header className="device-sync-side-head">
        <div>
          <strong>{title}</strong>
          <em>{actions.length} {actions.length === 1 ? 'diferencia' : 'diferencias'}</em>
        </div>
        <button
          className="btn ghost"
          type="button"
          disabled={loading || actions.length === 0}
          onClick={() => onSetSide(allIds, side)}
        >
          {side === 'pc' ? 'Usar PC' : 'Usar MP3'}
        </button>
      </header>
      <div className="device-sync-side-groups">
        {groups.length === 0 ? (
          <div className="device-empty compact">Sin diferencias de este lado.</div>
        ) : groups.map(group => (
          <section className="device-side-group" key={group.id}>
            <div className="device-side-group-head">
              <span>
                <strong>{group.label}</strong>
                <em>{group.actions.length} · {fmtFileSize(group.bytes)}</em>
              </span>
              <span className="device-side-group-actions">
                <button type="button" disabled={loading} onClick={() => onSetSide(group.actions.map(a => a.id), 'pc')}>PC</button>
                <button type="button" disabled={loading} onClick={() => onSetSide(group.actions.map(a => a.id), 'device')}>MP3</button>
              </span>
            </div>
            <div className="device-side-action-list">
              {group.actions.map(action => {
                const onOtherSide = side === 'pc' ? action.devicePath != null : action.pcPath != null
                const value = actionSides[action.id] ?? naturalSideForAction(action)
                return (
                  <div className="device-side-action" key={action.id}>
                    <span className="device-side-action-main">
                      <strong>{action.title}</strong>
                      <em title={action.relativePath}>
                        {action.artist || 'Unknown Artist'} · {action.album || 'Unknown Album'}
                      </em>
                    </span>
                    <span className={`device-side-badge ${onOtherSide ? 'is-diff' : 'is-only'}`}>
                      {onOtherSide ? 'Difiere' : side === 'pc' ? 'Falta en MP3' : 'Falta en PC'}
                    </span>
                    <SideToggle value={value} disabled={loading} onPick={next => onSetSide([action.id], next)} />
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </section>
  )
}

function SyncDiffStep({
  plan,
  actionSides,
  groupBy,
  loading,
  deviceName,
  onSetSide,
  onSetGroupBy,
  onGlobalBase,
}: {
  plan: DeviceSyncPlan
  actionSides: Record<string, DeviceSyncActionSide>
  groupBy: DeviceSyncPlanGroupBy
  loading: boolean
  deviceName: string
  onSetSide: (actionIds: string[], side: DeviceSyncActionSide) => void
  onSetGroupBy: (groupBy: DeviceSyncPlanGroupBy) => void
  onGlobalBase: (base: DeviceSyncBase) => void
}) {
  const { pc, device } = useMemo(() => partitionActionsBySide(plan.actions), [plan.actions])
  return (
    <div className="device-sync-diff">
      <div className="device-sync-diff-toolbar">
        <div className="device-side-global" role="group" aria-label="Elegir lado para todo">
          <span>Para todo:</span>
          <button className="btn ghost" type="button" disabled={loading} onClick={() => onGlobalBase('pc')}>Tomar todo de PC</button>
          <button className="btn ghost" type="button" disabled={loading} onClick={() => onGlobalBase('device')}>Tomar todo de MP3</button>
          <button className="btn ghost" type="button" disabled={loading} onClick={() => onGlobalBase('review')}>Revisar</button>
        </div>
        <div className="device-subtabs" role="tablist" aria-label="Agrupar por">
          {(['artist', 'album'] as DeviceSyncPlanGroupBy[]).map(item => (
            <button
              key={item}
              type="button"
              className={`device-section-tab ${groupBy === item ? 'active' : ''}`}
              onClick={() => onSetGroupBy(item)}
            >
              {item === 'artist' ? 'Artista' : 'Álbum'}
            </button>
          ))}
        </div>
      </div>
      {plan.actions.length === 0 ? (
        <div className="device-empty compact">Las bibliotecas ya están sincronizadas.</div>
      ) : (
        <div className="device-sync-columns">
          <SyncDiffColumn side="pc" title="PC" actions={pc} actionSides={actionSides} groupBy={groupBy} loading={loading} onSetSide={onSetSide} />
          <SyncDiffColumn side="device" title={deviceName || 'MP3'} actions={device} actionSides={actionSides} groupBy={groupBy} loading={loading} onSetSide={onSetSide} />
        </div>
      )}
    </div>
  )
}

const RESULT_BADGES: Record<DeviceSyncActionKind, { label: string; cls: string } | null> = {
  copy_pc_to_device: { label: '+ nuevo', cls: 'is-new' },
  copy_device_to_pc: { label: '+ nuevo', cls: 'is-new' },
  replace_device: { label: '↻ actualiza', cls: 'is-diff' },
  replace_pc: { label: '↻ actualiza', cls: 'is-diff' },
  delete_device: { label: '− quita', cls: 'is-remove' },
  delete_pc: { label: '− quita', cls: 'is-remove' },
  skip_conflict: null,
}

// One side of the result view: how this library ends up, with a badge marking
// what gets copied in or removed.
function SyncResultColumn({
  title,
  before,
  after,
  actions,
  selection,
  groupBy,
}: {
  title: string
  before: number
  after: number
  actions: DeviceSyncAction[]
  selection: DeviceSyncApplySelection | null
  groupBy: DeviceSyncPlanGroupBy
}) {
  const groups = useMemo(() => groupDeviceSyncActions(actions, groupBy), [actions, groupBy])
  const net = after - before
  return (
    <section className="device-sync-side result">
      <header className="device-sync-side-head">
        <div>
          <strong>{title}</strong>
          <em>{before} → {after} temas</em>
        </div>
        <span className={`device-side-net ${net >= 0 ? 'positive' : 'negative'}`}>{net >= 0 ? '+' : ''}{net}</span>
      </header>
      <div className="device-sync-side-groups">
        {actions.length === 0 ? (
          <div className="device-empty compact">Esta biblioteca no cambia.</div>
        ) : groups.map(group => (
          <section className="device-side-group" key={group.id}>
            <div className="device-side-group-head">
              <span><strong>{group.label}</strong><em>{group.actions.length}</em></span>
            </div>
            <div className="device-side-action-list">
              {group.actions.map(action => {
                const kind = actionKindForSelection(action, selection)
                const badge = kind ? RESULT_BADGES[kind] : null
                return (
                  <div className="device-side-action" key={action.id}>
                    <span className="device-side-action-main">
                      <strong>{action.title}</strong>
                      <em title={action.relativePath}>
                        {action.artist || 'Unknown Artist'} · {action.album || 'Unknown Album'}
                      </em>
                    </span>
                    {badge && <span className={`device-side-badge ${badge.cls}`}>{badge.label}</span>}
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </section>
  )
}

function SyncResultStep({
  plan,
  selection,
  groupBy,
  deviceName,
}: {
  plan: DeviceSyncPlan
  selection: DeviceSyncApplySelection | null
  groupBy: DeviceSyncPlanGroupBy
  deviceName: string
}) {
  const summary = useMemo(() => summarizeDeviceSyncSelection(plan, selection), [plan, selection])
  const { pcActions, deviceActions } = useMemo(() => {
    const pcActions: DeviceSyncAction[] = []
    const deviceActions: DeviceSyncAction[] = []
    for (const action of plan.actions) {
      const kind = actionKindForSelection(action, selection)
      if (kind === 'copy_device_to_pc' || kind === 'replace_pc' || kind === 'delete_pc') pcActions.push(action)
      if (kind === 'copy_pc_to_device' || kind === 'replace_device' || kind === 'delete_device') deviceActions.push(action)
    }
    return { pcActions, deviceActions }
  }, [plan.actions, selection])
  return (
    <div className="device-sync-result">
      <div className="device-sync-result-summary">
        Se copiarán <strong>{fmtFileSize(summary.bytesToCopy)}</strong> en total.
      </div>
      <div className="device-sync-columns">
        <SyncResultColumn title="Biblioteca PC" before={summary.pcBefore} after={summary.pcAfter} actions={pcActions} selection={selection} groupBy={groupBy} />
        <SyncResultColumn title={deviceName || 'MP3'} before={summary.deviceBefore} after={summary.deviceAfter} actions={deviceActions} selection={selection} groupBy={groupBy} />
      </div>
    </div>
  )
}

// Step 3 before confirming: the final summary + the big apply button. The live
// progress bar (SyncCurrentRunPanel) takes over while the sync runs.
function SyncConfirmStep({
  plan,
  selection,
  loading,
  applyBlockedReason,
  result,
  onApply,
}: {
  plan: DeviceSyncPlan
  selection: DeviceSyncApplySelection | null
  loading: boolean
  applyBlockedReason: string | null
  result: DeviceSyncApplyResult | null
  onApply: () => void
}) {
  const summary = useMemo(() => summarizeDeviceSyncSelection(plan, selection), [plan, selection])
  const toDevice = summary.copyPcToDevice + summary.replaceDevice
  const toPc = summary.copyDeviceToPc + summary.replacePc
  const removed = summary.deleteDevice + summary.deletePc
  const executable = toDevice + toPc + removed
  const canApply = executable > 0
  return (
    <section className="device-side-card device-sync-confirm">
      <div className="device-card-head">
        <div>
          <h2>Confirmar sincronización</h2>
          <span>Revisá el resumen y aplicá los cambios.</span>
        </div>
      </div>
      <div className="device-confirm-stats">
        <div><b className="mono">{toDevice}</b><span>Al MP3</span></div>
        <div><b className="mono">{toPc}</b><span>A la PC</span></div>
        <div><b className="mono">{removed}</b><span>Se eliminan</span></div>
        <div><b className="mono">{fmtFileSize(summary.bytesToCopy)}</b><span>A copiar</span></div>
      </div>
      {applyBlockedReason && <div className="device-warning inline">{applyBlockedReason}</div>}
      {result && (
        <div className={result.failed.length > 0 ? 'device-error inline' : 'sync-result-ok inline'}>
          {result.failed.length > 0
            ? `${result.failed.length} operaciones fallaron. ${result.failed[0]?.error ?? ''}`
            : `Se aplicaron ${result.applied} operaciones. ${formatArtworkOptimizationSummary(result.artwork)}`}
        </div>
      )}
      <div className="device-plan-actions">
        <button
          className="btn primary"
          type="button"
          disabled={loading || !canApply || result != null || applyBlockedReason != null}
          onClick={onApply}
        >
          <Icon name="sync" size={13} /> Sincronizar ahora
        </button>
      </div>
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

function ArtworkOversizedList({
  items,
  maxEdge,
  selectedKeys,
  selectionEnabled,
  onToggleSelected,
}: {
  items: DeviceArtworkAnalysisItem[]
  maxEdge: number
  selectedKeys: ReadonlySet<string>
  selectionEnabled: boolean
  onToggleSelected(item: DeviceArtworkAnalysisItem, selected: boolean): void
}) {
  if (items.length === 0) {
    return (
      <div className="device-empty">
        No hay temas para mostrar con el filtro actual ({maxEdge}px).
      </div>
    )
  }
  return (
    <div className="device-artwork-table">
      <div className="device-artwork-row head">
        <span className="device-artwork-select">Sel.</span>
        <span>Tema</span>
        <span>Artista</span>
        <span>Álbum</span>
        <span>Formato</span>
        <span className="device-artwork-res">Resolución</span>
      </div>
      {items.slice(0, 500).map(item => (
        <div className="device-artwork-row" key={item.key}>
          <span className="device-artwork-select">
            <input
              type="checkbox"
              checked={selectedKeys.has(item.key)}
              disabled={!selectionEnabled}
              aria-label={`Optimizar ${item.title || item.relativePath}`}
              onChange={event => onToggleSelected(item, event.target.checked)}
            />
          </span>
          <span className="device-track-title" title={item.relativePath}>{item.title}</span>
          <span>{item.artist || 'Unknown Artist'}</span>
          <span>{item.album || 'Unknown Album'}</span>
          <span className="device-artwork-format">{item.format ? item.format.toUpperCase() : '—'}</span>
          <span className="device-artwork-res mono">
            {item.width != null && item.height != null ? `${item.width}×${item.height}` : '—'}
            <em> &gt; {maxEdge}px</em>
          </span>
        </div>
      ))}
      {items.length > 500 && (
        <div className="device-empty compact">{items.length - 500} temas más ocultos</div>
      )}
    </div>
  )
}

function ArtworkGroupedList({
  groups,
  maxEdge,
  viewMode,
  onSelectGroup,
}: {
  groups: ArtworkOptimizeGroup[]
  maxEdge: number
  viewMode: ArtworkOptimizeViewMode
  onSelectGroup(group: ArtworkOptimizeGroup): void
}) {
  if (groups.length === 0) {
    return (
      <div className="device-empty">
        Ningún tema supera el límite del dispositivo ({maxEdge}px).
      </div>
    )
  }

  return (
    <div className="device-artwork-table device-artwork-group-table">
      <div className="device-artwork-group-row head">
        <span>{viewMode === 'artist' ? 'Artista' : 'Álbum'}</span>
        <span>{viewMode === 'artist' ? 'Álbumes' : 'Artista'}</span>
        <span>Temas</span>
        <span className="device-artwork-res">Máx. resolución</span>
      </div>
      {groups.slice(0, 500).map(group => (
        <button
          className="device-artwork-group-row"
          key={group.key}
          type="button"
          aria-label={`Mostrar ${group.itemCount} temas afectados de ${group.title}`}
          onClick={() => onSelectGroup(group)}
        >
          <span className="device-track-title" title={group.title}>{group.title}</span>
          <span>{group.subtitle}</span>
          <span className="mono">{group.itemCount}</span>
          <span className="device-artwork-res mono">
            {group.maxWidth != null && group.maxHeight != null ? `${group.maxWidth}×${group.maxHeight}` : '—'}
            <em> &gt; {maxEdge}px</em>
          </span>
        </button>
      ))}
      {groups.length > 500 && (
        <div className="device-empty compact">{groups.length - 500} grupos más ocultos</div>
      )}
    </div>
  )
}

function ArtworkOptimizePanel({
  deviceId,
  artworkMaxEdge,
  onProgressOwnedChange,
}: {
  deviceId: string
  artworkMaxEdge: number
  onProgressOwnedChange: (owned: boolean) => void
}) {
  const analyzeArtwork = useDeviceStore(s => s.analyzeArtwork)
  const optimizeArtwork = useDeviceStore(s => s.optimizeArtwork)
  const progress = useDeviceStore(s => s.artworkAnalyzeProgress)
  const syncProgress = useDeviceStore(s => s.syncProgress)
  const analysis = useDeviceArtworkAnalysis(deviceId)
  const [analyzing, setAnalyzing] = useState(false)
  const [optimizing, setOptimizing] = useState(false)
  const [refreshingAfterOptimize, setRefreshingAfterOptimize] = useState(false)
  const [optimizeResult, setOptimizeResult] = useState<DeviceArtworkOptimizationSummary | null>(null)
  const [optimizedStillOversized, setOptimizedStillOversized] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [artworkQuery, setArtworkQuery] = useState('')
  const [artworkViewMode, setArtworkViewMode] = useState<ArtworkOptimizeViewMode>('artist')
  const [focusedArtworkGroupKey, setFocusedArtworkGroupKey] = useState<string | null>(null)
  const [excludedArtworkKeys, setExcludedArtworkKeys] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    setExcludedArtworkKeys(new Set())
  }, [analysis?.analyzedAt, artworkQuery, artworkViewMode, focusedArtworkGroupKey])

  const analysisItems = analysis?.items ?? []
  const searchActive = shouldShowArtworkSearchResults(artworkQuery)
  const artworkGroups = useMemo(
    () => groupArtworkItems(analysisItems, artworkViewMode),
    [analysisItems, artworkViewMode],
  )
  const focusedArtworkGroup = useMemo(
    () => focusedArtworkGroupKey
      ? artworkGroups.find(group => group.key === focusedArtworkGroupKey) ?? null
      : null,
    [artworkGroups, focusedArtworkGroupKey],
  )
  const selectionEnabled = searchActive || Boolean(focusedArtworkGroup)
  const visibleArtworkItems = useMemo(
    () => {
      if (searchActive) return filterArtworkItemsForSearch(analysisItems, artworkQuery, 'all')
      return focusedArtworkGroup?.items ?? []
    },
    [analysisItems, artworkQuery, focusedArtworkGroup, searchActive],
  )
  const selectedArtworkItems = useMemo(
    () => searchActive
      ? selectedArtworkItemsForSearch({
          items: analysisItems,
          query: artworkQuery,
          scope: 'all',
          excludedKeys: excludedArtworkKeys,
        })
      : selectedArtworkItemsFromGroup(focusedArtworkGroup, excludedArtworkKeys),
    [analysisItems, artworkQuery, excludedArtworkKeys, focusedArtworkGroup, searchActive],
  )
  const selectedArtworkKeys = useMemo(
    () => new Set(selectedArtworkItems.map(item => item.key)),
    [selectedArtworkItems],
  )
  const toggleArtworkSelection = useCallback((item: DeviceArtworkAnalysisItem, selected: boolean) => {
    if (!selectionEnabled) return
    setExcludedArtworkKeys(current => {
      const next = new Set(current)
      if (selected) {
        next.delete(item.key)
      } else {
        next.add(item.key)
      }
      return next
    })
  }, [selectionEnabled])
  const updateArtworkQuery = useCallback((value: string) => {
    setArtworkQuery(value)
    setFocusedArtworkGroupKey(null)
  }, [])
  const updateArtworkViewMode = useCallback((mode: ArtworkOptimizeViewMode) => {
    setArtworkViewMode(mode)
    setFocusedArtworkGroupKey(null)
  }, [])
  const showArtworkGroup = useCallback((group: ArtworkOptimizeGroup) => {
    setArtworkQuery('')
    setFocusedArtworkGroupKey(group.key)
  }, [])
  const clearFocusedArtworkGroup = useCallback(() => {
    setFocusedArtworkGroupKey(null)
  }, [])

  const runAnalysis = useCallback(async () => {
    setAnalyzing(true)
    setError(null)
    try {
      await analyzeArtwork(deviceId)
      setOptimizeResult(null)
      setOptimizedStillOversized(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setAnalyzing(false)
    }
  }, [analyzeArtwork, deviceId])

  const runOptimization = useCallback(async () => {
    if (selectedArtworkItems.length === 0) return
    const optimizedRelativePaths = selectedArtworkItems.map(item => item.relativePath)
    setOptimizing(true)
    setRefreshingAfterOptimize(false)
    setError(null)
    setOptimizeResult(null)
    setOptimizedStillOversized(null)
    try {
      const result = await optimizeArtwork(deviceId, {
        relativePaths: optimizedRelativePaths,
      })
      setOptimizeResult(result)
      setOptimizing(false)
      setRefreshingAfterOptimize(true)
      const refreshedAnalysis = await analyzeArtwork(deviceId)
      const optimizedPathSet = new Set(optimizedRelativePaths)
      const stillOversizedCount = refreshedAnalysis.items.filter(item => optimizedPathSet.has(item.relativePath)).length
      setOptimizedStillOversized(stillOversizedCount)
      setArtworkQuery('')
      setFocusedArtworkGroupKey(null)
      setExcludedArtworkKeys(new Set())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setOptimizing(false)
      setRefreshingAfterOptimize(false)
    }
  }, [analyzeArtwork, deviceId, optimizeArtwork, selectedArtworkItems])

  const artworkProgressActive = analyzing || refreshingAfterOptimize
  const artworkBusy = analyzing || optimizing || refreshingAfterOptimize
  const ownsHeaderProgress = artworkOptimizationOwnsSyncProgress({
    optimizing,
    deviceId,
    syncProgressDeviceId: syncProgress?.deviceId,
    syncProgressPhase: syncProgress?.phase,
  })
  const activeProgress = artworkProgressActive ? progress : optimizing && syncProgress?.deviceId === deviceId ? syncProgress : null
  const activeCompleted = activeProgress
    ? 'scanned' in activeProgress
      ? activeProgress.scanned
      : activeProgress.completed
    : 0
  const activeTotal = activeProgress?.total ?? 0
  const pct = activeProgress && activeTotal > 0
    ? Math.min(100, Math.round((activeCompleted / activeTotal) * 100))
    : 0
  const summary = analysis?.summary
  const action = artworkOptimizeActionState({
    analyzing,
    optimizing,
    refreshing: refreshingAfterOptimize,
    hasAnalysis: Boolean(analysis),
    oversizedCount: summary?.oversized ?? 0,
    selectedCount: selectedArtworkItems.length,
  })
  const progressLabel = refreshingAfterOptimize
    ? ARTWORK_REFRESH_PHASE_LABELS[progress?.phase ?? 'scanning'] ?? 'Actualizando listado'
    : analyzing
      ? ARTWORK_PHASE_LABELS[progress?.phase ?? 'scanning'] ?? 'Analizando artwork'
      : SYNC_PHASE_LABELS[syncProgress?.phase ?? 'optimizing_artwork'] ?? 'Optimizando artwork'
  const runPrimaryAction = action.mode === 'apply' ? runOptimization : runAnalysis

  useEffect(() => {
    onProgressOwnedChange(ownsHeaderProgress)
    return () => onProgressOwnedChange(false)
  }, [onProgressOwnedChange, ownsHeaderProgress])

  return (
    <section className="device-sync-stage device-sync-activity-tab device-artwork-optimize">
      <div className="device-card-head compact">
        <div>
          <h2>Optimizar artwork</h2>
          <span>
            Analiza los temas que ya están en el dispositivo y lista los artwork mayores al
            límite de <strong>{artworkMaxEdge}px</strong> antes de aplicar la optimización.
          </span>
        </div>
        <div className="device-plan-actions inline">
          <button
            className={`btn ${action.primary ? 'primary' : ''}`}
            type="button"
            onClick={runPrimaryAction}
            disabled={action.disabled}
          >
            <Icon name={action.icon} size={13} /> {action.label}
          </button>
        </div>
      </div>

      {error && <div className="device-error inline">{error}</div>}

      {artworkBusy && (
        <div className="device-sync-inline-progress">
          <span>
            {progressLabel}
            {activeProgress ? ` · ${activeCompleted}/${activeTotal}` : ''}
          </span>
          <div className="device-progress-track" aria-hidden="true">
            <b style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {!artworkBusy && optimizeResult && (
        <div className={optimizeResult.failed > 0 || optimizedStillOversized == null || optimizedStillOversized > 0 ? 'device-warning inline' : 'sync-result-ok inline'}>
          {optimizeResult.failed > 0
            ? `${optimizeResult.failed} carátulas fallaron. Se optimizaron ${optimizeResult.optimized}.`
            : formatArtworkVerificationMessage(optimizeResult, optimizedStillOversized)}
        </div>
      )}

      {!artworkBusy && analysis && summary && (
        <>
          <div className="device-artwork-summary">
            <div className="device-artwork-stat oversized">
              <b className="mono">{summary.oversized}</b>
              <span>Superan el límite</span>
            </div>
            <div className="device-artwork-stat">
              <b className="mono">{summary.withinLimit}</b>
              <span>Dentro del límite</span>
            </div>
            <div className="device-artwork-stat">
              <b className="mono">{summary.noArtwork}</b>
              <span>Sin artwork</span>
            </div>
            <div className="device-artwork-stat">
              <b className="mono">{summary.scanned}</b>
              <span>Analizados</span>
            </div>
          </div>
          {(summary.unsupported > 0 || summary.errors > 0) && (
            <div className="device-library-note">
              {summary.unsupported > 0 && <>{summary.unsupported} con formato de imagen no soportado. </>}
              {summary.errors > 0 && <>{summary.errors} no se pudieron leer.</>}
            </div>
          )}
          {analysis.items.length > 0 && (
            <div className="device-artwork-filter">
              <div className={`device-artwork-search ${selectionEnabled ? 'is-active' : ''}`}>
                <Icon name="search" size={13} />
                <input
                  value={artworkQuery}
                  placeholder="Buscar para seleccionar"
                  aria-label="Buscar artwork por artista o track"
                  onChange={event => updateArtworkQuery(event.target.value)}
                />
                {artworkQuery && (
                  <button
                    type="button"
                    aria-label="Limpiar búsqueda de artwork"
                    onClick={() => updateArtworkQuery('')}
                  >
                    <Icon name="close" size={12} />
                  </button>
                )}
              </div>
              <div className="device-artwork-scope" role="group" aria-label="Vista de artwork">
                {ARTWORK_VIEW_MODES.map(mode => (
                  <button
                    key={mode.value}
                    type="button"
                    className={artworkViewMode === mode.value ? 'active' : ''}
                    onClick={() => updateArtworkViewMode(mode.value)}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
              <div className="device-artwork-selected">
                <b className="mono">{selectedArtworkItems.length}</b>
                <span>
                  seleccionados
                  {searchActive
                    ? ` · ${visibleArtworkItems.length} resultados`
                    : focusedArtworkGroup
                      ? ` · ${focusedArtworkGroup.title}`
                    : ` · ${artworkGroups.length} ${artworkViewMode === 'artist' ? 'artistas' : 'álbumes'}`}
                </span>
              </div>
            </div>
          )}
          {analysis.items.length > 0 && !selectionEnabled && (
            <div className="device-library-note">
              Con el buscador vacío no se optimiza nada. Elegí un artista o álbum para revisar sus temas, o buscá para seleccionar resultados.
            </div>
          )}
          {focusedArtworkGroup && !searchActive && (
            <div className="device-artwork-focus">
              <div>
                <strong>{focusedArtworkGroup.title}</strong>
                <span>{focusedArtworkGroup.itemCount} temas afectados</span>
              </div>
              <button className="btn ghost sm" type="button" onClick={clearFocusedArtworkGroup}>
                Volver a {artworkViewMode === 'artist' ? 'artistas' : 'álbumes'}
              </button>
            </div>
          )}
          {selectionEnabled ? (
            <ArtworkOversizedList
              items={visibleArtworkItems}
              maxEdge={analysis.artworkMaxEdge}
              selectedKeys={selectedArtworkKeys}
              selectionEnabled={selectionEnabled}
              onToggleSelected={toggleArtworkSelection}
            />
          ) : (
            <ArtworkGroupedList
              groups={artworkGroups}
              maxEdge={analysis.artworkMaxEdge}
              viewMode={artworkViewMode}
              onSelectGroup={showArtworkGroup}
            />
          )}
        </>
      )}

      {!artworkBusy && !analysis && (
        <div className="device-empty">
          Tocá «Analizar artwork» para revisar los temas del dispositivo.
        </div>
      )}
    </section>
  )
}

// Sub-tabs inside the Sync section. Rendered as the navbar's second row (in
// App.tsx) so the active sub-view is driven from the top chrome.
export type DeviceSyncTab = 'sync' | 'optimize' | 'config'

export function DeviceSyncView({
  deviceId,
  syncTab,
  onSyncTabChange,
}: {
  deviceId: string
  syncTab: DeviceSyncTab
  onSyncTabChange: (tab: DeviceSyncTab) => void
}) {
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
  const resolveDeviceSyncDiscarded = useActivityCenterStore(s => s.resolveDeviceSyncDiscarded)
  const updateSettings = useDeviceStore(s => s.updateSettings)
  const clearPlan = useDeviceStore(s => s.clearPlan)
  const selectedDevice = useSelectedDevice()
  const selectDevice = useDeviceStore(s => s.selectDevice)
  const folders = useFolders()

  const [mode, setMode] = useState<DeviceSyncMode>('bidirectional_safe')
  const [musicRoot, setMusicRoot] = useState('')
  const [artworkMaxEdge, setArtworkMaxEdge] = useState('')
  const [sourceLibraryIds, setSourceLibraryIds] = useState<number[]>([])
  const [destinationFolderId, setDestinationFolderId] = useState<number | null>(null)
  const [libraryPickerOpen, setLibraryPickerOpen] = useState(false)
  const [pathError, setPathError] = useState<string | null>(null)
  const [applyResult, setApplyResult] = useState<DeviceSyncApplyResult | null>(null)
  const [planRequestedFullSync, setPlanRequestedFullSync] = useState(false)
  // Per-action winning side the wizard mutates (global / artist / album / track).
  // The apply payload is derived from this via buildSelectionFromSides.
  const [actionSides, setActionSides] = useState<Record<string, DeviceSyncActionSide>>({})
  const [wizardStep, setWizardStep] = useState<WizardStep>('diff')
  const [planGroupBy, setPlanGroupBy] = useState<DeviceSyncPlanGroupBy>('artist')
  const [applying, setApplying] = useState(false)
  const [artworkProgressOwnedByPanel, setArtworkProgressOwnedByPanel] = useState(false)
  // Conflict base is a persisted per-device setting (Configuración tab), not
  // ephemeral UI state — it's remembered across sessions.
  const syncBase: DeviceSyncBase = selectedDevice?.syncBase ?? 'review'

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

  useEffect(() => {
    if (!selectedDevice?.id) return
    setPlanRequestedFullSync(false)
  }, [selectedDevice?.id])

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
    () => visiblePlan ? buildSelectionFromSides(visiblePlan, actionSides) : null,
    [actionSides, visiblePlan],
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
  const headerProgress = artworkProgressOwnedByPanel ? null : activeProgress

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
  const activeSyncModeLabel = selectedDevice?.lastSyncAt && !planRequestedFullSync
    ? 'Sync incremental'
    : 'Resync completo'
  const lastSyncLabel = selectedDevice?.lastSyncAt ? formatDate(selectedDevice.lastSyncAt) : 'No registrado'

  // Keep the destination pointing at an included library.
  useEffect(() => {
    if (destinationFolderId != null && selectedSourceFolders.some(folder => folder.id === destinationFolderId)) return
    setDestinationFolderId(selectedSourceFolders[0]?.id ?? null)
  }, [selectedSourceFolders, destinationFolderId])

  useEffect(() => {
    if (!visiblePlan) {
      setActionSides({})
      return
    }
    // Seed the per-action side choices from the persisted base so a new plan
    // already reflects the device's remembered preference. Reset to step 1.
    setActionSides(seedActionSides(visiblePlan, syncBase))
    setWizardStep('diff')
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const indexBlocked = visiblePlan?.deviceIndexWarning ?? null
  const applyBlockedReason = portableBlocked ?? destinationBlocked ?? indexBlocked

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

  const buildPlan = useCallback(async (fullSync = false) => {
    if (!selectedDevice || !configValid) return
    setApplyResult(null)
    setPlanRequestedFullSync(fullSync)
    await planSync(mode, planPcTargetPath || selectedDevice.pcTargetPath, fullSync)
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

  // Set the winning side for a set of actions (one track, a group, or a whole
  // column). The apply payload re-derives from actionSides automatically.
  const setSideForActions = useCallback((actionIds: string[], side: DeviceSyncActionSide) => {
    if (actionIds.length === 0) return
    setActionSides(current => {
      const next = { ...current }
      for (const id of actionIds) next[id] = side
      return next
    })
  }, [])

  // Diff-step "Para todo" controls: re-seed every action toward a base for this
  // session (does not persist the device preference).
  const applyGlobalBase = useCallback((base: DeviceSyncBase) => {
    if (!visiblePlan) return
    setActionSides(seedActionSides(visiblePlan, base))
  }, [visiblePlan])

  // Configuración tab base selector: persist the preference and re-seed the wizard.
  const applyPlanBase = useCallback((base: DeviceSyncBase) => {
    if (!selectedDevice) return
    void updateSettings(selectedDevice.id, { syncBase: base })
    if (!visiblePlan) return
    setActionSides(seedActionSides(visiblePlan, base))
  }, [selectedDevice, updateSettings, visiblePlan])

  const applyCurrentPlan = useCallback(async () => {
    if (!visiblePlan || applyBlockedReason) return
    if (!devices.some(device => device.id === visiblePlan.deviceId)) {
      setPathError('El dispositivo asociado a este plan ya no está conectado.')
      clearPlan()
      return
    }
    setApplying(true)
    setWizardStep('apply')
    try {
      const result = await applyPlan(visiblePlan.id, currentPlanSelection ?? undefined)
      setApplyResult(result)
      await scan(visiblePlan.deviceId)
    } finally {
      setApplying(false)
    }
  }, [visiblePlan, applyBlockedReason, devices, applyPlan, currentPlanSelection, scan, clearPlan])

  const resumePendingJournal = useCallback(async (journalId: string) => {
    const result = await resumeJournal(journalId)
    if (!devices.some(device => device.id === result.deviceId)) {
      setPathError('El dispositivo asociado al journal ya no está conectado.')
      return
    }
    await scan(result.deviceId)
  }, [devices, resumeJournal, scan])

  const discardPendingJournal = useCallback(async (journalId: string) => {
    const journal = pendingJournals.find(item => item.id === journalId) ?? null
    await discardJournal(journalId)
    if (journal) resolveDeviceSyncDiscarded(journal.planId)
  }, [discardJournal, pendingJournals, resolveDeviceSyncDiscarded])

  const isSyncRun = activeProgress === syncProgress
  const activeProgressPath = isSyncRun ? syncProgress?.currentPath ?? null : null
  const activeProgressTitle = isSyncRun ? syncProgress?.currentTitle : undefined
  const activeProgressKind = isSyncRun ? syncProgress?.currentKind : undefined
  // "Is a sync actively running for this device?" — derived from the store so it
  // survives this component unmounting/remounting (the sync keeps going in main),
  // unlike the local `applying` flag which resets to false on remount.
  const syncRunning = isSyncRun && activeProgress != null
  // Editing the plan / recalculating stays locked for the whole run, even after a
  // remount where `applying` would have been lost.
  const busy = applying || syncRunning
  // Artwork-only optimization reports through the sync progress channel, but it
  // should not lock diff review controls.
  const planEditingLocked = applying || (syncRunning && activeProgress?.phase !== 'optimizing_artwork')

  // Coming back to the sync screen while a sync is still running lands on the live
  // progress step instead of the editable diff (which looked like a cancelled sync).
  // Only fires on the rising edge, so the user can still browse diff/result mid-sync.
  useEffect(() => {
    if (syncRunning) setWizardStep('apply')
  }, [syncRunning])

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
        <p title={selectedDevice.rootPath}>{selectedDevice.rootPath} · {stats.trackCount.toLocaleString()} temas indexados</p>
        <p>Última sync: {lastSyncLabel} · {activeSyncModeLabel}</p>
        {headerProgress && (
          <div className="device-sync-inline-progress">
            <span>{SYNC_PHASE_LABELS[headerProgress.phase] ?? headerProgress.phase} · {progressText(progressCompleted, progressTotal)}</span>
            <div className="device-progress-track" aria-hidden="true">
              <b style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        )}
      </header>

      {syncTab === 'optimize' && (
        <ArtworkOptimizePanel
          deviceId={selectedDevice.id}
          artworkMaxEdge={selectedDevice.artworkMaxEdge}
          onProgressOwnedChange={setArtworkProgressOwnedByPanel}
        />
      )}

      {syncTab === 'config' && (
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

            {mode === 'bidirectional_safe' && (
              <SyncBaseSelector base={syncBase} disabled={loading} onSetBase={applyPlanBase} />
            )}

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
            </div>
          </div>

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
            <div className="device-library-note compact">
              Las letras quedan locales a la biblioteca y al reproductor. Device Sync no copia ni descarga letras.
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
      )}

      {syncTab === 'sync' && (
      <section className="device-sync-stage device-sync-activity-tab">
        {!configValid ? (
          <div className="device-warning inline device-sync-config-cta">
            <span>Completá la configuración para calcular los cambios a sincronizar.</span>
            <button className="btn" type="button" onClick={() => onSyncTabChange('config')}>
              <Icon name="sliders" size={13} /> Ir a Configuración
            </button>
          </div>
        ) : !visiblePlan ? (
          <section className="device-side-card">
            <div className="device-card-head">
              <div>
                <h2>Cambios a sincronizar</h2>
                <span>Calculando las diferencias del dispositivo…</span>
              </div>
              <button className="btn" type="button" disabled={loading || !selectedDevice.isAvailable} onClick={() => void buildPlan(false)}>
                <Icon name="rotate" size={12} /> Recalcular
              </button>
              <button
                className="btn ghost"
                type="button"
                disabled={loading || !selectedDevice.isAvailable}
                onClick={() => void buildPlan(true)}
              >
                <Icon name="sync" size={12} /> Resync completo
              </button>
            </div>
            <div className="device-empty compact">{loading ? 'Calculando cambios…' : 'No hay cambios calculados todavía.'}</div>
          </section>
        ) : (
          <div className="device-sync-wizard">
            <div className="device-sync-wizard-head">
              <SyncWizardStepper current={wizardStep} disabled={false} onStep={setWizardStep} />
              <button
                className="btn ghost"
                type="button"
                disabled={loading || busy || !selectedDevice.isAvailable}
                onClick={() => void buildPlan(false)}
              >
                <Icon name="rotate" size={12} /> Recalcular
              </button>
              <button
                className="btn ghost"
                type="button"
                disabled={loading || busy || !selectedDevice.isAvailable}
                onClick={() => void buildPlan(true)}
              >
                <Icon name="sync" size={12} /> Resync completo
              </button>
            </div>

            {wizardStep === 'diff' && (
              <SyncDiffStep
                plan={visiblePlan}
                actionSides={actionSides}
                groupBy={planGroupBy}
                loading={planEditingLocked}
                deviceName={selectedDevice.name}
                onSetSide={setSideForActions}
                onSetGroupBy={setPlanGroupBy}
                onGlobalBase={applyGlobalBase}
              />
            )}
            {wizardStep === 'result' && (
              <SyncResultStep
                plan={visiblePlan}
                selection={currentPlanSelection}
                groupBy={planGroupBy}
                deviceName={selectedDevice.name}
              />
            )}
            {wizardStep === 'apply' && (
              activeProgress && isSyncRun ? (
                <SyncCurrentRunPanel
                  phase={activeProgress.phase}
                  completed={progressCompleted}
                  total={progressTotal}
                  percent={progressPct}
                  currentPath={activeProgressPath}
                  currentTitle={activeProgressTitle}
                  currentKind={activeProgressKind}
                />
              ) : (
                <SyncConfirmStep
                  plan={visiblePlan}
                  selection={currentPlanSelection}
                  loading={loading}
                  applyBlockedReason={applyBlockedReason}
                  result={applyResult}
                  onApply={() => void applyCurrentPlan()}
                />
              )
            )}

            {/* The live-progress panel owns the screen while a sync runs; Atrás/Cerrar
                make no sense there (navigation is via the stepper tabs above). */}
            {!(wizardStep === 'apply' && syncRunning) && (
              <div className="device-sync-wizard-nav">
                <button
                  className="btn ghost"
                  type="button"
                  disabled={wizardStep === 'diff'}
                  onClick={() => setWizardStep(wizardStep === 'apply' ? 'result' : 'diff')}
                >
                  <Icon name="back" size={13} /> Atrás
                </button>
                {wizardStep === 'apply' ? (
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={applying}
                    onClick={() => {
                      clearPlan()
                      setApplyResult(null)
                      setActionSides({})
                      setWizardStep('diff')
                    }}
                  >
                    Cerrar
                  </button>
                ) : (
                  <button
                    className="btn primary"
                    type="button"
                    onClick={() => setWizardStep(wizardStep === 'diff' ? 'result' : 'apply')}
                  >
                    Siguiente <Icon name="fwd" size={13} />
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {/* Mientras una sync corre, el journal en disco sigue con status 'running' y
            aparecería como "Sync interrumpida" al lado del progreso en vivo. Ocultar la
            lista durante la corrida; al terminar, un journal realmente pendiente/fallido
            vuelve a mostrarse. */}
        {!busy && (
          <PendingJournalList
            journals={devicePendingJournals}
            loading={loading}
            onResume={journalId => void resumePendingJournal(journalId)}
            onDiscard={journalId => void discardPendingJournal(journalId)}
          />
        )}
      </section>
      )}
    </div>
  )
}
