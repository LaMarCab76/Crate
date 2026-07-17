export function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  const x = Math.floor(s % 60)
  return `${m}:${x.toString().padStart(2, '0')}`
}

export interface PlaybackTimePair {
  elapsedSec: number
  remainingSec: number
  elapsedText: string
  remainingText: string
}

function wholeSeconds(s: number): number {
  return Number.isFinite(s) ? Math.max(0, Math.floor(s)) : 0
}

export function formatPlaybackTimePair(positionSec: number, durationSec: number): PlaybackTimePair {
  const durationWholeSec = wholeSeconds(durationSec)
  const positionWholeSec = wholeSeconds(positionSec)
  const elapsedSec = durationWholeSec > 0
    ? Math.min(positionWholeSec, durationWholeSec)
    : positionWholeSec
  const remainingSec = durationWholeSec > 0
    ? Math.max(0, durationWholeSec - elapsedSec)
    : 0

  return {
    elapsedSec,
    remainingSec,
    elapsedText: fmtTime(elapsedSec),
    remainingText: fmtTime(remainingSec),
  }
}
