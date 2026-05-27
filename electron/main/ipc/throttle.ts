import { broadcast } from './events'

export interface ThrottledBroadcaster {
  emit(channel: string, force: boolean, payload: unknown, minMs?: number): void
  reset(channel?: string): void
}

// Per-channel throttle for high-frequency IPC pushes (scan/sync/import progress,
// FFT frames). Pass force=true on terminal frames so the renderer doesn't miss
// the final state when the last update arrives inside the throttle window.
export function createThrottledBroadcaster(defaultMinMs = 80): ThrottledBroadcaster {
  const lastEmitAt = new Map<string, number>()
  return {
    emit(channel, force, payload, minMs = defaultMinMs) {
      const now = Date.now()
      const last = lastEmitAt.get(channel) ?? 0
      if (!force && now - last < minMs) return
      lastEmitAt.set(channel, now)
      broadcast(channel, payload)
    },
    reset(channel) {
      if (channel === undefined) lastEmitAt.clear()
      else lastEmitAt.delete(channel)
    },
  }
}
