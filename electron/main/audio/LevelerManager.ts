// Volume leveler (loudness normalization / "Sound Check"). Holds the runtime
// config and the loaded track's loudness, and computes the linear gain the
// AudioEngine folds into the playback channel volume. Mirrors EQManager's
// singleton shape; the renderer is the source of truth for the config and pushes
// it in (config is persisted renderer-side, like the EQ panel state).
//
// This class deliberately knows nothing about the audio engine or the DB — the audio-channel
// resolves a track's loudness and feeds it in, then reads currentGainLinear() to
// drive the engine. Keeping it pure makes the gain math testable in isolation.

import {
  LEVELER_DEFAULTS,
  levelerGainDb,
  levelerGainLinear,
  normalizeLevelerConfig,
  type LevelerConfig,
  type LevelerLoudness,
} from '@shared/constants/leveler'

const NO_LOUDNESS: LevelerLoudness = { trackLufs: null, peakDb: null }

let manager: LevelerManager | null = null

export class LevelerManager {
  private config: LevelerConfig = { ...LEVELER_DEFAULTS }
  private loudness: LevelerLoudness = { ...NO_LOUDNESS }

  getConfig(): LevelerConfig {
    return { ...this.config }
  }

  // Merge a partial config patch from the renderer. Returns the normalized config.
  setConfig(patch: Partial<LevelerConfig>): LevelerConfig {
    this.config = normalizeLevelerConfig({ ...this.config, ...patch })
    return this.getConfig()
  }

  // Set the loudness of the currently loaded track (or clear it with null).
  setTrackLoudness(loudness: LevelerLoudness | null): void {
    this.loudness = loudness ? { trackLufs: loudness.trackLufs, peakDb: loudness.peakDb } : { ...NO_LOUDNESS }
  }

  clearTrackLoudness(): void {
    this.loudness = { ...NO_LOUDNESS }
  }

  // Gain (dB) currently applied; 0 when off or no loudness data. Display-only.
  currentGainDb(): number {
    return levelerGainDb(this.config, this.loudness)
  }

  // Linear channel-volume multiplier for the current track (1.0 = unchanged).
  currentGainLinear(): number {
    return levelerGainLinear(this.config, this.loudness)
  }
}

export function getLevelerManager(): LevelerManager {
  if (!manager) manager = new LevelerManager()
  return manager
}
