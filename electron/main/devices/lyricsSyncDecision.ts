import type { DeviceSyncMode } from '@shared/types/device-sync'

// Resolved state of a single track for the lyrics sync phase. Lyrics live only on
// disk now (the `.lrc` sidecar next to the audio, plus embedded tags as a read
// source), so the inputs are purely "does each side already have lyrics".
export interface LyricsSyncState {
  mode: DeviceSyncMode
  // Backward-compatible setting kept in persisted device config. Device sync no
  // longer performs online lyrics fetches; missing lyrics are copied only when
  // one side already has local content.
  fetchEnabled: boolean
  // True when the track exists on BOTH sides (the device audio file is present).
  // False for a PC-only track that is about to be copied to the device.
  isMatched: boolean
  // The PC library track already has lyrics on disk (a `.lrc` sidecar or an
  // embedded tag). Presence is the source of truth — and the overwrite guard:
  // a side that already has lyrics is never clobbered (this subsumes the old
  // user-edited protection).
  pcHasLrc: boolean
  // A `.lrc` sidecar exists next to the device audio file (only meaningful when matched).
  deviceHasLrc: boolean
}

// What the sync phase should do for one track. Mutually exclusive in practice
// (a track resolves to at most one propagation action plus an optional online
// fetch), but expressed as independent flags so the caller stays explicit.
export interface LyricsSyncDecision {
  // Write the device `.lrc` from the PC lyrics content (PC -> device propagation).
  writeDeviceSidecar: boolean
  // Read the device `.lrc` and import it into the PC sidecar (device -> PC).
  importToPc: boolean
  // Device sync never fetches missing lyrics online. Kept in the return shape so
  // older callers/tests can assert the disabled behavior explicitly.
  fetchOnline: boolean
  // Nothing to do for this track.
  skip: boolean
}

// Pure direction matrix for the lyrics sync phase. No I/O — the caller resolves
// `LyricsSyncState` from the filesystem and performs the chosen action.
//
// Direction semantics:
//   pc_to_device (push)      -> propagate PC -> device
//   device_to_pc (pull)      -> propagate device -> PC
//   bidirectional_safe       -> propagate both ways
// "Both sides already have lyrics" always resolves to skip (never clobber).
export function decideLyricsSync(state: LyricsSyncState): LyricsSyncDecision {
  const pushDir = state.mode === 'pc_to_device' || state.mode === 'bidirectional_safe'
  const pullDir = state.mode === 'device_to_pc' || state.mode === 'bidirectional_safe'

  const writeDeviceSidecar =
    pushDir && state.isMatched && state.pcHasLrc && !state.deviceHasLrc

  const importToPc =
    pullDir && state.isMatched && state.deviceHasLrc && !state.pcHasLrc

  const fetchOnline = false

  const skip = !writeDeviceSidecar && !importToPc && !fetchOnline
  return { writeDeviceSidecar, importToPc, fetchOnline, skip }
}
