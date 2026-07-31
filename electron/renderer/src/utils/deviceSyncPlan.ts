import type {
  DevicePlaylistSummary,
  DeviceSyncAction,
  DeviceSyncActionKind,
  DeviceSyncApplySelection,
  DeviceSyncBase,
  DeviceSyncConflictResolution,
  DeviceSyncPlan,
  DeviceSyncPlanSummary,
} from '@shared/types/device-sync'
import type { Playlist } from '@shared/types/library'

export type DeviceSyncPlanGroupBy = 'artist' | 'album' | 'playlist' | 'track'

export interface DeviceSyncActionGroup {
  id: string
  label: string
  detail: string
  actions: DeviceSyncAction[]
  bytes: number
}

export function defaultDeviceSyncSelection(plan: DeviceSyncPlan): DeviceSyncApplySelection {
  return {
    actionIds: plan.actions
      .filter(action => action.kind !== 'skip_conflict')
      .map(action => action.id),
    conflictResolutions: [],
  }
}

export function selectedActionIds(selection: DeviceSyncApplySelection | null | undefined): Set<string> {
  return new Set(selection?.actionIds ?? [])
}

export function conflictResolutionMap(
  selection: DeviceSyncApplySelection | null | undefined,
): Map<string, DeviceSyncActionKind> {
  return new Map(
    (selection?.conflictResolutions ?? [])
      .filter(item => item.kind !== 'skip_conflict')
      .map(item => [item.actionId, item.kind]),
  )
}

export function conflictResolutionOptions(action: DeviceSyncAction): DeviceSyncActionKind[] {
  const options: DeviceSyncActionKind[] = []
  if (action.pcPath && action.devicePath) {
    options.push('replace_device', 'replace_pc')
  } else if (action.pcPath && !action.devicePath) {
    options.push('copy_pc_to_device', 'delete_pc')
  } else if (!action.pcPath && action.devicePath) {
    options.push('copy_device_to_pc', 'delete_device')
  }
  options.push('skip_conflict')
  return options
}

export function actionKindForSelection(
  action: DeviceSyncAction,
  selection: DeviceSyncApplySelection | null | undefined,
): DeviceSyncActionKind | null {
  // A conflict resolution overrides the kind for ANY action, not just
  // skip_conflict ones — when the user flips a normal change to the other side
  // (e.g. "Usar PC" turns a pull into a device delete) the override carries the
  // real kind. Mirrors the backend's planForSelection.
  const override = conflictResolutionMap(selection).get(action.id)
  if (action.kind === 'skip_conflict') {
    return override ?? null
  }
  if (!selectedActionIds(selection).has(action.id)) return null
  return override ?? action.kind
}

function bytesForKind(action: DeviceSyncAction, kind: DeviceSyncActionKind): number {
  switch (kind) {
    case 'copy_pc_to_device':
    case 'replace_device':
      return action.pcBytes ?? action.bytes
    case 'copy_device_to_pc':
    case 'replace_pc':
      return action.deviceBytes ?? action.bytes
    case 'delete_device':
    case 'delete_pc':
    case 'skip_conflict':
      return 0
  }
}

export function summarizeDeviceSyncSelection(
  plan: DeviceSyncPlan,
  selection: DeviceSyncApplySelection | null | undefined,
): DeviceSyncPlanSummary {
  let pcAfter = plan.summary.pcBefore
  let deviceAfter = plan.summary.deviceBefore
  let bytesToCopy = 0
  const counts: Record<DeviceSyncActionKind, number> = {
    copy_pc_to_device: 0,
    copy_device_to_pc: 0,
    replace_device: 0,
    replace_pc: 0,
    delete_device: 0,
    delete_pc: 0,
    skip_conflict: 0,
  }

  for (const action of plan.actions) {
    const kind = actionKindForSelection(action, selection)
    if (!kind) {
      if (action.kind === 'skip_conflict') counts.skip_conflict += 1
      continue
    }

    counts[kind] += 1
    switch (kind) {
      case 'copy_pc_to_device':
        deviceAfter += 1
        bytesToCopy += bytesForKind(action, kind)
        break
      case 'copy_device_to_pc':
        pcAfter += 1
        bytesToCopy += bytesForKind(action, kind)
        break
      case 'replace_device':
      case 'replace_pc':
        bytesToCopy += bytesForKind(action, kind)
        break
      case 'delete_device':
        deviceAfter = Math.max(0, deviceAfter - 1)
        break
      case 'delete_pc':
        pcAfter = Math.max(0, pcAfter - 1)
        break
      case 'skip_conflict':
        break
    }
  }

  return {
    pcBefore: plan.summary.pcBefore,
    deviceBefore: plan.summary.deviceBefore,
    pcAfter,
    deviceAfter,
    copyPcToDevice: counts.copy_pc_to_device,
    copyDeviceToPc: counts.copy_device_to_pc,
    replaceDevice: counts.replace_device,
    replacePc: counts.replace_pc,
    deleteDevice: counts.delete_device,
    deletePc: counts.delete_pc,
    conflicts: counts.skip_conflict,
    bytesToCopy,
  }
}

function normalizeGroupId(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'other'
}

function playlistNamesForAction(
  action: DeviceSyncAction,
  pcPlaylists: Playlist[],
  devicePlaylists: DevicePlaylistSummary[],
): string[] {
  const names = new Set<string>()
  if (action.pcPath || action.pcRelativePath) {
    for (const playlist of pcPlaylists) {
      if (playlist.tracks.some(track =>
        (action.pcPath && track.path === action.pcPath) ||
        (action.pcRelativePath && track.filename === action.pcRelativePath)
      )) {
        names.add(playlist.name)
      }
    }
  }
  if (action.deviceRelativePath || action.key) {
    for (const playlist of devicePlaylists) {
      if (playlist.tracks.some(track =>
        track.key === action.key ||
        (action.deviceRelativePath && track.relativePath === action.deviceRelativePath)
      )) {
        names.add(playlist.name)
      }
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

export function groupDeviceSyncActions(
  actions: DeviceSyncAction[],
  groupBy: DeviceSyncPlanGroupBy,
  pcPlaylists: Playlist[] = [],
  devicePlaylists: DevicePlaylistSummary[] = [],
): DeviceSyncActionGroup[] {
  const groups = new Map<string, DeviceSyncActionGroup>()

  for (const action of actions) {
    const playlistNames = groupBy === 'playlist'
      ? playlistNamesForAction(action, pcPlaylists, devicePlaylists)
      : []
    const label =
      groupBy === 'artist'
        ? action.artist || 'Unknown Artist'
        : groupBy === 'album'
          ? action.album || 'Unknown Album'
          : groupBy === 'playlist'
            ? playlistNames[0] ?? 'Sin playlist'
            : action.title || action.relativePath
    const detail =
      groupBy === 'track'
        ? [action.artist, action.album].filter(Boolean).join(' - ') || action.relativePath
        : groupBy === 'playlist' && playlistNames.length > 1
          ? `${playlistNames.length} playlists`
          : `${action.artist || 'Unknown Artist'} - ${action.album || 'Unknown Album'}`
    const id = `${groupBy}:${normalizeGroupId(label)}`
    const group = groups.get(id) ?? {
      id,
      label,
      detail,
      actions: [],
      bytes: 0,
    }
    group.actions.push(action)
    group.bytes += Math.max(action.pcBytes ?? action.deviceBytes ?? action.bytes ?? 0, 0)
    groups.set(id, group)
  }

  return [...groups.values()].sort((a, b) =>
    groupBy === 'artist'
      ? a.label.localeCompare(b.label)
      : b.actions.length - a.actions.length || a.label.localeCompare(b.label),
  )
}

export function selectionPayload(
  actionIds: Set<string>,
  conflictResolutions: Record<string, DeviceSyncActionKind>,
): DeviceSyncApplySelection {
  const resolutions: DeviceSyncConflictResolution[] = Object.entries(conflictResolutions)
    .filter(([, kind]) => kind !== 'skip_conflict')
    .map(([actionId, kind]) => ({ actionId, kind }))
  return {
    actionIds: [...actionIds],
    conflictResolutions: resolutions,
  }
}

// Which side is treated as the source of truth when bulk-resolving a plan.
// 'review' leaves the engine's per-action defaults untouched (conflicts stay
// unresolved); 'pc'/'device' mirror every difference toward that side.
// Canonical definition lives in @shared/types/device-sync; re-exported here for
// the existing renderer imports.
export type { DeviceSyncBase }

// The action kind that makes the *other* side match `base`, given which paths
// the action touches. Mirrors the valid kinds from conflictResolutionOptions:
//   both paths  -> replace the loser
//   pc only     -> copy to device (pc base) / delete the pc file (device base)
//   device only -> delete the device file (pc base) / pull to pc (device base)
export function preferredKindForBase(
  action: DeviceSyncAction,
  base: 'pc' | 'device',
): DeviceSyncActionKind | null {
  const hasPc = Boolean(action.pcPath)
  const hasDevice = Boolean(action.devicePath)
  if (hasPc && hasDevice) return base === 'pc' ? 'replace_device' : 'replace_pc'
  if (hasPc) return base === 'pc' ? 'copy_pc_to_device' : 'delete_pc'
  if (hasDevice) return base === 'pc' ? 'delete_device' : 'copy_device_to_pc'
  return null
}

// Bulk-resolve an entire plan toward one base, producing the same
// { actionIds, conflictResolutions } shape the UI keeps in state and feeds to
// selectionPayload. 'review' returns the engine defaults (all non-conflict
// actions selected, conflicts left for manual resolution). Per-action overrides
// are applied on top of this result by the caller.
export function bulkResolveSelection(
  plan: DeviceSyncPlan,
  base: DeviceSyncBase,
): { actionIds: Set<string>; conflictResolutions: Record<string, DeviceSyncActionKind> } {
  if (base === 'review') {
    return {
      actionIds: new Set(defaultDeviceSyncSelection(plan).actionIds ?? []),
      conflictResolutions: {},
    }
  }

  const actionIds = new Set<string>()
  const conflictResolutions: Record<string, DeviceSyncActionKind> = {}
  for (const action of plan.actions) {
    const kind = preferredKindForBase(action, base)
    if (!kind) continue
    actionIds.add(action.id)
    // A resolution entry is only needed when we override the engine's natural
    // kind, or when the action is an unresolved conflict.
    if (action.kind === 'skip_conflict' || kind !== action.kind) {
      conflictResolutions[action.id] = kind
    }
  }
  return { actionIds, conflictResolutions }
}

// The per-action winning side the wizard tracks: keep PC's copy, keep the
// device's (MP3) copy, or skip the change entirely. This is the single source of
// truth the new sync UI mutates (global / per-artist / per-album / per-track);
// the apply payload is derived from it via buildSelectionFromSides.
export type DeviceSyncActionSide = 'pc' | 'device' | 'omit'

// The side that "wins" under the engine's natural default kind. By construction
// preferredKindForBase(action, naturalSideForAction(action)) === action.kind for
// every non-conflict action, so seeding from 'review' reproduces the engine
// defaults. Conflicts have no natural winner and start omitted.
export function naturalSideForAction(action: DeviceSyncAction): DeviceSyncActionSide {
  switch (action.kind) {
    case 'copy_pc_to_device':
    case 'replace_device':
    case 'delete_device':
      return 'pc'
    case 'copy_device_to_pc':
    case 'replace_pc':
    case 'delete_pc':
      return 'device'
    case 'skip_conflict':
      return 'omit'
  }
}

// Initial per-action side map for a freshly loaded plan, derived from the
// device's persisted base. 'pc'/'device' mirror everything toward that side
// (mirrors bulkResolveSelection); 'review' uses each action's natural winner and
// leaves conflicts omitted (mirrors defaultDeviceSyncSelection).
export function seedActionSides(
  plan: DeviceSyncPlan,
  base: DeviceSyncBase,
): Record<string, DeviceSyncActionSide> {
  const sides: Record<string, DeviceSyncActionSide> = {}
  for (const action of plan.actions) {
    if (base === 'pc' || base === 'device') {
      sides[action.id] = preferredKindForBase(action, base) ? base : 'omit'
    } else {
      sides[action.id] = naturalSideForAction(action)
    }
  }
  return sides
}

// Derive the apply payload from the per-action side choices. Produces the exact
// same { actionIds, conflictResolutions } shape the old toggle-based UI fed to
// applyPlan, so the IPC contract is unchanged. Actions without an explicit side
// fall back to their natural winner.
export function buildSelectionFromSides(
  plan: DeviceSyncPlan,
  actionSides: Record<string, DeviceSyncActionSide>,
): DeviceSyncApplySelection {
  const actionIds = new Set<string>()
  const conflictResolutions: Record<string, DeviceSyncActionKind> = {}
  for (const action of plan.actions) {
    const side = actionSides[action.id] ?? naturalSideForAction(action)
    if (side === 'omit') continue
    const kind = preferredKindForBase(action, side)
    if (!kind) continue
    actionIds.add(action.id)
    if (action.kind === 'skip_conflict' || kind !== action.kind) {
      conflictResolutions[action.id] = kind
    }
  }
  return selectionPayload(actionIds, conflictResolutions)
}

// Split actions into the columns of the diff view by which side currently holds
// the file. An action that touches both sides (replace/conflict) appears in
// both columns; the side choice resolves which copy wins.
export function partitionActionsBySide(actions: DeviceSyncAction[]): {
  pc: DeviceSyncAction[]
  device: DeviceSyncAction[]
} {
  const pc: DeviceSyncAction[] = []
  const device: DeviceSyncAction[] = []
  for (const action of actions) {
    if (action.pcPath != null) pc.push(action)
    if (action.devicePath != null) device.push(action)
  }
  return { pc, device }
}
