// Display mapping shared by the live visualizer and the table-bars analysis:
// the 1024 FFT2048 magnitudes are reduced to 64 log-spaced bins.

export const FFT_BINS_RAW = 1024
export const FFT_BINS_OUT = 64

// Skewed so low frequencies get more visual real estate (bass is where most
// energy lives). Computed as floor(pow(1023, i / (n-1))).
export const FFT_LOG_INDEX: readonly number[] = Array.from({ length: FFT_BINS_OUT }, (_, i) => {
  const ratio = i / (FFT_BINS_OUT - 1)
  return Math.max(1, Math.min(FFT_BINS_RAW - 1, Math.floor(Math.pow(FFT_BINS_RAW - 1, ratio))))
})

// sqrt() pushes near-zero values up so faint mids/highs stay visible; the 1.6
// gain keeps peaks near 1.0 for typical material.
export function toDisplayBins(raw: Float32Array, out: number[] | Float32Array): void {
  for (let i = 0; i < FFT_BINS_OUT; i++) {
    const amp = raw[FFT_LOG_INDEX[i]]
    out[i] = Math.min(1, Math.sqrt(Math.max(0, amp)) * 1.6)
  }
}
