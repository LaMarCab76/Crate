export const EQ_BAND_FREQUENCIES = [
  25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000,
] as const

export const EQ_BAND_LABELS = [
  '25', '40', '63', '100', '160', '250', '400', '630', '1k', '1.6k', '2.5k', '4k', '6.3k', '10k', '16k',
] as const

export const LEGACY_EQ_BAND_FREQUENCIES = [
  32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
] as const

export const EQ_BAND_COUNT = EQ_BAND_FREQUENCIES.length
export const LEGACY_EQ_BAND_COUNT = LEGACY_EQ_BAND_FREQUENCIES.length
export const EQ_GAIN_MIN = -15
export const EQ_GAIN_MAX = 15
export const EQ_GAIN_STEP = 0.5
export const EQ_FILTER_BANDWIDTH = 0.67

export function isSupportedEqBandCount(count: number): boolean {
  return count === EQ_BAND_COUNT || count === LEGACY_EQ_BAND_COUNT
}

export function clampEqGain(gainDb: number | undefined): number {
  const value = Number(gainDb)
  return Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, Number.isFinite(value) ? value : 0))
}

export function normalizeEqBands(bands: readonly number[] | null | undefined): number[] {
  if (bands?.length === LEGACY_EQ_BAND_COUNT) {
    return interpolateEqBands(bands, LEGACY_EQ_BAND_FREQUENCIES, EQ_BAND_FREQUENCIES)
  }
  return EQ_BAND_FREQUENCIES.map((_, i) => clampEqGain(bands?.[i]))
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
