export const UP_NEXT_TOAST_START_SEC_DEFAULT = 30
export const UP_NEXT_TOAST_END_SEC_DEFAULT = 1
export const UP_NEXT_TOAST_START_SEC_MIN = 3
export const UP_NEXT_TOAST_START_SEC_MAX = 120
export const UP_NEXT_TOAST_END_SEC_MIN = 0

export interface UpNextToastWindow {
  upNextToastStartSec: number
  upNextToastEndSec: number
}

interface UpNextToastVisibilityInput {
  enabled?: boolean
  hasTrack: boolean
  hasUpNext: boolean
  status: 'playing' | string
  durationSec: number
  remainingSec: number
  startSec: number
  endSec: number
}

function finiteNumber(value: unknown, fallback: number): number {
  const next = Number(value)
  return Number.isFinite(next) ? next : fallback
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const next = Math.floor(finiteNumber(value, fallback))
  return Math.min(max, Math.max(min, next))
}

export function normalizeUpNextToastWindow(startSec: unknown, endSec: unknown): UpNextToastWindow {
  const upNextToastStartSec = clampInt(
    startSec,
    UP_NEXT_TOAST_START_SEC_MIN,
    UP_NEXT_TOAST_START_SEC_MAX,
    UP_NEXT_TOAST_START_SEC_DEFAULT,
  )
  const upNextToastEndSec = clampInt(
    endSec,
    UP_NEXT_TOAST_END_SEC_MIN,
    Math.max(UP_NEXT_TOAST_END_SEC_MIN, upNextToastStartSec - 1),
    UP_NEXT_TOAST_END_SEC_DEFAULT,
  )
  return { upNextToastStartSec, upNextToastEndSec }
}

export function shouldShowUpNextToast(input: UpNextToastVisibilityInput): boolean {
  if (input.enabled === false) return false
  if (!input.hasTrack || !input.hasUpNext) return false
  if (input.status !== 'playing') return false
  if (!Number.isFinite(input.durationSec) || input.durationSec <= 0) return false
  if (!Number.isFinite(input.remainingSec) || input.remainingSec <= 0) return false

  const { upNextToastStartSec, upNextToastEndSec } = normalizeUpNextToastWindow(input.startSec, input.endSec)
  return input.remainingSec <= upNextToastStartSec && input.remainingSec >= upNextToastEndSec
}
