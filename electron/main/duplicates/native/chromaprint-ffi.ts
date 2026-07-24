// Lazy Koffi bindings for the pinned Chromaprint C ABI. Importing this module is
// safe when the optional development binary is absent; callers can inspect
// availability and keep duplicate analysis disabled without affecting playback.

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import {
  CHROMAPRINT_DEFAULT_ALGORITHM,
  CHROMAPRINT_VERSION,
  chromaprintLibraryPath,
} from './chromaprint-paths.ts'

const require = createRequire(import.meta.url)
type KoffiNamespace = typeof import('koffi')
const koffi = require('koffi') as KoffiNamespace

export type ChromaprintUnavailableReason =
  | 'missing_binary'
  | 'load_failed'
  | 'version_mismatch'

export type ChromaprintAvailability =
  | { available: true; version: string; path: string }
  | { available: false; reason: ChromaprintUnavailableReason; detail: string; path: string }

export interface ChromaprintRawFingerprint {
  algorithm: number
  sampleRate: number
  itemDurationSamples: number
  delaySamples: number
  values: Uint32Array
}

interface ChromaprintBindings {
  library: ReturnType<KoffiNamespace['load']>
  version: string
  New: (algorithm: number) => unknown
  Free: (context: unknown) => void
  GetAlgorithm: (context: unknown) => number
  GetSampleRate: (context: unknown) => number
  GetItemDuration: (context: unknown) => number
  GetDelay: (context: unknown) => number
  Start: (context: unknown, sampleRate: number, channels: number) => number
  Feed: (context: unknown, samples: Int16Array, size: number) => number
  Finish: (context: unknown) => number
  GetRawFingerprint: (context: unknown, pointerOut: unknown[], sizeOut: number[]) => number
  Dealloc: (pointer: unknown) => void
}

export class ChromaprintNativeError extends Error {
  readonly code: 'unavailable' | 'invalid_input' | 'native_failure' | 'invalid_state'

  constructor(
    message: string,
    code: 'unavailable' | 'invalid_input' | 'native_failure' | 'invalid_state',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ChromaprintNativeError'
    this.code = code
  }
}

let bindings: ChromaprintBindings | null = null

function loadBindings(): ChromaprintBindings {
  if (bindings) return bindings
  const path = chromaprintLibraryPath()
  if (!existsSync(path)) {
    throw new ChromaprintNativeError(
      `Chromaprint ${CHROMAPRINT_VERSION} is unavailable because ${path} is missing. Run npm run fetch:chromaprint.`,
      'unavailable',
    )
  }

  try {
    const library = koffi.load(path)
    const Context = koffi.opaque('CrateChromaprintContext')
    const ContextPointer = koffi.pointer(Context)
    const GetVersion = library.func('const char *chromaprint_get_version(void)') as () => string | null
    const version = GetVersion()
    if (version !== CHROMAPRINT_VERSION) {
      throw new ChromaprintNativeError(
        `Chromaprint ABI version mismatch: loaded ${version ?? 'unknown'}, expected ${CHROMAPRINT_VERSION}.`,
        'unavailable',
      )
    }

    bindings = {
      library,
      version,
      New: library.func('chromaprint_new', ContextPointer, ['int']),
      Free: library.func('chromaprint_free', 'void', [ContextPointer]),
      GetAlgorithm: library.func('chromaprint_get_algorithm', 'int', [ContextPointer]),
      GetSampleRate: library.func('chromaprint_get_sample_rate', 'int', [ContextPointer]),
      GetItemDuration: library.func('chromaprint_get_item_duration', 'int', [ContextPointer]),
      GetDelay: library.func('chromaprint_get_delay', 'int', [ContextPointer]),
      Start: library.func('chromaprint_start', 'int', [ContextPointer, 'int', 'int']),
      Feed: library.func('chromaprint_feed', 'int', [ContextPointer, 'const int16_t *', 'int']),
      Finish: library.func('chromaprint_finish', 'int', [ContextPointer]),
      GetRawFingerprint: library.func(
        'chromaprint_get_raw_fingerprint',
        'int',
        [ContextPointer, koffi.out(koffi.pointer('uint32_t', 2)), koffi.out(koffi.pointer('int'))],
      ),
      Dealloc: library.func('chromaprint_dealloc', 'void', ['void *']),
    } as ChromaprintBindings
    return bindings
  } catch (error) {
    if (error instanceof ChromaprintNativeError) throw error
    throw new ChromaprintNativeError(
      `Unable to load Chromaprint ${CHROMAPRINT_VERSION} from ${path}: ${error instanceof Error ? error.message : String(error)}`,
      'unavailable',
      { cause: error },
    )
  }
}

export function getChromaprintAvailability(): ChromaprintAvailability {
  let path: string
  try {
    path = chromaprintLibraryPath()
  } catch (error) {
    return {
      available: false,
      reason: 'load_failed',
      detail: error instanceof Error ? error.message : String(error),
      path: '',
    }
  }
  if (!existsSync(path)) {
    return {
      available: false,
      reason: 'missing_binary',
      detail: `Chromaprint ${CHROMAPRINT_VERSION} has not been installed for this platform.`,
      path,
    }
  }
  try {
    const loaded = loadBindings()
    return { available: true, version: loaded.version, path }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      available: false,
      reason: message.includes('version mismatch') ? 'version_mismatch' : 'load_failed',
      detail: message,
      path,
    }
  }
}

export class ChromaprintSession {
  private readonly native: ChromaprintBindings
  private context: unknown
  private finished = false

  constructor(sampleRate: number, channels: number, algorithm = CHROMAPRINT_DEFAULT_ALGORITHM) {
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new ChromaprintNativeError(`Invalid sample rate: ${sampleRate}`, 'invalid_input')
    }
    if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
      throw new ChromaprintNativeError(`Chromaprint expects one or two channels, received ${channels}`, 'invalid_input')
    }
    this.native = loadBindings()
    this.context = this.native.New(algorithm)
    if (!this.context) throw new ChromaprintNativeError('chromaprint_new failed', 'native_failure')
    if (!this.native.Start(this.context, sampleRate, channels)) {
      this.native.Free(this.context)
      this.context = null
      throw new ChromaprintNativeError('chromaprint_start failed', 'native_failure')
    }
  }

  feed(samples: Int16Array): void {
    this.assertOpen()
    if (this.finished) throw new ChromaprintNativeError('Cannot feed a finished Chromaprint session', 'invalid_state')
    if (!(samples instanceof Int16Array)) {
      throw new ChromaprintNativeError('Chromaprint input must be signed 16-bit PCM', 'invalid_input')
    }
    if (samples.length === 0) return
    if (samples.length > 0x7fffffff) throw new ChromaprintNativeError('PCM chunk is too large', 'invalid_input')
    if (!this.native.Feed(this.context, samples, samples.length)) {
      throw new ChromaprintNativeError('chromaprint_feed failed', 'native_failure')
    }
  }

  finish(): ChromaprintRawFingerprint {
    this.assertOpen()
    if (this.finished) throw new ChromaprintNativeError('Chromaprint session is already finished', 'invalid_state')
    if (!this.native.Finish(this.context)) throw new ChromaprintNativeError('chromaprint_finish failed', 'native_failure')
    this.finished = true

    const pointerOut: unknown[] = [null]
    const sizeOut = [0]
    if (!this.native.GetRawFingerprint(this.context, pointerOut, sizeOut) || !pointerOut[0]) {
      throw new ChromaprintNativeError('chromaprint_get_raw_fingerprint failed', 'native_failure')
    }
    const size = sizeOut[0]
    if (!Number.isInteger(size) || size < 0 || size > 10_000_000) {
      this.native.Dealloc(pointerOut[0])
      throw new ChromaprintNativeError(`Chromaprint returned an invalid fingerprint size: ${size}`, 'native_failure')
    }
    try {
      const decoded = koffi.decode(pointerOut[0], 'uint32_t', size) as number[]
      return {
        algorithm: this.native.GetAlgorithm(this.context),
        sampleRate: this.native.GetSampleRate(this.context),
        itemDurationSamples: this.native.GetItemDuration(this.context),
        delaySamples: this.native.GetDelay(this.context),
        values: Uint32Array.from(decoded, (value) => value >>> 0),
      }
    } finally {
      this.native.Dealloc(pointerOut[0])
    }
  }

  close(): void {
    if (!this.context) return
    this.native.Free(this.context)
    this.context = null
  }

  private assertOpen(): void {
    if (!this.context) throw new ChromaprintNativeError('Chromaprint session is closed', 'invalid_state')
  }
}

export function fingerprintPcm(
  samples: Int16Array,
  sampleRate: number,
  channels: number,
  algorithm = CHROMAPRINT_DEFAULT_ALGORITHM,
): ChromaprintRawFingerprint {
  const session = new ChromaprintSession(sampleRate, channels, algorithm)
  try {
    session.feed(samples)
    return session.finish()
  } finally {
    session.close()
  }
}
