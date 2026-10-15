// koffi bindings to libcrate_audio, Crate's FFmpeg + miniaudio engine
// (native/crate-audio/include/crate_audio.h). Loaded lazily so importing this
// module never fails when the binary is missing.
//
// koffi 3 hands opaque pointers to JS as bigint addresses; null means the
// native call failed and ca_last_error() has the reason.

import { createRequire } from 'node:module'
import { crateAudioLibraryPath } from './crateAudioPaths.ts'

const require = createRequire(import.meta.url)
type KoffiNamespace = typeof import('koffi')
const koffi = require('koffi') as KoffiNamespace

export const CRATE_AUDIO_API_VERSION = 1

export const CA_SAMPLE_F32 = 1
export const CA_SAMPLE_S16 = 2
export const CA_DECODE_EXACT_DURATION = 0x1
export const CA_FFT_SIZE = 2048
export const CA_FFT_BINS = 1024

export type NativeHandle = bigint

export interface CrateAudioBuildInfo {
  apiVersion: number
  version: string
  ffmpegVersion: string
  ffmpegLicense: string
  miniaudioVersion: string
}

export interface DecodeOptions {
  sampleFormat?: typeof CA_SAMPLE_F32 | typeof CA_SAMPLE_S16
  sampleRate?: number
  channels?: number
  exactDuration?: boolean
}

export interface CaStreamInfo {
  sampleRate: number
  channels: number
  sourceSampleRate: number
  sourceChannels: number
  bitsPerSample: number
  isFloat: boolean
  isLossless: boolean
  isDsd: boolean
  frames: number
  duration: number
  bitRate: number
  codec: string
  container: string
}

export class CrateAudioError extends Error {
  readonly code: number

  constructor(message: string, code: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CrateAudioError'
    this.code = code
  }
}

type KoffiFunction = ReturnType<ReturnType<KoffiNamespace['load']>['func']>

interface Bindings {
  path: string
  getBuildInfo: KoffiFunction
  lastError: KoffiFunction
  decoderOpenFile: KoffiFunction
  decoderOpenMemory: KoffiFunction
  decoderGetInfo: KoffiFunction
  decoderReadF32: KoffiFunction
  decoderReadS16: KoffiFunction
  decoderSeek: KoffiFunction
  decoderGetPosition: KoffiFunction
  decoderClose: KoffiFunction
  fftCreate: KoffiFunction
  fftRun: KoffiFunction
  fftDestroy: KoffiFunction
}

let bindings: Bindings | null = null
let loadError: Error | null = null

function defineTypes(): void {
  koffi.struct('ca_build_info', {
    api_version: 'int32_t',
    version: koffi.array('char', 32),
    ffmpeg_version: koffi.array('char', 64),
    ffmpeg_license: koffi.array('char', 64),
    miniaudio_version: koffi.array('char', 32),
  })
  koffi.struct('ca_decode_opts', {
    sample_format: 'int32_t',
    sample_rate: 'int32_t',
    channels: 'int32_t',
    flags: 'int32_t',
  })
  koffi.struct('ca_stream_info', {
    sample_rate: 'int32_t',
    channels: 'int32_t',
    source_sample_rate: 'int32_t',
    source_channels: 'int32_t',
    bits_per_sample: 'int32_t',
    is_float: 'int32_t',
    is_lossless: 'int32_t',
    is_dsd: 'int32_t',
    frames: 'int64_t',
    duration: 'double',
    bit_rate: 'int64_t',
    codec: koffi.array('char', 32),
    container: koffi.array('char', 32),
  })
  koffi.opaque('ca_decoder')
  koffi.opaque('ca_fft')
}

export function loadCrateAudio(): Bindings {
  if (bindings) return bindings
  if (loadError) throw loadError
  const path = crateAudioLibraryPath()
  try {
    defineTypes()
    const lib = koffi.load(path)
    const loaded: Bindings = {
      path,
      getBuildInfo: lib.func('int ca_get_build_info(_Out_ ca_build_info *out)'),
      lastError: lib.func('const char *ca_last_error(void)'),
      decoderOpenFile: lib.func('ca_decoder *ca_decoder_open_file(const char *path, const ca_decode_opts *opts)'),
      decoderOpenMemory: lib.func('ca_decoder *ca_decoder_open_memory(const void *data, int64_t size, const char *hint, const ca_decode_opts *opts)'),
      decoderGetInfo: lib.func('int ca_decoder_get_info(const ca_decoder *dec, _Out_ ca_stream_info *out)'),
      decoderReadF32: lib.func('int64_t ca_decoder_read(ca_decoder *dec, _Out_ float *out, int64_t frames)'),
      decoderReadS16: lib.func('ca_decoder_read', 'int64_t', ['ca_decoder *', koffi.out(koffi.pointer('int16_t')), 'int64_t']),
      decoderSeek: lib.func('int ca_decoder_seek(ca_decoder *dec, double seconds)'),
      decoderGetPosition: lib.func('double ca_decoder_get_position(const ca_decoder *dec)'),
      decoderClose: lib.func('void ca_decoder_close(ca_decoder *dec)'),
      fftCreate: lib.func('ca_fft *ca_fft_create(void)'),
      fftRun: lib.func('int ca_fft_run(ca_fft *fft, const float *frames, int32_t frame_count, int32_t channels, _Out_ float *out)'),
      fftDestroy: lib.func('void ca_fft_destroy(ca_fft *fft)'),
    }
    const info = readBuildInfo(loaded)
    if (info.apiVersion !== CRATE_AUDIO_API_VERSION) {
      throw new Error(`crate-audio API ${info.apiVersion} does not match the expected ${CRATE_AUDIO_API_VERSION}`)
    }
    if (!info.ffmpegLicense.startsWith('LGPL')) {
      throw new Error(`crate-audio was built with a non-LGPL FFmpeg (${info.ffmpegLicense})`)
    }
    bindings = loaded
    return loaded
  } catch (error) {
    loadError = new CrateAudioError(
      `Cannot load the audio engine (${path}): ${error instanceof Error ? error.message : String(error)}`,
      -7,
      { cause: error },
    )
    throw loadError
  }
}

function readBuildInfo(b: Bindings): CrateAudioBuildInfo {
  const raw: Record<string, unknown> = {}
  b.getBuildInfo(raw)
  return {
    apiVersion: Number(raw.api_version),
    version: String(raw.version ?? ''),
    ffmpegVersion: String(raw.ffmpeg_version ?? ''),
    ffmpegLicense: String(raw.ffmpeg_license ?? ''),
    miniaudioVersion: String(raw.miniaudio_version ?? ''),
  }
}

export function getCrateAudioBuildInfo(): CrateAudioBuildInfo {
  return readBuildInfo(loadCrateAudio())
}

export function lastCrateAudioError(): string {
  return String(loadCrateAudio().lastError() ?? '')
}

function toNativeOptions(options: DecodeOptions | undefined) {
  return {
    sample_format: options?.sampleFormat ?? CA_SAMPLE_F32,
    sample_rate: options?.sampleRate ?? 0,
    channels: options?.channels ?? 0,
    flags: options?.exactDuration ? CA_DECODE_EXACT_DURATION : 0,
  }
}

function toStreamInfo(raw: Record<string, unknown>): CaStreamInfo {
  return {
    sampleRate: Number(raw.sample_rate),
    channels: Number(raw.channels),
    sourceSampleRate: Number(raw.source_sample_rate),
    sourceChannels: Number(raw.source_channels),
    bitsPerSample: Number(raw.bits_per_sample),
    isFloat: Boolean(raw.is_float),
    isLossless: Boolean(raw.is_lossless),
    isDsd: Boolean(raw.is_dsd),
    frames: Number(raw.frames),
    duration: Number(raw.duration),
    bitRate: Number(raw.bit_rate),
    codec: String(raw.codec ?? ''),
    container: String(raw.container ?? ''),
  }
}

function callAsync<T>(fn: KoffiFunction, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    ;(fn as unknown as { async: (...rest: unknown[]) => void }).async(...args, (error: unknown, result: T) => {
      if (error) reject(error)
      else resolve(result)
    })
  })
}

/**
 * One FFmpeg decode stream. Not thread-safe: never overlap two reads on the
 * same decoder (await each readAsync before the next call).
 */
export class Decoder {
  private handle: NativeHandle | null
  readonly info: CaStreamInfo
  readonly sampleFormat: typeof CA_SAMPLE_F32 | typeof CA_SAMPLE_S16
  // Memory-backed decoders keep reading this buffer until close().
  private readonly retainedBuffer: Buffer | null

  private constructor(handle: NativeHandle, format: typeof CA_SAMPLE_F32 | typeof CA_SAMPLE_S16, buffer: Buffer | null) {
    this.handle = handle
    this.sampleFormat = format
    this.retainedBuffer = buffer
    const raw: Record<string, unknown> = {}
    loadCrateAudio().decoderGetInfo(handle, raw)
    this.info = toStreamInfo(raw)
  }

  static openFile(path: string, options?: DecodeOptions): Decoder {
    const b = loadCrateAudio()
    const handle = b.decoderOpenFile(path, toNativeOptions(options)) as NativeHandle | null
    if (!handle) throw new CrateAudioError(`Cannot decode ${path}: ${lastCrateAudioError()}`, -3)
    return new Decoder(handle, options?.sampleFormat ?? CA_SAMPLE_F32, null)
  }

  static async openFileAsync(path: string, options?: DecodeOptions): Promise<Decoder> {
    const b = loadCrateAudio()
    const handle = await callAsync<NativeHandle | null>(b.decoderOpenFile, path, toNativeOptions(options))
    // ca_last_error is per thread, so the async path can only report the failure.
    if (!handle) throw new CrateAudioError(`Cannot decode ${path}`, -3)
    return new Decoder(handle, options?.sampleFormat ?? CA_SAMPLE_F32, null)
  }

  static openMemory(buffer: Buffer, nameHint: string | null, options?: DecodeOptions): Decoder {
    const b = loadCrateAudio()
    const handle = b.decoderOpenMemory(buffer, buffer.byteLength, nameHint, toNativeOptions(options)) as NativeHandle | null
    if (!handle) throw new CrateAudioError(`Cannot decode ${nameHint ?? 'buffer'}: ${lastCrateAudioError()}`, -3)
    return new Decoder(handle, options?.sampleFormat ?? CA_SAMPLE_F32, buffer)
  }

  get nativeHandle(): NativeHandle {
    if (this.handle == null) throw new CrateAudioError('Decoder is closed', -8)
    return this.handle
  }

  get closed(): boolean {
    return this.handle == null
  }

  /** Keeps a memory-backed source alive for as long as the decoder exists. */
  get memoryBuffer(): Buffer | null {
    return this.retainedBuffer
  }

  private readFunction(out: Float32Array | Int16Array): KoffiFunction {
    const b = loadCrateAudio()
    if (out instanceof Float32Array) {
      if (this.sampleFormat !== CA_SAMPLE_F32) throw new CrateAudioError('Decoder produces s16 samples', -1)
      return b.decoderReadF32
    }
    if (this.sampleFormat !== CA_SAMPLE_S16) throw new CrateAudioError('Decoder produces float samples', -1)
    return b.decoderReadS16
  }

  /** Reads up to out.length / channels frames; returns frames read, 0 at the end. */
  read(out: Float32Array | Int16Array): number {
    const frames = Math.floor(out.length / this.info.channels)
    const n = Number(this.readFunction(out)(this.nativeHandle, out, frames))
    if (n < 0) throw new CrateAudioError(`Decode failed: ${lastCrateAudioError()}`, n)
    return n
  }

  /** Same as read() on a worker thread, so long decodes never block the event loop. */
  async readAsync(out: Float32Array | Int16Array): Promise<number> {
    const frames = Math.floor(out.length / this.info.channels)
    const n = Number(await callAsync<number>(this.readFunction(out), this.nativeHandle, out, frames))
    if (n < 0) throw new CrateAudioError('Decode failed', n)
    return n
  }

  seek(seconds: number): void {
    const status = Number(loadCrateAudio().decoderSeek(this.nativeHandle, seconds))
    if (status !== 0) throw new CrateAudioError(`Seek failed: ${lastCrateAudioError()}`, status)
  }

  get position(): number {
    return Number(loadCrateAudio().decoderGetPosition(this.nativeHandle))
  }

  close(): void {
    if (this.handle == null) return
    const handle = this.handle
    this.handle = null
    loadCrateAudio().decoderClose(handle)
  }
}

/** BASS_DATA_FFT2048-compatible spectrum (1024 magnitudes). */
export class Spectrum {
  private handle: NativeHandle | null

  constructor() {
    const handle = loadCrateAudio().fftCreate() as NativeHandle | null
    if (!handle) throw new CrateAudioError(`Cannot create FFT: ${lastCrateAudioError()}`, -2)
    this.handle = handle
  }

  /**
   * `frames` holds up to CA_FFT_SIZE interleaved frames; `out` receives
   * CA_FFT_BINS magnitudes. A shorter input (the end of a stream) is windowed
   * over its own length, as BASS did.
   */
  run(frames: Float32Array, channels: number, out: Float32Array): void {
    if (this.handle == null) throw new CrateAudioError('FFT is closed', -8)
    const frameCount = Math.min(CA_FFT_SIZE, Math.floor(frames.length / channels))
    if (frameCount <= 0 || out.length < CA_FFT_BINS) throw new CrateAudioError('FFT buffers too small', -1)
    loadCrateAudio().fftRun(this.handle, frames, frameCount, channels, out)
  }

  close(): void {
    if (this.handle == null) return
    loadCrateAudio().fftDestroy(this.handle)
    this.handle = null
  }
}
