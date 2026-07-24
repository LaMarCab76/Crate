import { getAudioEngine } from '../../audio/AudioEngine.ts'
import { loadBass, makeChannelGetInfo } from '../../audio/bass-ffi.ts'
import {
  BASS_ERROR_ENDED,
  BASS_FILE_NAME,
  BASS_STREAM_DECODE,
  BASS_UNICODE,
  bassErrorName,
} from '../../audio/bass-constants.ts'
import type {
  ChromaprintDecodeResult,
  ChromaprintPcmDecoder,
  ChromaprintPcmSink,
} from './ChromaprintFingerprintProvider.ts'

const READ_SAMPLES = 64 * 1024
const YIELD_EVERY_CHUNKS = 8

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

export interface BassChromaprintPcmDecoderOptions {
  /** Main-process default. A utility worker can inject its own no-sound init. */
  prepare?: () => void
}

/** Serial, bounded-memory BASS decoder that produces signed 16-bit PCM. */
export class BassChromaprintPcmDecoder implements ChromaprintPcmDecoder {
  private readonly prepare: () => void

  constructor(options: BassChromaprintPcmDecoderOptions = {}) {
    this.prepare = options.prepare ?? (() => getAudioEngine().ensureInit())
  }

  decode(localPath: string, sink: ChromaprintPcmSink, signal?: AbortSignal): Promise<ChromaprintDecodeResult> {
    return serializeDecode(() => this.decodeNow(localPath, sink, signal))
  }

  private async decodeNow(
    localPath: string,
    sink: ChromaprintPcmSink,
    signal?: AbortSignal,
  ): Promise<ChromaprintDecodeResult> {
    throwIfAborted(signal)
    this.prepare()
    const bass = loadBass()
    const streamFlags = (BASS_STREAM_DECODE | (process.platform === 'win32' ? BASS_UNICODE : 0)) >>> 0
    const createStream = process.platform === 'win32'
      ? bass.StreamCreateFileUnicode
      : bass.StreamCreateFile
    const handle = createStream(
      BASS_FILE_NAME,
      localPath,
      0n,
      0n,
      streamFlags,
    )
    if (handle === 0) {
      const code = bass.ErrorGetCode()
      throw new Error(`BASS fingerprint decode failed: ${bassErrorName(code)} (${code})`)
    }

    try {
      const info = makeChannelGetInfo()(handle)
      if (
        !Number.isInteger(info.freq)
        || info.freq <= 0
        || !Number.isInteger(info.chans)
        || info.chans < 1
        || info.chans > 32
      ) {
        throw new Error(`BASS returned an invalid fingerprint PCM format (${info.freq} Hz, ${info.chans} channels).`)
      }
      const outputChannels: 1 | 2 = info.chans === 1 ? 1 : info.chans === 2 ? 2 : 1
      sink.start({ sampleRate: info.freq, channels: outputChannels })
      // Keep each request on a complete interleaved frame while retaining a
      // fixed upper bound even for multichannel files.
      const samplesPerRead = Math.floor(READ_SAMPLES / info.chans) * info.chans
      const buffer = new Int16Array(samplesPerRead)
      let totalSamples = 0
      let chunks = 0
      for (;;) {
        throwIfAborted(signal)
        const bytes = bass.ChannelGetDataInt16(handle, buffer, buffer.byteLength)
        if (bytes === 0xffffffff) {
          const code = bass.ErrorGetCode()
          if (code !== 0 && code !== BASS_ERROR_ENDED) throw new Error(`BASS fingerprint read failed: ${bassErrorName(code)} (${code})`)
          break
        }
        if (bytes === 0) break
        if (bytes % (Int16Array.BYTES_PER_ELEMENT * info.chans) !== 0 || bytes > buffer.byteLength) {
          throw new Error(`BASS returned an invalid PCM byte count: ${bytes}`)
        }
        const count = bytes / Int16Array.BYTES_PER_ELEMENT
        if (outputChannels === info.chans) {
          sink.write(buffer.subarray(0, count))
          totalSamples += count
        } else {
          const frames = count / info.chans
          const mono = new Int16Array(frames)
          for (let frame = 0; frame < frames; frame += 1) {
            let sum = 0
            const start = frame * info.chans
            for (let channel = 0; channel < info.chans; channel += 1) sum += buffer[start + channel]
            mono[frame] = Math.trunc(sum / info.chans)
          }
          sink.write(mono)
          totalSamples += frames
        }
        if (++chunks % YIELD_EVERY_CHUNKS === 0) await new Promise<void>(resolve => setImmediate(resolve))
      }
      // Reading the full decode stream is authoritative. Channel length is not
      // used because some codecs report estimates until prescanned.
      return { durationSeconds: totalSamples / (info.freq * outputChannels) }
    } finally {
      bass.StreamFree(handle)
    }
  }
}
