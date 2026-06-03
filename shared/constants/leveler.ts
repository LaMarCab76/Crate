// Volume leveler ("Sound Check" / nivelador de volumen). A loudness normalizer
// that applies a per-track gain so every song plays at a consistent perceived
// level. The gain is folded into the playback channel volume in the main-process
// AudioEngine; this module holds the pure config + math so it stays unit-testable
// and shared between main and renderer.
//
// Loudness is expressed in LUFS (EBU R128 / ITU-R BS.1770). ReplayGain 2.0 uses a
// -18 LUFS reference, which is also our default target.

export const RG_REFERENCE_LUFS = -18

export interface LevelerConfig {
  // Master on/off for the leveler.
  enabled: boolean
  // Loudness all tracks are normalized toward, in LUFS. Lower = quieter/more
  // headroom, higher = louder. Clamped to [LEVELER_TARGET_MIN, LEVELER_TARGET_MAX].
  targetLufs: number
  // When true, the boost applied to a quiet track is capped so its true peak
  // stays below 0 dBFS (minus a small headroom), avoiding clipping.
  preventClipping: boolean
}

// Per-track loudness measurements the gain calculation consumes. Any field may be
// null when the data is unavailable (untagged track, analysis not yet computed).
export interface LevelerLoudness {
  // Integrated loudness in LUFS (from a ReplayGain/R128 tag, or estimated from
  // the playback analysis). Null → the track is left unchanged.
  trackLufs: number | null
  // True-peak in dBFS (negative). Used only for clip prevention.
  peakDb: number | null
}

export const LEVELER_TARGET_MIN = -30
export const LEVELER_TARGET_MAX = -6
export const LEVELER_TARGET_STEP = 1

// Hard limit on how much the leveler may push a track up or down. Keeps a badly
// tagged or wildly quiet track from exploding to full scale.
export const LEVELER_MAX_GAIN_DB = 15
// Headroom kept below 0 dBFS when clip prevention caps a boost.
export const LEVELER_CLIP_HEADROOM_DB = 0.5

export const LEVELER_DEFAULTS: LevelerConfig = {
  enabled: false,
  targetLufs: RG_REFERENCE_LUFS,
  preventClipping: true,
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function clampTargetLufs(target: number | undefined): number {
  const n = Number(target)
  if (!Number.isFinite(n)) return LEVELER_DEFAULTS.targetLufs
  return clamp(Math.round(n), LEVELER_TARGET_MIN, LEVELER_TARGET_MAX)
}

// Coerce an arbitrary (possibly partial, possibly persisted-legacy) object into a
// valid config. Unknown/invalid fields fall back to defaults.
export function normalizeLevelerConfig(partial: Partial<LevelerConfig> | null | undefined): LevelerConfig {
  const p = partial ?? {}
  return {
    enabled: Boolean(p.enabled),
    targetLufs: clampTargetLufs(p.targetLufs),
    preventClipping: p.preventClipping == null ? LEVELER_DEFAULTS.preventClipping : Boolean(p.preventClipping),
  }
}

// dB → linear amplitude multiplier (gain). 0 dB → 1.0.
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20)
}

// Convert a ReplayGain track/album gain (dB needed to reach the -18 LUFS
// reference) into an absolute integrated-loudness estimate (LUFS).
export function lufsFromReplayGain(replayGainDb: number | null | undefined): number | null {
  if (replayGainDb == null || !Number.isFinite(replayGainDb)) return null
  return RG_REFERENCE_LUFS - replayGainDb
}

// Estimate integrated loudness (LUFS) from the playback analysis we already
// compute per track. drApprox is the crest factor (peakDb - rmsDb), so the RMS
// level in dBFS is peakDb - drApprox. RMS dBFS is a coarse stand-in for true
// K-weighted LUFS, but it is good enough to roughly level untagged tracks and is
// far better than no normalization at all.
export function estimateLufsFromAnalysis(
  peakDb: number | null | undefined,
  drApprox: number | null | undefined,
): number | null {
  if (peakDb == null || !Number.isFinite(peakDb)) return null
  if (drApprox == null || !Number.isFinite(drApprox)) return null
  return peakDb - drApprox
}

// The normalization gain (dB) for the current track. Returns 0 (no change) when
// the leveler is off or the track has no loudness data. A positive value boosts a
// quiet track; a negative value attenuates a loud one.
export function levelerGainDb(config: LevelerConfig, loudness: LevelerLoudness): number {
  if (!config.enabled) return 0
  const lufs = loudness.trackLufs
  if (lufs == null || !Number.isFinite(lufs)) return 0

  let gain = clamp(config.targetLufs - lufs, -LEVELER_MAX_GAIN_DB, LEVELER_MAX_GAIN_DB)

  if (config.preventClipping && loudness.peakDb != null && Number.isFinite(loudness.peakDb)) {
    // Cap so the post-gain peak stays at/below -headroom dBFS.
    const maxGain = -loudness.peakDb - LEVELER_CLIP_HEADROOM_DB
    if (gain > maxGain) gain = maxGain
  }

  return clamp(gain, -LEVELER_MAX_GAIN_DB, LEVELER_MAX_GAIN_DB)
}

// The linear channel-volume multiplier for the current track (1.0 = unchanged).
export function levelerGainLinear(config: LevelerConfig, loudness: LevelerLoudness): number {
  return dbToLinear(levelerGainDb(config, loudness))
}

// Pretty-print the active gain for the UI, e.g. "+3.0 dB" / "-1.5 dB" / "0.0 dB".
export function formatLevelerGain(gainDb: number): string {
  if (!Number.isFinite(gainDb)) return '0.0 dB'
  const sign = gainDb > 0 ? '+' : gainDb < 0 ? '−' : ''
  return `${sign}${Math.abs(gainDb).toFixed(1)} dB`
}
