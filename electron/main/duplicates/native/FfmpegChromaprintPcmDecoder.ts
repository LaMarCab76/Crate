import { CA_SAMPLE_S16, Decoder } from '../../audio/native/crateAudio.ts'
import type {
  ChromaprintDecodeResult,
  ChromaprintPcmDecoder,
  ChromaprintPcmSink,
} from './ChromaprintFingerprintProvider.ts'

const READ_SAMPLES = 64 * 1024

let decodeTail: Promise<void> = Promise.resolve()

function serializeDecode<T>(operation: () => Promise<T>): Promise<T> {
  const run = decodeTail.then(operation, operation)
  decodeTail = run.then(() => undefined, () => undefined)
  return run
}

function abortError(): Error {
  const error = new Error('Duplicate PCM decode cancelled.')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

/**
 * Serial, bounded-memory FFmpeg decoder that produces signed 16-bit PCM at the
 * file's own rate (DSD at 88.2 kHz, as BASSDSD did). Reads run on a koffi
 * worker thread, so fingerprinting never blocks the main process.
 */
export class FfmpegChromaprintPcmDecoder implements ChromaprintPcmDecoder {
  decode(localPath: string, sink: ChromaprintPcmSink, signal?: AbortSignal): Promise<ChromaprintDecodeResult> {
    return serializeDecode(() => this.decodeNow(localPath, sink, signal))
  }

  private async decodeNow(
    localPath: string,
    sink: ChromaprintPcmSink,
    signal?: AbortSignal,
  ): Promise<ChromaprintDecodeResult> {
    throwIfAborted(signal)
    const decoder = await Decoder.openFileAsync(localPath, { sampleFormat: CA_SAMPLE_S16 })
    try {
      const { sampleRate, channels } = decoder.info
      if (
        !Number.isInteger(sampleRate)
        || sampleRate <= 0
        || !Number.isInteger(channels)
        || channels < 1
        || channels > 32
      ) {
        throw new Error(`Invalid fingerprint PCM format (${sampleRate} Hz, ${channels} channels).`)
      }
      const outputChannels: 1 | 2 = channels === 1 ? 1 : channels === 2 ? 2 : 1
      sink.start({ sampleRate, channels: outputChannels })
      // Keep each request on a complete interleaved frame while retaining a
      // fixed upper bound even for multichannel files.
      const buffer = new Int16Array(Math.floor(READ_SAMPLES / channels) * channels)
      let totalSamples = 0
      for (;;) {
        throwIfAborted(signal)
        const frames = await decoder.readAsync(buffer)
        if (frames === 0) break
        const count = frames * channels
        if (outputChannels === channels) {
          sink.write(buffer.subarray(0, count))
          totalSamples += count
        } else {
          const mono = new Int16Array(frames)
          for (let frame = 0; frame < frames; frame += 1) {
            let sum = 0
            const start = frame * channels
            for (let channel = 0; channel < channels; channel += 1) sum += buffer[start + channel]
            mono[frame] = Math.trunc(sum / channels)
          }
          sink.write(mono)
          totalSamples += frames
        }
      }
      // Reading the full decode stream is authoritative; container durations
      // can be estimates.
      return { durationSeconds: totalSamples / (sampleRate * outputChannels) }
    } finally {
      decoder.close()
    }
  }
}
