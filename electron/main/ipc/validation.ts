// Runtime guards for values arriving over IPC. TypeScript types vanish at the
// process boundary, so every id/array/string from the renderer is treated as
// unknown and validated here before it reaches the DB or the filesystem.

/** Assert an IPC arg is a positive-integer id; throw otherwise (rejects the invoke). */
export function assertId(value: unknown, label = 'id'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label}: ${String(value)}`)
  }
  return value
}

/** Keep only unique positive-integer ids from an unknown IPC array arg. */
export function sanitizeIds(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id): id is number => Number.isInteger(id) && (id as number) > 0))]
}

/** Assert an IPC arg is a non-empty string; throw otherwise. */
export function assertNonEmptyString(value: unknown, label = 'value'): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}
