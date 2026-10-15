import type {
  AudioFingerprint,
  FingerprintProvider,
  FingerprintSource,
} from '../fingerprint.ts'
import {
  ChromaprintNativeError,
  ChromaprintSession,
  getChromaprintAvailability,
  type ChromaprintAvailability,
  type ChromaprintRawFingerprint,
} from './chromaprint-ffi.ts'
import { CHROMAPRINT_DEFAULT_ALGORITHM } from './chromaprint-paths.ts'

export const CHROMAPRINT_PROVIDER_VERSION = '1.6.0'

export interface ResolvedFingerprintInput {
  /** Local file the decoder reads; cloud resolvers should use a bounded temp file. */
  localPath: string
  /** Revalidate ETag/size/source identity after streaming and before persistence. */
  verifyUnchanged?: () => Promise<void>
  /** Always called, including native failures and cancellation. */
  cleanup?: () => Promise<void> | void
}

export interface ChromaprintSourceResolver {
  resolve(source: FingerprintSource, signal?: AbortSignal): Promise<ResolvedFingerprintInput>
}

export interface ChromaprintPcmFormat {
  sampleRate: number
  channels: 1 | 2
}

export interface ChromaprintPcmSink {
  /** Must be called exactly once, before the first PCM chunk. */
  start(format: ChromaprintPcmFormat): void
  /** Interleaved signed 16-bit native-endian samples; the decoder owns pacing. */
  write(samples: Int16Array): void
}

export interface ChromaprintDecodeResult {
  /** Optional because the provider can derive it from the streamed sample count. */
  durationSeconds?: number
}

export interface ChromaprintPcmDecoder {
  decode(
    localPath: string,
    sink: ChromaprintPcmSink,
    signal?: AbortSignal,
  ): Promise<ChromaprintDecodeResult>
}

interface ChromaprintSessionLike {
  feed(samples: Int16Array): void
  finish(): ChromaprintRawFingerprint
  close(): void
}

export interface ChromaprintFingerprintProviderOptions {
  availability?: () => ChromaprintAvailability
  createSession?: (sampleRate: number, channels: number) => ChromaprintSessionLike
}

function abortError(): Error {
  const error = new Error('Duplicate fingerprint generation cancelled.')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function validDuration(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Streaming adapter only. The resolver owns local authorization/OneDrive temp
 * downloads and the decoder owns the audio engine lifecycle. This keeps the
 * provider independent from DB, Electron `app`, and whole-file buffers.
 */
export class ChromaprintFingerprintProvider implements FingerprintProvider {
  readonly algorithm = 'chromaprint'
  readonly algorithmVersion = CHROMAPRINT_PROVIDER_VERSION

  private readonly availability: () => ChromaprintAvailability
  private readonly createSession: (sampleRate: number, channels: number) => ChromaprintSessionLike
  private readonly resolver: ChromaprintSourceResolver
  private readonly decoder: ChromaprintPcmDecoder

  constructor(
    resolver: ChromaprintSourceResolver,
    decoder: ChromaprintPcmDecoder,
    options: ChromaprintFingerprintProviderOptions = {},
  ) {
    this.resolver = resolver
    this.decoder = decoder
    this.availability = options.availability ?? getChromaprintAvailability
    this.createSession = options.createSession ?? ((sampleRate, channels) => new ChromaprintSession(sampleRate, channels))
  }

  async fingerprint(source: FingerprintSource, signal?: AbortSignal): Promise<AudioFingerprint> {
    throwIfAborted(signal)
    const availability = this.availability()
    if (!availability.available) {
      throw new ChromaprintNativeError(availability.detail, 'unavailable')
    }

    const resolved = await this.resolver.resolve(source, signal)
    let primaryError: unknown = null
    const streamState: {
      session: ChromaprintSessionLike | null
      format: ChromaprintPcmFormat | null
    } = { session: null, format: null }
    let sampleCount = 0
    try {
      throwIfAborted(signal)
      const decoded = await this.decoder.decode(resolved.localPath, {
        start: (nextFormat) => {
          throwIfAborted(signal)
          if (streamState.session) throw new Error('PCM decoder emitted its format more than once.')
          if (!Number.isInteger(nextFormat.sampleRate) || nextFormat.sampleRate <= 0) {
            throw new Error(`PCM decoder returned invalid sample rate ${nextFormat.sampleRate}.`)
          }
          if (nextFormat.channels !== 1 && nextFormat.channels !== 2) {
            throw new Error(`PCM decoder returned unsupported channel count ${nextFormat.channels}.`)
          }
          streamState.format = nextFormat
          streamState.session = this.createSession(nextFormat.sampleRate, nextFormat.channels)
        },
        write: (samples) => {
          throwIfAborted(signal)
          if (!streamState.session || !streamState.format) throw new Error('PCM decoder emitted samples before its format.')
          if (!(samples instanceof Int16Array)) throw new Error('PCM decoder must emit signed 16-bit samples.')
          if (samples.length % streamState.format.channels !== 0) throw new Error('PCM chunk ends in a partial channel frame.')
          streamState.session.feed(samples)
          sampleCount += samples.length
        },
      }, signal)
      throwIfAborted(signal)
      const session = streamState.session
      const format = streamState.format
      if (!session || !format) throw new Error('PCM decoder produced no audio format.')
      if (sampleCount === 0) throw new Error('PCM decoder produced no audio samples.')
      await resolved.verifyUnchanged?.()
      throwIfAborted(signal)

      const raw = session.finish()
      if (
        raw.values.length === 0
        || raw.algorithm !== CHROMAPRINT_DEFAULT_ALGORITHM
        || raw.sampleRate <= 0
        || raw.itemDurationSamples <= 0
        || raw.delaySamples < 0
      ) {
        throw new Error('Chromaprint produced an empty or invalid raw fingerprint.')
      }
      const derivedDuration = sampleCount / (format.sampleRate * format.channels)
      const durationSeconds = validDuration(decoded.durationSeconds) ? decoded.durationSeconds : derivedDuration
      return {
        algorithm: this.algorithm,
        algorithmVersion: this.algorithmVersion,
        framesPerSecond: raw.sampleRate / raw.itemDurationSamples,
        delaySeconds: raw.delaySamples / raw.sampleRate,
        durationSeconds,
        frames: raw.values,
      }
    } catch (error) {
      primaryError = error
      throw error
    } finally {
      streamState.session?.close()
      try {
        await resolved.cleanup?.()
      } catch (cleanupError) {
        if (!primaryError) throw cleanupError
        console.warn('[duplicates] failed to clean up resolved fingerprint input:', cleanupError)
      }
    }
  }
}

export function createConfiguredChromaprintFingerprintProvider(
  resolver: ChromaprintSourceResolver,
  decoder: ChromaprintPcmDecoder,
  options?: ChromaprintFingerprintProviderOptions,
): FingerprintProvider {
  return new ChromaprintFingerprintProvider(resolver, decoder, options)
}
