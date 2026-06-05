import type {
  DeviceSyncAction,
  DeviceSyncActionKind,
  DeviceSyncMode,
  DeviceTrack,
  PcTrack,
} from '@shared/types/device-sync'

export interface TrackAlbumMoveRow {
  id: string
  track_id: number
  old_path: string
  new_path: string
  old_sync_key: string
  old_device_relative_path: string
  new_sync_key: string
  new_device_relative_path: string
  created_at: string
}

export interface AlbumMoveActionFactory {
  (
    kind: DeviceSyncActionKind,
    key: string,
    pc: PcTrack | undefined,
    device: DeviceTrack | undefined,
    reason: string,
  ): DeviceSyncAction
}

export function applyPendingTrackAlbumMovesToPlan(args: {
  actions: DeviceSyncAction[]
  mode: DeviceSyncMode
  pcTracks: PcTrack[]
  deviceTracks: DeviceTrack[]
  moves: TrackAlbumMoveRow[]
  makeAction: AlbumMoveActionFactory
}): DeviceSyncAction[] {
  if (args.mode === 'device_to_pc' || args.moves.length === 0) return args.actions
  const pcByTrackId = new Map(args.pcTracks.map(track => [track.trackId, track]))
  const deviceByKey = new Map(args.deviceTracks.map(track => [track.key, track]))
  const next = [...args.actions]

  const removeActionByKey = (key: string) => {
    const index = next.findIndex(action => action.key === key)
    if (index >= 0) next.splice(index, 1)
  }

  for (const move of args.moves) {
    const pc = pcByTrackId.get(move.track_id)
    const oldDevice = deviceByKey.get(move.old_sync_key)
    const newDevice = pc ? deviceByKey.get(pc.key) : deviceByKey.get(move.new_sync_key)
    if (!pc && !oldDevice) continue

    if (oldDevice) {
      removeActionByKey(move.old_sync_key)
      next.push(args.makeAction(
        'delete_device',
        move.old_sync_key,
        undefined,
        oldDevice,
        'Moved locally to another album',
      ))
    }

    if (pc) {
      removeActionByKey(pc.key)
      if (!newDevice) {
        next.push(args.makeAction(
          'copy_pc_to_device',
          pc.key,
          pc,
          undefined,
          'Moved locally to another album',
        ))
      } else if (pc.fingerprint !== newDevice.fingerprint) {
        next.push(args.makeAction(
          'replace_device',
          pc.key,
          pc,
          newDevice,
          'Moved locally to another album',
        ))
      }
    }
  }

  return next.sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.kind.localeCompare(b.kind))
}
