export interface TrackTransitionVolumeOptions {
  fromVolume: number
  targetVolume: number
  durationMs: number
  token: number
  isTokenValid?: (token: number) => boolean
  stepMs?: number
  restoreVolume?: number
  setVolume: (volume: number) => Promise<void> | void
}

function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 0
  if (volume < 0) return 0
  if (volume > 1) return 1
  return volume
}

function parseStepMs(stepMs: number | undefined): number {
  const value = stepMs ?? 16
  if (!Number.isFinite(value) || value <= 0) return 16
  return Math.min(33, Math.max(16, value))
}

function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => {
    if (typeof window === 'undefined') {
      setTimeout(() => resolve(), ms)
      return
    }
    window.setTimeout(() => resolve(), ms)
  })
}

export async function fadeTrackVolume(options: TrackTransitionVolumeOptions): Promise<void> {
  const {
    fromVolume,
    targetVolume,
    durationMs,
    token,
    stepMs = 16,
    restoreVolume,
    setVolume,
  } = options

  const from = clampVolume(fromVolume)
  const target = clampVolume(targetVolume)
  const fallback = clampVolume(restoreVolume ?? target)
  const step = parseStepMs(stepMs)
  const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0

  const volume = (v: number) => setVolume(clampVolume(v))

  const restore = async (): Promise<void> => {
    try {
      await volume(fallback)
    } catch {
      // keep fallback silent: restore best-effort
    }
  }

  if (duration === 0 || from === target) {
    await volume(target)
    return
  }

  const startedAt = performance.now()

  try {
    while (true) {
      const active = options.isTokenValid?.(token) ?? true
      if (!active) {
        await restore()
        return
      }

      const elapsed = performance.now() - startedAt
      const ratio = Math.min(1, elapsed / duration)
      const currentVolume = from + (target - from) * ratio
      await volume(currentVolume)

      if (ratio >= 1) {
        await volume(target)
        return
      }

      await waitMs(step)
    }
  } catch (error) {
    await restore()
    throw error
  }
}
