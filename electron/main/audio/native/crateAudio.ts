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
  init: KoffiFunction
  shutdown: KoffiFunction
  deviceCount: KoffiFunction
  deviceGet: KoffiFunction
  deviceGetCaps: KoffiFunction
  outputOpen: KoffiFunction
  outputSetPolicy: KoffiFunction
  outputClose: KoffiFunction
  outputGetInfo: KoffiFunction
  playerCreate: KoffiFunction
  playerDestroy: KoffiFunction
  playerGetId: KoffiFunction
  playerSetSource: KoffiFunction
  playerQueueNext: KoffiFunction
  playerClearNext: KoffiFunction
  playerSkipToNext: KoffiFunction
  playerReplaceSource: KoffiFunction
  playerDetach: KoffiFunction
  playerPlay: KoffiFunction
  playerPause: KoffiFunction
  playerSeek: KoffiFunction
  playerGetStatus: KoffiFunction
  playerSetVolume: KoffiFunction
  playerSetGain: KoffiFunction
  playerSetEq: KoffiFunction
  playerGetFft: KoffiFunction
  playerGetLevels: KoffiFunction
  pollEvent: KoffiFunction
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
  koffi.opaque('ca_player')
  koffi.struct('ca_device_info', {
    id: koffi.array('char', 256),
    name: koffi.array('char', 256),
    is_default: 'int32_t',
    max_channels: 'int32_t',
    max_sample_rate: 'int32_t',
    max_bits: 'int32_t',
    supports_exclusive: 'int32_t',
    reserved: 'int32_t',
  })
  koffi.struct('ca_device_caps', {
    count: 'int32_t',
    rates: koffi.array('int32_t', 32),
    bits: koffi.array('int32_t', 32),
    depths: koffi.array('uint32_t', 32),
    max_channels: 'int32_t',
    current_rate: 'int32_t',
    current_bits: 'int32_t',
    can_set_rate: 'int32_t',
    exclusive: 'int32_t',
  })
  koffi.struct('ca_output_policy', {
    exclusive: 'int32_t',
    bit_perfect: 'int32_t',
  })
  koffi.struct('ca_output_format', {
    sample_rate: 'int32_t',
    bits: 'int32_t',
    channels: 'int32_t',
    resampled: 'int32_t',
    dithered: 'int32_t',
    downmixed: 'int32_t',
    limited_by: 'int32_t',
    reserved: 'int32_t',
  })
  koffi.struct('ca_output_info', {
    open: 'int32_t',
    sample_rate: 'int32_t',
    bits: 'int32_t',
    channels: 'int32_t',
    exclusive: 'int32_t',
    bit_perfect: 'int32_t',
    original_rate: 'int32_t',
    reserved: 'int32_t',
    current: 'ca_output_format',
    device_id: koffi.array('char', 256),
    device_name: koffi.array('char', 256),
  })
  koffi.struct('ca_player_status', {
    state: 'int32_t',
    ended: 'int32_t',
    serial: 'int64_t',
    position: 'double',
    buffered_seconds: 'double',
  })
  koffi.struct('ca_event', {
    type: 'int32_t',
    player_id: 'int32_t',
    serial: 'int64_t',
    decoder: 'uint64_t',
    code: 'int32_t',
    reserved: 'int32_t',
  })
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
      init: lib.func('int ca_init(int32_t flags)'),
      shutdown: lib.func('void ca_shutdown(void)'),
      deviceCount: lib.func('int ca_device_count(void)'),
      deviceGet: lib.func('int ca_device_get(int32_t index, _Out_ ca_device_info *out)'),
      deviceGetCaps: lib.func('int ca_device_get_caps(const char *id, int32_t exclusive, _Out_ ca_device_caps *out)'),
      outputOpen: lib.func('int ca_output_open(const char *id, const ca_output_policy *policy)'),
      outputSetPolicy: lib.func('int ca_output_set_policy(const ca_output_policy *policy)'),
      outputClose: lib.func('void ca_output_close(void)'),
      outputGetInfo: lib.func('int ca_output_get_info(_Out_ ca_output_info *out)'),
      playerCreate: lib.func('ca_player *ca_player_create(int32_t is_main)'),
      playerDestroy: lib.func('void ca_player_destroy(ca_player *player)'),
      playerGetId: lib.func('int ca_player_get_id(const ca_player *player)'),
      playerSetSource: lib.func('int ca_player_set_source(ca_player *player, ca_decoder *dec, float gain, int64_t serial)'),
      playerQueueNext: lib.func('int ca_player_queue_next(ca_player *player, ca_decoder *dec, float gain, int64_t serial)'),
      playerClearNext: lib.func('int ca_player_clear_next(ca_player *player)'),
      playerSkipToNext: lib.func('int ca_player_skip_to_next(ca_player *player, int64_t serial)'),
      playerReplaceSource: lib.func('int ca_player_replace_source(ca_player *player, ca_decoder *dec, int64_t serial)'),
      playerDetach: lib.func('int ca_player_detach(ca_player *player)'),
      playerPlay: lib.func('int ca_player_play(ca_player *player)'),
      playerPause: lib.func('int ca_player_pause(ca_player *player)'),
      playerSeek: lib.func('int ca_player_seek(ca_player *player, double seconds)'),
      playerGetStatus: lib.func('int ca_player_get_status(ca_player *player, _Out_ ca_player_status *out)'),
      playerSetVolume: lib.func('int ca_player_set_volume(ca_player *player, float volume)'),
      playerSetGain: lib.func('int ca_player_set_gain(ca_player *player, float gain)'),
      playerSetEq: lib.func('int ca_player_set_eq(ca_player *player, int32_t enabled, int32_t count, const float *freqs, const float *gains, float bandwidth)'),
      playerGetFft: lib.func('int ca_player_get_fft(ca_player *player, _Out_ float *out)'),
      playerGetLevels: lib.func('int ca_player_get_levels(ca_player *player, float window_seconds, _Out_ float *out)'),
      pollEvent: lib.func('int ca_poll_events(_Out_ ca_event *out, int32_t max)'),
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

/* ------------------------------------------------------------- engine */

export const CA_ERR_STATE = -8

export const CA_INIT_NULL_BACKEND = 0x1

export const CA_PLAYER_STOPPED = 0
export const CA_PLAYER_PLAYING = 1
export const CA_PLAYER_PAUSED = 2

export const CA_EVENT_TRACK_STARTED = 1
export const CA_EVENT_TRACK_ENDED = 2
export const CA_EVENT_DECODER_RETIRED = 3
export const CA_EVENT_OUTPUT_CHANGED = 4
export const CA_EVENT_DEVICE_LOST = 5
export const CA_EVENT_DEVICE_REROUTED = 6
export const CA_EVENT_DECODE_ERROR = 7

export const CA_LIMIT_DAC_RATE = 0x01
export const CA_LIMIT_DAC_BITS = 0x02
export const CA_LIMIT_DAC_CHANNELS = 0x04
export const CA_LIMIT_FIXED_RATE = 0x08
export const CA_LIMIT_SETTING_OFF = 0x10

export interface NativeDeviceInfo {
  id: string
  name: string
  isDefault: boolean
  maxChannels: number
  maxSampleRate: number
  maxBits: number
  supportsExclusive: boolean
}

export interface NativeOutputPolicy {
  exclusive: boolean
  bitPerfect: boolean
}

export interface NativeOutputFormat {
  sampleRate: number
  bits: number
  channels: number
  resampled: boolean
  dithered: boolean
  downmixed: boolean
  limitedBy: number
}

export interface NativeOutputInfo {
  open: boolean
  sampleRate: number
  bits: number
  channels: number
  exclusive: boolean
  bitPerfect: boolean
  originalRate: number
  current: NativeOutputFormat
  deviceId: string
  deviceName: string
}

export interface NativePlayerStatus {
  state: number
  ended: boolean
  serial: number
  position: number
  bufferedSeconds: number
}

export interface NativeEvent {
  type: number
  playerId: number
  serial: number
  decoder: bigint
  code: number
}

function check(status: number, what: string): void {
  if (status < 0) throw new CrateAudioError(`${what} failed: ${lastCrateAudioError() || `error ${status}`}`, status)
}

async function checkAsync(promise: Promise<number>, what: string): Promise<void> {
  const status = Number(await promise)
  // ca_last_error is per thread; the async call ran elsewhere.
  if (status < 0) throw new CrateAudioError(`${what} failed (error ${status})`, status)
}

function nativePolicy(policy: NativeOutputPolicy) {
  return { exclusive: policy.exclusive ? 1 : 0, bit_perfect: policy.bitPerfect ? 1 : 0 }
}

function toFormat(raw: Record<string, unknown>): NativeOutputFormat {
  return {
    sampleRate: Number(raw.sample_rate),
    bits: Number(raw.bits),
    channels: Number(raw.channels),
    resampled: Boolean(raw.resampled),
    dithered: Boolean(raw.dithered),
    downmixed: Boolean(raw.downmixed),
    limitedBy: Number(raw.limited_by),
  }
}

let engineInitialised = false

/** Initialises the engine once per process (real audio devices). */
export function initEngine(flags = 0): void {
  if (engineInitialised) return
  check(Number(loadCrateAudio().init(flags)), 'Audio engine start')
  engineInitialised = true
}

export function shutdownEngine(): void {
  if (!engineInitialised) return
  loadCrateAudio().shutdown()
  engineInitialised = false
}

export function listNativeDevices(): NativeDeviceInfo[] {
  const b = loadCrateAudio()
  const count = Number(b.deviceCount())
  check(count, 'Listing audio devices')
  const devices: NativeDeviceInfo[] = []
  for (let index = 0; index < count; index++) {
    const raw: Record<string, unknown> = {}
    if (Number(b.deviceGet(index, raw)) !== 0) continue
    devices.push({
      id: String(raw.id ?? ''),
      name: String(raw.name ?? ''),
      isDefault: Boolean(raw.is_default),
      maxChannels: Number(raw.max_channels),
      maxSampleRate: Number(raw.max_sample_rate),
      maxBits: Number(raw.max_bits),
      supportsExclusive: Boolean(raw.supports_exclusive),
    })
  }
  return devices
}

export async function openOutput(deviceId: string | null, policy: NativeOutputPolicy): Promise<void> {
  await checkAsync(callAsync<number>(loadCrateAudio().outputOpen, deviceId, nativePolicy(policy)), 'Opening the audio output')
}

export async function setOutputPolicy(policy: NativeOutputPolicy): Promise<void> {
  await checkAsync(callAsync<number>(loadCrateAudio().outputSetPolicy, nativePolicy(policy)), 'Changing the output mode')
}

export function closeOutput(): void {
  loadCrateAudio().outputClose()
}

export function getOutputInfo(): NativeOutputInfo {
  const raw: Record<string, unknown> = {}
  loadCrateAudio().outputGetInfo(raw)
  return {
    open: Boolean(raw.open),
    sampleRate: Number(raw.sample_rate),
    bits: Number(raw.bits),
    channels: Number(raw.channels),
    exclusive: Boolean(raw.exclusive),
    bitPerfect: Boolean(raw.bit_perfect),
    originalRate: Number(raw.original_rate),
    current: toFormat((raw.current ?? {}) as Record<string, unknown>),
    deviceId: String(raw.device_id ?? ''),
    deviceName: String(raw.device_name ?? ''),
  }
}

/** Drains pending engine events. */
export function pollEvents(): NativeEvent[] {
  const b = loadCrateAudio()
  const events: NativeEvent[] = []
  for (let guard = 0; guard < 256; guard++) {
    const raw: Record<string, unknown> = {}
    if (Number(b.pollEvent(raw, 1)) <= 0) break
    events.push({
      type: Number(raw.type),
      playerId: Number(raw.player_id),
      serial: Number(raw.serial),
      decoder: BigInt(raw.decoder as number | bigint),
      code: Number(raw.code),
    })
  }
  return events
}

/**
 * A native player: one output stream mixed into the device. Decoders handed
 * to it stay owned by the caller, who closes them once the player gives them
 * back (see crate_audio.h).
 */
export class NativePlayer {
  private handle: NativeHandle | null
  readonly id: number
  private readonly fftOut = new Float32Array(CA_FFT_BINS)
  private readonly levelsOut = new Float32Array(4)

  constructor(isMain: boolean) {
    const b = loadCrateAudio()
    const handle = b.playerCreate(isMain ? 1 : 0) as NativeHandle | null
    if (!handle) throw new CrateAudioError(`Cannot create a player: ${lastCrateAudioError()}`, -2)
    this.handle = handle
    this.id = Number(b.playerGetId(handle))
  }

  private get native(): NativeHandle {
    if (this.handle == null) throw new CrateAudioError('Player is destroyed', -8)
    return this.handle
  }

  setSource(decoder: Decoder, gain: number, serial: number): Promise<void> {
    return checkAsync(callAsync<number>(loadCrateAudio().playerSetSource, this.native, decoder.nativeHandle, gain, serial), 'Loading the track')
  }

  queueNext(decoder: Decoder, gain: number, serial: number): Promise<void> {
    return checkAsync(callAsync<number>(loadCrateAudio().playerQueueNext, this.native, decoder.nativeHandle, gain, serial), 'Queueing the next track')
  }

  clearNext(): void {
    check(Number(loadCrateAudio().playerClearNext(this.native)), 'Clearing the queued track')
  }

  /** Resolves false when `serial` is no longer queued. */
  async skipToNext(serial: number): Promise<boolean> {
    const status = Number(await callAsync<number>(loadCrateAudio().playerSkipToNext, this.native, serial))
    if (status === CA_ERR_STATE) return false
    if (status < 0) throw new CrateAudioError(`Skipping to the next track failed (error ${status})`, status)
    return true
  }

  /** Resolves false when `serial` is no longer the current track. */
  async replaceSource(decoder: Decoder, serial: number): Promise<boolean> {
    const status = Number(await callAsync<number>(loadCrateAudio().playerReplaceSource, this.native, decoder.nativeHandle, serial))
    if (status === CA_ERR_STATE) return false
    if (status < 0) throw new CrateAudioError(`Switching the track to memory failed (error ${status})`, status)
    return true
  }

  detach(): void {
    loadCrateAudio().playerDetach(this.native)
  }

  play(): void {
    check(Number(loadCrateAudio().playerPlay(this.native)), 'Starting playback')
  }

  pause(): void {
    loadCrateAudio().playerPause(this.native)
  }

  seek(seconds: number): void {
    check(Number(loadCrateAudio().playerSeek(this.native, seconds)), 'Seeking')
  }

  status(): NativePlayerStatus {
    const raw: Record<string, unknown> = {}
    loadCrateAudio().playerGetStatus(this.native, raw)
    return {
      state: Number(raw.state),
      ended: Boolean(raw.ended),
      serial: Number(raw.serial),
      position: Number(raw.position),
      bufferedSeconds: Number(raw.buffered_seconds),
    }
  }

  setVolume(volume: number): void {
    loadCrateAudio().playerSetVolume(this.native, volume)
  }

  setGain(gain: number): void {
    loadCrateAudio().playerSetGain(this.native, gain)
  }

  setEq(enabled: boolean, freqs: number[], gains: number[], bandwidthOctaves: number): void {
    const count = Math.min(freqs.length, gains.length, 32)
    loadCrateAudio().playerSetEq(
      this.native,
      enabled ? 1 : 0,
      count,
      Float32Array.from(freqs.slice(0, count)),
      Float32Array.from(gains.slice(0, count)),
      bandwidthOctaves,
    )
  }

  /** BASS_DATA_FFT2048-compatible magnitudes of what is being heard. */
  fft(): Float32Array {
    loadCrateAudio().playerGetFft(this.native, this.fftOut)
    return this.fftOut
  }

  /** [peakL, peakR, rmsL, rmsR] over the last `windowSeconds`. */
  levels(windowSeconds: number): Float32Array {
    loadCrateAudio().playerGetLevels(this.native, windowSeconds, this.levelsOut)
    return this.levelsOut
  }

  destroy(): void {
    if (this.handle == null) return
    const handle = this.handle
    this.handle = null
    loadCrateAudio().playerDestroy(handle)
  }
}
