// Offline decodes behind the playback analysis: the waveform envelope (plus a
// crest-factor loudness estimate) and the table-bars spectrum. Every read runs
// on a koffi worker thread, so long files never stall the main process.
//
// The algorithms intentionally reproduce what AudioEngine computed with BASS;
// native/crate-audio/tests/golden/analysis-*.json holds those reference values.

import { CA_FFT_BINS, CA_FFT_SIZE, Decoder, Spectrum } from './native/crateAudio.ts'
import { FFT_BINS_OUT, toDisplayBins } from './spectrumBins.ts'

const WAVEFORM_READ_FLOATS = 65536
const TABLE_BARS_FPS = 60
const TABLE_BARS_BANDS = 5
const TABLE_BARS_DISPLAY_GAIN = 2.8
const TABLE_BARS_READ_FRAMES = 16384

export interface WaveformAnalysis {
  peaks: number[]
  drApprox: number
  peakDb: number
  buckets: number
}

export interface TableBarsAnalysis {
  fps: 60
  bands: 5
  frames: number
  durationSec: number
  complete: true
  values: number[]
}

function totalFramesOf(decoder: Decoder): number {
  const { frames, duration, sampleRate } = decoder.info
  if (frames > 0) return frames
  return Math.max(1, Math.round(Math.max(0, duration) * sampleRate))
}

/** Max-abs envelope in `buckets` buckets, true peak and a crest-factor DR estimate. */
export async function decodeWaveformAnalysis(path: string, buckets: number): Promise<WaveformAnalysis> {
  const decoder = await Decoder.openFileAsync(path, { exactDuration: true })
  try {
    const chans = Math.max(1, decoder.info.channels)
    const framesPerBucket = Math.max(1, Math.floor(totalFramesOf(decoder) / buckets))
    const peaks = new Array<number>(buckets).fill(0)
    const buffer = new Float32Array(Math.floor(WAVEFORM_READ_FLOATS / chans) * chans)
    let frameCursor = 0
    let globalPeak = 0
    let sumSq = 0
    let sampleCount = 0

    for (;;) {
      const frames = await decoder.readAsync(buffer)
      if (frames === 0) break
      const floats = frames * chans
      for (let i = 0; i < floats; i += chans) {
        let frameMax = 0
        for (let c = 0; c < chans; c++) {
          const s = buffer[i + c]
          const a = Math.abs(s)
          if (a > frameMax) frameMax = a
          sumSq += s * s
        }
        sampleCount += chans
        if (frameMax > globalPeak) globalPeak = frameMax
        const b = Math.min(buckets - 1, Math.floor(frameCursor / framesPerBucket))
        if (frameMax > peaks[b]) peaks[b] = frameMax
        frameCursor++
      }
    }

    const rms = Math.sqrt(sumSq / Math.max(1, sampleCount))
    return {
      peaks,
      drApprox: 20 * Math.log10(Math.max(1e-6, globalPeak) / Math.max(1e-6, rms)),
      peakDb: 20 * Math.log10(Math.max(1e-6, globalPeak)),
      buckets,
    }
  } finally {
    decoder.close()
  }
}

/**
 * Five-band spectrum at 60 fps for the table-bars visual. Each frame is the
 * FFT2048 of the 2048 samples starting at frame/60 seconds (mono mix), which
 * is what BASS produced after seeking a decode stream to that position; near
 * the end only the remaining samples are windowed. The file is decoded once,
 * front to back, instead of seeking per frame.
 */
export async function decodeTableBarsAnalysis(path: string): Promise<TableBarsAnalysis> {
  const decoder = await Decoder.openFileAsync(path, { exactDuration: true })
  const spectrum = new Spectrum()
  try {
    const rate = decoder.info.sampleRate
    const chans = Math.max(1, decoder.info.channels)
    const totalFrames = totalFramesOf(decoder)
    const durationSec = totalFrames / rate
    const frames = Math.max(1, Math.ceil(durationSec * TABLE_BARS_FPS))
    const values = new Array<number>(frames * TABLE_BARS_BANDS).fill(0)

    let mono = new Float32Array(TABLE_BARS_READ_FRAMES * 4)
    let monoStart = 0    // absolute frame index of mono[0]
    let monoLength = 0
    let ended = false
    const chunk = new Float32Array(TABLE_BARS_READ_FRAMES * chans)

    const ensureDecoded = async (endFrame: number): Promise<void> => {
      while (!ended && monoStart + monoLength < endFrame) {
        const n = await decoder.readAsync(chunk)
        if (n === 0) {
          ended = true
          break
        }
        if (monoLength + n > mono.length) {
          const grown = new Float32Array(Math.max(mono.length * 2, monoLength + n))
          grown.set(mono.subarray(0, monoLength))
          mono = grown
        }
        const inv = 1 / chans
        for (let i = 0; i < n; i++) {
          let sum = 0
          for (let c = 0; c < chans; c++) sum += chunk[i * chans + c]
          mono[monoLength + i] = sum * inv
        }
        monoLength += n
      }
    }

    const window = new Float32Array(CA_FFT_SIZE)
    const raw = new Float32Array(CA_FFT_BINS)
    const bins = new Float32Array(FFT_BINS_OUT)
    // BASS positioned by bytes of 32-bit float frames; keep its rounding so
    // every frame starts on exactly the same sample.
    const frameBytes = chans * 4
    const bytesPerSecond = rate * frameBytes
    for (let frame = 0; frame < frames; frame++) {
      const seconds = Math.min(durationSec, frame / TABLE_BARS_FPS)
      const start = Math.floor(Math.floor(seconds * bytesPerSecond) / frameBytes)
      await ensureDecoded(start + CA_FFT_SIZE)

      // Drop samples no later frame can reach.
      if (start - monoStart > TABLE_BARS_READ_FRAMES * 2) {
        const drop = start - monoStart
        mono.copyWithin(0, drop, monoLength)
        monoLength -= drop
        monoStart += drop
      }
      const offset = start - monoStart
      const available = Math.min(CA_FFT_SIZE, monoLength - offset)
      if (offset < 0 || available <= 0) continue

      window.set(mono.subarray(offset, offset + available))
      spectrum.run(window.subarray(0, available), 1, raw)
      toDisplayBins(raw, bins)

      for (let b = 0; b < TABLE_BARS_BANDS; b++) {
        const from = Math.floor((b * FFT_BINS_OUT) / TABLE_BARS_BANDS)
        const to = Math.max(from + 1, Math.floor(((b + 1) * FFT_BINS_OUT) / TABLE_BARS_BANDS))
        let sum = 0
        for (let i = from; i < to; i++) sum += bins[i] ?? 0
        const band = Math.max(0, Math.min(1, sum / (to - from)))
        values[frame * TABLE_BARS_BANDS + b] = Math.max(0, Math.min(1, Math.sqrt(band * TABLE_BARS_DISPLAY_GAIN)))
      }
    }

    return { fps: TABLE_BARS_FPS, bands: TABLE_BARS_BANDS, frames, durationSec, complete: true, values }
  } finally {
    spectrum.close()
    decoder.close()
  }
}
