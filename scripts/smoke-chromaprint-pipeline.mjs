#!/usr/bin/env node
// End-to-end native smoke: decode a Unicode-path WAV through BASS as bounded
// int16 PCM, stream it into Chromaprint, and compare the frozen raw fingerprint.

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromaprintLibraryName } from './chromaprint-config.mjs'
import {
  EXPECTED_SMOKE_ITEMS,
  EXPECTED_SMOKE_SHA256,
  makeSmokePcm,
} from './verify-chromaprint.mjs'

const require = createRequire(import.meta.url)
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')

function flag(name) {
  const hit = process.argv.slice(2).find(arg => arg.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : undefined
}

const LIBRARY_DIR = resolve(REPO_ROOT, flag('--dir') ?? join('native', 'libs'))
const BASS_DIR = resolve(REPO_ROOT, flag('--bass-dir') ?? LIBRARY_DIR)
const CHROMAPRINT_DIR = resolve(REPO_ROOT, flag('--chromaprint-dir') ?? LIBRARY_DIR)

function bassLibraryName() {
  if (process.platform === 'win32') return 'bass.dll'
  if (process.platform === 'linux') return 'libbass.so'
  return 'libbass.dylib'
}

function wavFromMono16(sampleRate, samples) {
  const dataBytes = samples.length * Int16Array.BYTES_PER_ELEMENT
  const wav = Buffer.alloc(44 + dataBytes)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(dataBytes, 40)
  for (let index = 0; index < samples.length; index += 1) {
    wav.writeInt16LE(samples[index], 44 + index * 2)
  }
  return wav
}

function digestRaw(values) {
  const encoded = Buffer.alloc(values.length * 4)
  for (let index = 0; index < values.length; index += 1) {
    encoded.writeUInt32LE(values[index] >>> 0, index * 4)
  }
  return createHash('sha256').update(encoded).digest('hex')
}

async function main() {
  const koffi = require('koffi')
  const bass = koffi.load(join(BASS_DIR, bassLibraryName()))
  const chromaprint = koffi.load(join(CHROMAPRINT_DIR, chromaprintLibraryName(process.platform)))

  const BassInit = bass.func('int32_t BASS_Init(int32_t, uint32_t, uint32_t, uint64_t, uint64_t)')
  const BassFree = bass.func('int32_t BASS_Free(void)')
  const BassError = bass.func('int32_t BASS_ErrorGetCode(void)')
  const BassCreateUtf8 = bass.func('uint32_t BASS_StreamCreateFile(int32_t, const char *, uint64_t, uint64_t, uint32_t)')
  const BassCreateUtf16 = bass.func('BASS_StreamCreateFile', 'uint32_t', ['int32_t', 'str16', 'uint64_t', 'uint64_t', 'uint32_t'])
  const BassRead = bass.func('BASS_ChannelGetData', 'uint32_t', ['uint32_t', koffi.out(koffi.pointer('int16_t')), 'uint32_t'])
  const BassStreamFree = bass.func('int32_t BASS_StreamFree(uint32_t)')

  const Context = koffi.opaque('PipelineChromaprintContext')
  const ContextPointer = koffi.pointer(Context)
  const New = chromaprint.func('chromaprint_new', ContextPointer, ['int'])
  const Free = chromaprint.func('chromaprint_free', 'void', [ContextPointer])
  const Start = chromaprint.func('chromaprint_start', 'int', [ContextPointer, 'int', 'int'])
  const Feed = chromaprint.func('chromaprint_feed', 'int', [ContextPointer, 'const int16_t *', 'int'])
  const Finish = chromaprint.func('chromaprint_finish', 'int', [ContextPointer])
  const GetRaw = chromaprint.func(
    'chromaprint_get_raw_fingerprint',
    'int',
    [ContextPointer, koffi.out(koffi.pointer('uint32_t', 2)), koffi.out(koffi.pointer('int'))],
  )
  const Dealloc = chromaprint.func('chromaprint_dealloc', 'void', ['void *'])

  const temporary = await mkdtemp(join(tmpdir(), 'crate-native-pipeline-'))
  let stream = 0
  let context = null
  let rawPointer = null
  try {
    const { sampleRate, samples } = makeSmokePcm()
    const audioPath = join(temporary, 'canción-音.wav')
    await writeFile(audioPath, wavFromMono16(sampleRate, samples), { flag: 'wx' })
    if (!BassInit(0, sampleRate, 0, 0n, 0n)) throw new Error(`BASS_Init(0) failed (${BassError()})`)
    const flags = (0x200000 | (process.platform === 'win32' ? 0x80000000 : 0)) >>> 0
    stream = process.platform === 'win32'
      ? BassCreateUtf16(0, audioPath, 0n, 0n, flags)
      : BassCreateUtf8(0, audioPath, 0n, 0n, flags)
    if (!stream) throw new Error(`BASS could not open the Unicode smoke path (${BassError()})`)

    context = New(1)
    if (!context || !Start(context, sampleRate, 1)) throw new Error('Chromaprint pipeline start failed')
    const pcm = new Int16Array(4096)
    let decodedSamples = 0
    for (;;) {
      const bytes = BassRead(stream, pcm, pcm.byteLength)
      if (bytes === 0xffffffff || bytes === 0) break
      if (bytes > pcm.byteLength || bytes % 2 !== 0) throw new Error(`BASS returned invalid PCM length ${bytes}`)
      const count = bytes / 2
      if (!Feed(context, pcm.subarray(0, count), count)) throw new Error('Chromaprint pipeline feed failed')
      decodedSamples += count
    }
    if (decodedSamples !== samples.length) {
      throw new Error(`BASS pipeline decoded ${decodedSamples}/${samples.length} samples`)
    }
    if (!Finish(context)) throw new Error('Chromaprint pipeline finish failed')
    const pointerOut = [null]
    const sizeOut = [0]
    if (!GetRaw(context, pointerOut, sizeOut) || !pointerOut[0]) throw new Error('Chromaprint pipeline raw output failed')
    rawPointer = pointerOut[0]
    const values = koffi.decode(rawPointer, 'uint32_t', sizeOut[0])
    const digest = digestRaw(values)
    if (sizeOut[0] !== EXPECTED_SMOKE_ITEMS || digest !== EXPECTED_SMOKE_SHA256) {
      throw new Error(`BASS/Chromaprint frozen fingerprint mismatch (${sizeOut[0]} items, ${digest})`)
    }
    console.log(`[smoke-chromaprint-pipeline] BASS int16 -> Chromaprint passed (${decodedSamples} samples, ${digest})`)
  } finally {
    if (rawPointer) Dealloc(rawPointer)
    if (context) Free(context)
    if (stream) BassStreamFree(stream)
    BassFree()
    await rm(temporary, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(`[smoke-chromaprint-pipeline] failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
