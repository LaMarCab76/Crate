import type { CloudTrackRef } from '../cloud/cloudTrackRef'

export interface ExclusivePlaybackSnapshot {
  path: string | null
  positionSec: number
  estimatedDurationSec: number | null
  wasPlaying: boolean
  volume: number
  cloudRef: CloudTrackRef | null
  cloudSizeBytes: number | null
}

interface PlaybackRestoreEngine {
  load(path: string, options?: {
    estimatedDurationSec?: number | null
    cloudRef?: CloudTrackRef
    cloudSizeBytes?: number | null
  }): Promise<unknown>
  setVolume(value: number): void
  getCurrentStream(): number
  seek(positionSec: number): void
  play(): void
}

/** Rebuild playback after a BASS reinit without treating cloud IDs as files. */
export async function restoreExclusivePlaybackSnapshot(
  engine: PlaybackRestoreEngine,
  snapshot: ExclusivePlaybackSnapshot,
  reapplyEffects: (stream: number) => void,
): Promise<void> {
  if (!snapshot.path) return
  if (snapshot.path.startsWith('onedrive://') && (!snapshot.cloudRef || snapshot.cloudSizeBytes == null)) {
    throw new Error('Cannot restore a OneDrive track without its cloud reference and size')
  }

  await engine.load(snapshot.path, {
    estimatedDurationSec: snapshot.estimatedDurationSec,
    cloudRef: snapshot.cloudRef ?? undefined,
    cloudSizeBytes: snapshot.cloudSizeBytes,
  })
  engine.setVolume(snapshot.volume)
  reapplyEffects(engine.getCurrentStream())
  if (snapshot.positionSec > 0) engine.seek(snapshot.positionSec)
  if (snapshot.wasPlaying) engine.play()
}
