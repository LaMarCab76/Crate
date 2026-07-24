import type { DuplicateSegment } from '@shared/types/duplicates'

export interface ComparableSegmentPlayback {
  leftStartSec: number
  rightStartSec: number
  durationSec: number
}

/** Restrict A/B playback to the common part that physically exists in both
 * streams. The shift keeps the two starts aligned when persisted metadata has
 * a small negative boundary caused by fingerprint delay/rounding. */
export function comparableSegmentPlayback(
  segment: Pick<DuplicateSegment, 'startSec' | 'endSec' | 'leftStartSec' | 'rightStartSec'>,
  leftDurationSec: number,
  rightDurationSec: number,
): ComparableSegmentPlayback | null {
  if (segment.leftStartSec == null || segment.rightStartSec == null) return null
  if (![segment.startSec, segment.endSec, segment.leftStartSec, segment.rightStartSec, leftDurationSec, rightDurationSec]
    .every(Number.isFinite)) return null
  const shiftSec = Math.max(0, -segment.leftStartSec, -segment.rightStartSec)
  const leftStartSec = segment.leftStartSec + shiftSec
  const rightStartSec = segment.rightStartSec + shiftSec
  const durationSec = Math.min(
    segment.endSec - segment.startSec - shiftSec,
    leftDurationSec - leftStartSec,
    rightDurationSec - rightStartSec,
  )
  if (durationSec <= 0) return null
  return { leftStartSec, rightStartSec, durationSec }
}
