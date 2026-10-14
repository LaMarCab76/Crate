// Configurable graphic equalizer. The band count is user-selectable up to 32;
// center frequencies are log-spaced across the audible range. Two curated
// layouts are kept for continuity — the historical 10-band (legacy) and the
// 15-band default — while every other count is generated on demand.

export const EQ_BAND_FREQUENCIES = [
  25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000,
] as const

export const EQ_BAND_LABELS = [
  '25', '40', '63', '100', '160', '250', '400', '630', '1k', '1.6k', '2.5k', '4k', '6.3k', '10k', '16k',
] as const

// The legacy 10-band layout is derived from HiFidelity by Varun Rathod
// (AudioEffectsManager.swift, Apache-2.0, see licenses/HiFidelity-Apache-2.0.txt).
export const LEGACY_EQ_BAND_FREQUENCIES = [
  32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
] as const

// Default (15-band) and legacy (10-band) layouts. EQ_BAND_COUNT remains the
// default count so existing callers that don't pass an explicit count keep the
// familiar 15-band behavior.
export const EQ_BAND_COUNT = EQ_BAND_FREQUENCIES.length
export const LEGACY_EQ_BAND_COUNT = LEGACY_EQ_BAND_FREQUENCIES.length

export const EQ_DEFAULT_BAND_COUNT = EQ_BAND_COUNT
export const EQ_MIN_BAND_COUNT = 5
export const EQ_MAX_BAND_COUNT = 32

// Quick-pick band counts surfaced in the EQ panel (all ≤ EQ_MAX_BAND_COUNT).
// 31 is the pro-audio 1/3-octave standard; 10/15 match the curated layouts.
export const EQ_BAND_COUNT_PRESETS = [10, 15, 20, 31] as const

export const EQ_GAIN_MIN = -15
export const EQ_GAIN_MAX = 15
export const EQ_GAIN_STEP = 0.5

// Default per-band peaking-filter bandwidth (octaves) for the 15-band layout.
// Denser EQs compute a narrower bandwidth via eqBandwidthForCount().
export const EQ_FILTER_BANDWIDTH = 0.67

// Audible-range bounds used to generate log-spaced centers for arbitrary counts.
const EQ_FREQ_MIN = 20
const EQ_FREQ_MAX = 20000

export function clampEqBandCount(count: number | undefined): number {
  const n = Math.round(Number(count))
  if (!Number.isFinite(n)) return EQ_DEFAULT_BAND_COUNT
  return Math.max(EQ_MIN_BAND_COUNT, Math.min(EQ_MAX_BAND_COUNT, n))
}

function roundFreq(freq: number): number {
  if (freq >= 1000) return Math.round(freq / 100) * 100
  if (freq >= 100) return Math.round(freq / 10) * 10
  return Math.round(freq)
}

function logSpacedFrequencies(count: number): number[] {
  if (count <= 1) return [roundFreq(Math.sqrt(EQ_FREQ_MIN * EQ_FREQ_MAX))]
  const logMin = Math.log(EQ_FREQ_MIN)
  const logMax = Math.log(EQ_FREQ_MAX)
  return Array.from({ length: count }, (_, i) =>
    roundFreq(Math.exp(logMin + ((logMax - logMin) * i) / (count - 1))),
  )
}

// Raw (unclamped) center frequencies for an *exact* band count. The two curated
// layouts win for their native counts so the default/legacy EQs keep their
// familiar centers; everything else is log-spaced. Used both for the active EQ
// layout (via eqBandFrequencies, after clamping) and as the source grid when
// resizing an arbitrary-length saved curve (which may legitimately sit outside
// the clamp window — see normalizeEqBands).
function bandFrequenciesForLength(count: number): number[] {
  if (count === EQ_BAND_COUNT) return [...EQ_BAND_FREQUENCIES]
  if (count === LEGACY_EQ_BAND_COUNT) return [...LEGACY_EQ_BAND_FREQUENCIES]
  return logSpacedFrequencies(count)
}

// Center frequencies for the active EQ layout, clamped to the supported range.
export function eqBandFrequencies(count: number): number[] {
  return bandFrequenciesForLength(clampEqBandCount(count))
}

export function eqBandLabel(freq: number): string {
  if (freq >= 1000) {
    const k = freq / 1000
    return Number.isInteger(k) ? `${k}k` : `${Number(k.toFixed(1))}k`
  }
  return `${Math.round(freq)}`
}

export function eqBandLabels(count: number): string[] {
  const n = clampEqBandCount(count)
  if (n === EQ_BAND_COUNT) return [...EQ_BAND_LABELS]
  return eqBandFrequencies(n).map(eqBandLabel)
}

// Per-band peaking-filter bandwidth in octaves. Denser EQs get proportionally
// narrower filters so adjacent bands don't smear into each other.
export function eqBandwidthForCount(count: number): number {
  const n = clampEqBandCount(count)
  if (n <= 1) return EQ_FILTER_BANDWIDTH
  const totalOctaves = Math.log2(EQ_FREQ_MAX / EQ_FREQ_MIN) // ≈ 9.97
  const perBand = totalOctaves / (n - 1)
  // PEAKEQ fBandwidth accepts roughly 0.1–3 octaves; clamp to that window.
  return Math.max(0.1, Math.min(3, perBand))
}

export function isSupportedEqBandCount(count: number): boolean {
  const n = Math.round(Number(count))
  return Number.isFinite(n) && n >= EQ_MIN_BAND_COUNT && n <= EQ_MAX_BAND_COUNT
}

export function clampEqGain(gainDb: number | undefined): number {
  const value = Number(gainDb)
  return Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, Number.isFinite(value) ? value : 0))
}

// Resize a band array to `count`, interpolating gains across the log-frequency
// axis. A matching length is clamped element-wise; any other length (legacy
// 10-band saved state, a previous band-count choice, etc.) is remapped from its
// own band centers onto the target centers so the curve's shape is preserved.
export function normalizeEqBands(
  bands: readonly number[] | null | undefined,
  count: number = EQ_DEFAULT_BAND_COUNT,
): number[] {
  const targetCount = clampEqBandCount(count)
  const targetFreqs = eqBandFrequencies(targetCount)
  if (bands && bands.length === targetCount) {
    return targetFreqs.map((_, i) => clampEqGain(bands[i]))
  }
  if (!bands || bands.length === 0) {
    return targetFreqs.map(() => 0)
  }
  // Source grid must have EXACTLY bands.length points (unclamped) so the gains
  // map onto their real centers — a saved curve can be any length (legacy data,
  // a forward-compat payload, or a malformed eq:setBands array).
  const sourceFreqs = bandFrequenciesForLength(bands.length)
  return interpolateEqBands(bands, sourceFreqs, targetFreqs)
}

function interpolateEqBands(
  bands: readonly number[],
  sourceFreqs: readonly number[],
  targetFreqs: readonly number[],
): number[] {
  const sourceBands = sourceFreqs.map((_, i) => clampEqGain(bands[i]))
  const sourceLogs = sourceFreqs.map(freq => Math.log(freq))
  const first = sourceBands[0] ?? 0
  const last = sourceBands[sourceBands.length - 1] ?? 0

  return targetFreqs.map(freq => {
    const targetLog = Math.log(freq)
    if (targetLog <= sourceLogs[0]) return first
    if (targetLog >= sourceLogs[sourceLogs.length - 1]) return last

    const upper = sourceLogs.findIndex(logFreq => logFreq >= targetLog)
    if (upper <= 0) return first

    const lower = upper - 1
    const span = sourceLogs[upper] - sourceLogs[lower]
    const ratio = span > 0 ? (targetLog - sourceLogs[lower]) / span : 0
    return clampEqGain(sourceBands[lower] + (sourceBands[upper] - sourceBands[lower]) * ratio)
  })
}
