export const DEVICE_ARTWORK_EDGE_DEFAULT = 600
export const DEVICE_ARTWORK_EDGE_MIN = 64
export const DEVICE_ARTWORK_EDGE_MAX = 4096

export function clampDeviceArtworkEdge(
  value: unknown,
  fallback = DEVICE_ARTWORK_EDGE_DEFAULT,
): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value.trim())
      : Number.NaN

  if (!Number.isFinite(parsed)) return fallback
  return Math.min(
    DEVICE_ARTWORK_EDGE_MAX,
    Math.max(DEVICE_ARTWORK_EDGE_MIN, Math.round(parsed)),
  )
}
