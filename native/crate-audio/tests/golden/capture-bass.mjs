#!/usr/bin/env node
// One-off capture of BASS reference data, run while BASS was still Crate's
// engine. The outputs in this directory let the FFmpeg engine reproduce the
// exact visualizer, meter, EQ and DSD behaviour users were used to:
//
//   fft-<name>.in.f32 / fft-<name>.bass.f32   BASS_DATA_FFT2048 of a known input
//   levels-<name>.in.f32 + levels.txt         BASS_ChannelGetLevelEx (peak/RMS)
//   eq-<name>.ir.f32 + eq.txt                 BASS_FX BQF peaking-EQ impulse responses
//   dsd.txt                                   BASSDSD output level
//   analysis-<fixture>.json                   waveform + table bars (AudioEngine algorithms)
//
// Needs the BASS libraries in native/libs (npm run fetch:bass). Kept for
// provenance only; BASS is no longer part of Crate.

import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const koffi = require('koffi')
const OUT = dirname(fileURLToPath(import.meta.url))
const LIBS = resolve(OUT, '..', '..', '..', 'libs')
const FIXTURES = resolve(OUT, '..', 'fixtures')
const WORK = mkdtempSync(join(tmpdir(), 'crate-bass-golden-'))
const lib = name => join(LIBS, process.platform === 'darwin' ? `lib${name}.dylib` : process.platform === 'win32' ? `${name}.dll` : `lib${name}.so`)

const BASS_STREAM_DECODE = 0x200000
const BASS_STREAM_PRESCAN = 0x20000
const BASS_SAMPLE_FLOAT = 256
const BASS_POS_BYTE = 0
const BASS_DATA_FFT2048 = 0x80000003
const BASS_LEVEL_RMS = 2
const BASS_LEVEL_STEREO = 4
const BASS_FX_BFX_BQF = 0x10013
const BASS_BFX_BQF_PEAKINGEQ = 6

const bass = koffi.load(lib('bass'))
const BQF = koffi.struct('GoldenBQF', {
  lFilter: 'int32_t', fCenter: 'float', fGain: 'float', fBandwidth: 'float', fQ: 'float', fS: 'float', lChannel: 'int32_t',
})
const Info = koffi.struct('GoldenChannelInfo', {
  freq: 'uint32_t', chans: 'uint32_t', flags: 'uint32_t', ctype: 'uint32_t', origres: 'uint32_t', plugin: 'uint32_t', sample: 'uint32_t', filename: 'const char*',
})
const B = {
  Init: bass.func('int32_t BASS_Init(int32_t, uint32_t, uint32_t, uint64_t, uint64_t)'),
  ErrorGetCode: bass.func('int32_t BASS_ErrorGetCode(void)'),
  PluginLoad: bass.func('uint32_t BASS_PluginLoad(const char *, uint32_t)'),
  StreamCreateFile: bass.func('uint32_t BASS_StreamCreateFile(int32_t, const char *, uint64_t, uint64_t, uint32_t)'),
  StreamFree: bass.func('int32_t BASS_StreamFree(uint32_t)'),
  GetData: bass.func('uint32_t BASS_ChannelGetData(uint32_t, _Out_ float *, uint32_t)'),
  GetLevelEx: bass.func('int32_t BASS_ChannelGetLevelEx(uint32_t, _Out_ float *, float, uint32_t)'),
  SetPosition: bass.func('int32_t BASS_ChannelSetPosition(uint32_t, uint64_t, uint32_t)'),
  GetLength: bass.func('uint64_t BASS_ChannelGetLength(uint32_t, uint32_t)'),
  Seconds2Bytes: bass.func('uint64_t BASS_ChannelSeconds2Bytes(uint32_t, double)'),
  GetInfo: bass.func('int32_t BASS_ChannelGetInfo(uint32_t, _Out_ GoldenChannelInfo *)'),
  SetFX: bass.func('uint32_t BASS_ChannelSetFX(uint32_t, uint32_t, int32_t)'),
  FXSetParameters: bass.func('int32_t BASS_FXSetParameters(uint32_t, const GoldenBQF *)'),
}
koffi.load(lib('bass_fx'))  // registers the BFX effects with BASS

function fail(what) {
  throw new Error(`${what} failed (BASS error ${B.ErrorGetCode()})`)
}

function floatWav(rate, channels, samples) {
  const buffer = Buffer.alloc(44 + samples.length * 4)
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVE', 8)
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(3, 20); buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * channels * 4, 28); buffer.writeUInt16LE(channels * 4, 32); buffer.writeUInt16LE(32, 34)
  buffer.write('data', 36); buffer.writeUInt32LE(samples.length * 4, 40)
  for (let i = 0; i < samples.length; i++) buffer.writeFloatLE(samples[i], 44 + i * 4)
  return buffer
}

function decodeStream(path, flags = 0) {
  const handle = B.StreamCreateFile(0, path, 0n, 0n, BASS_STREAM_DECODE | BASS_SAMPLE_FLOAT | flags)
  if (!handle) fail(`StreamCreateFile(${path})`)
  return handle
}

function writeF32(name, data) {
  writeFileSync(join(OUT, name), Buffer.from(Float32Array.from(data).buffer))
}

function stereoSignal(frames, left, right) {
  const out = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i++) {
    out[i * 2] = left(i)
    out[i * 2 + 1] = right(i)
  }
  return out
}

function noise(seed) {
  let state = seed >>> 0
  return () => {
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    return (state / 0xffffffff) * 2 - 1
  }
}

try {
  if (!B.Init(0, 44100, 0, 0n, 0n)) fail('BASS_Init(no sound)')
  for (const plugin of ['bassflac', 'bassdsd']) if (!B.PluginLoad(lib(plugin), 0)) fail(`PluginLoad(${plugin})`)
  const rate = 44100
  const tau = 2 * Math.PI
  const binFreq = 46 * rate / 2048

  // --- FFT2048
  const left = noise(0x1234abcd)
  const right = noise(0x55aa1234)
  const fftSignals = {
    'bin46-fullscale': stereoSignal(2048, i => Math.sin(tau * binFreq * i / rate), i => Math.sin(tau * binFreq * i / rate)),
    'bin46-left-only': stereoSignal(2048, i => 0.5 * Math.sin(tau * binFreq * i / rate), () => 0),
    '1khz-quarter': stereoSignal(2048, i => 0.25 * Math.sin(tau * 1000 * i / rate), i => 0.25 * Math.sin(tau * 1000 * i / rate)),
    'noise': stereoSignal(2048, () => 0.5 * left(), () => 0.5 * right()),
  }
  for (const [name, signal] of Object.entries(fftSignals)) {
    const path = join(WORK, `${name}.wav`)
    writeFileSync(path, floatWav(rate, 2, signal))
    const handle = decodeStream(path)
    const out = new Float32Array(1024)
    if (B.GetData(handle, out, BASS_DATA_FFT2048) === 0xffffffff) fail(`FFT ${name}`)
    B.StreamFree(handle)
    writeF32(`fft-${name}.in.f32`, signal)
    writeF32(`fft-${name}.bass.f32`, out)
  }

  // --- Levels (AudioEngine uses a 35 ms window, STEREO and STEREO|RMS)
  const levelSignals = {
    'sines': stereoSignal(4096, i => 0.5 * Math.sin(tau * 440 * i / rate), i => 0.25 * Math.sin(tau * 660 * i / rate)),
    'noise': stereoSignal(4096, () => 0.8 * left(), () => 0.3 * right()),
  }
  const levelLines = ['# name window_frames peakL peakR rmsL rmsR']
  for (const [name, signal] of Object.entries(levelSignals)) {
    const path = join(WORK, `levels-${name}.wav`)
    writeFileSync(path, floatWav(rate, 2, signal))
    const handle = decodeStream(path)
    const peak = new Float32Array(2)
    const rms = new Float32Array(2)
    if (!B.GetLevelEx(handle, peak, 0.035, BASS_LEVEL_STEREO)) fail('GetLevelEx peak')
    B.SetPosition(handle, 0n, BASS_POS_BYTE)
    if (!B.GetLevelEx(handle, rms, 0.035, BASS_LEVEL_STEREO | BASS_LEVEL_RMS)) fail('GetLevelEx rms')
    const windowFrames = Number(B.Seconds2Bytes(handle, 0.035)) / 8
    B.StreamFree(handle)
    writeF32(`levels-${name}.in.f32`, signal)
    levelLines.push(`${name} ${windowFrames} ${peak[0]} ${peak[1]} ${rms[0]} ${rms[1]}`)
  }
  writeFileSync(join(OUT, 'levels.txt'), `${levelLines.join('\n')}\n`)

  // --- EQ: BASS_FX BQF peaking filter impulse responses (EQManager's setup)
  const eqCases = [
    { name: '1000hz-plus6-bw1', center: 1000, gain: 6, bandwidth: 1 },
    { name: '100hz-minus9-bw05', center: 100, gain: -9, bandwidth: 0.5 },
    { name: '8000hz-plus12-bw2', center: 8000, gain: 12, bandwidth: 2 },
    { name: '16000hz-plus15-bw067', center: 16000, gain: 15, bandwidth: 0.67 },
  ]
  const impulse = new Float32Array(4096 * 2)
  impulse[0] = 1
  impulse[1] = 1
  const impulsePath = join(WORK, 'impulse.wav')
  writeFileSync(impulsePath, floatWav(rate, 2, impulse))
  const eqLines = ['# name rate center_hz gain_db bandwidth_octaves']
  for (const eq of eqCases) {
    const handle = decodeStream(impulsePath)
    const fx = B.SetFX(handle, BASS_FX_BFX_BQF, 0)
    if (!fx) fail('ChannelSetFX(BQF)')
    if (!B.FXSetParameters(fx, { lFilter: BASS_BFX_BQF_PEAKINGEQ, fCenter: eq.center, fGain: eq.gain, fBandwidth: eq.bandwidth, fQ: 0, fS: 0, lChannel: -1 })) {
      fail('FXSetParameters')
    }
    const out = new Float32Array(4096 * 2)
    const bytes = B.GetData(handle, out, out.byteLength)
    if (bytes !== out.byteLength) fail(`EQ read (${bytes})`)
    B.StreamFree(handle)
    writeF32(`eq-${eq.name}.ir.f32`, out.filter((_, index) => index % 2 === 0))
    eqLines.push(`${eq.name} ${rate} ${eq.center} ${eq.gain} ${eq.bandwidth}`)
  }
  writeFileSync(join(OUT, 'eq.txt'), `${eqLines.join('\n')}\n`)

  // --- DSD level (BASSDSD defaults: 88.2 kHz PCM, +6 dB)
  const dsdLines = ['# fixture rate rmsL rmsR (after the first 50 ms)']
  for (const fixture of ['dsd64-stereo.dsf', 'dsd64-stereo.dff', 'dsd128-stereo.dsf']) {
    const handle = decodeStream(join(FIXTURES, fixture))
    const info = {}
    B.GetInfo(handle, info)
    const samples = []
    const buffer = new Float32Array(8192)
    for (;;) {
      const bytes = B.GetData(handle, buffer, buffer.byteLength)
      if (bytes === 0xffffffff || bytes === 0) break
      samples.push(...buffer.subarray(0, bytes / 4))
    }
    B.StreamFree(handle)
    const skip = Math.round(info.freq * 0.05) * info.chans
    const rms = [0, 1].map(channel => {
      let sum = 0
      let count = 0
      for (let i = skip + channel; i < samples.length; i += info.chans) { sum += samples[i] ** 2; count++ }
      return Math.sqrt(sum / count)
    })
    dsdLines.push(`${fixture} ${info.freq} ${rms[0]} ${rms[1]}`)
  }
  writeFileSync(join(OUT, 'dsd.txt'), `${dsdLines.join('\n')}\n`)

  // --- Waveform + table bars, exactly as AudioEngine computed them with BASS
  const FFT_BINS_OUT = 64
  const FFT_LOG_INDEX = Array.from({ length: FFT_BINS_OUT }, (_, i) =>
    Math.max(1, Math.min(1023, Math.floor(Math.pow(1023, i / (FFT_BINS_OUT - 1))))))
  for (const fixture of ['flac-44100-16-stereo.flac', 'pcm-22050-16-mono.wav', 'flac-48000-16-5.1.flac']) {
    const path = join(FIXTURES, fixture)
    // Waveform (decodePlaybackAnalysis, 1200 buckets)
    let handle = decodeStream(path)
    const info = {}
    B.GetInfo(handle, info)
    const chans = Math.max(1, info.chans)
    const lengthBytes = Number(B.GetLength(handle, BASS_POS_BYTE))
    const buckets = 1200
    const totalFrames = Math.max(1, Math.floor(lengthBytes / (4 * chans)))
    const framesPerBucket = Math.max(1, Math.floor(totalFrames / buckets))
    const peaks = new Array(buckets).fill(0)
    const readFloats = 65536 - (65536 % chans)
    const buf = new Float32Array(readFloats)
    let frameCursor = 0
    let globalPeak = 0
    let sumSq = 0
    let sampleCount = 0
    for (;;) {
      const ret = B.GetData(handle, buf, readFloats * 4)
      if (ret === 0xffffffff) break
      const floatsRead = ret >>> 2
      if (floatsRead === 0) break
      for (let i = 0; i + chans <= floatsRead; i += chans) {
        let frameMax = 0
        for (let c = 0; c < chans; c++) {
          const s = buf[i + c]
          frameMax = Math.max(frameMax, Math.abs(s))
          sumSq += s * s
        }
        sampleCount += chans
        globalPeak = Math.max(globalPeak, frameMax)
        const b = Math.min(buckets - 1, Math.floor(frameCursor / framesPerBucket))
        peaks[b] = Math.max(peaks[b], frameMax)
        frameCursor++
      }
    }
    B.StreamFree(handle)
    const rms = Math.sqrt(sumSq / Math.max(1, sampleCount))
    const waveform = {
      peaks,
      drApprox: 20 * Math.log10(Math.max(1e-6, globalPeak) / Math.max(1e-6, rms)),
      peakDb: 20 * Math.log10(Math.max(1e-6, globalPeak)),
      frames: frameCursor,
    }

    // Table bars (decodeTableBars: 60 fps, 5 bands, display gain 2.8)
    handle = decodeStream(path, BASS_STREAM_PRESCAN)
    const tbInfo = {}
    B.GetInfo(handle, tbInfo)
    const tbLength = Number(B.GetLength(handle, BASS_POS_BYTE))
    const bytesPerSecond = tbInfo.freq * tbInfo.chans * 4
    const duration = tbLength / bytesPerSecond
    const frames = Math.max(1, Math.ceil(duration * 60))
    const values = new Array(frames * 5).fill(0)
    const fft = new Float32Array(1024)
    for (let frame = 0; frame < frames; frame++) {
      const seconds = Math.min(duration, frame / 60)
      B.SetPosition(handle, BigInt(Math.floor(seconds * bytesPerSecond)), BASS_POS_BYTE)
      const ret = B.GetData(handle, fft, BASS_DATA_FFT2048)
      if (ret === 0xffffffff || ret === 0) continue
      const bins = FFT_LOG_INDEX.map(idx => Math.min(1, Math.sqrt(Math.max(0, fft[idx])) * 1.6))
      for (let b = 0; b < 5; b++) {
        const start = Math.floor((b * 64) / 5)
        const end = Math.max(start + 1, Math.floor(((b + 1) * 64) / 5))
        let sum = 0
        for (let i = start; i < end; i++) sum += bins[i]
        const raw = Math.max(0, Math.min(1, sum / (end - start)))
        values[frame * 5 + b] = Math.max(0, Math.min(1, Math.sqrt(raw * 2.8)))
      }
    }
    B.StreamFree(handle)
    writeFileSync(join(OUT, `analysis-${fixture}.json`), `${JSON.stringify({ fixture, waveform, tableBars: { fps: 60, bands: 5, frames, durationSec: duration, values } })}\n`)
  }
  console.log('[capture-bass] done')
} finally {
  rmSync(WORK, { recursive: true, force: true })
}
