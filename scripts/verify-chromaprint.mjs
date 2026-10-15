#!/usr/bin/env node
// Verify the pinned Chromaprint shared library, its provenance manifest, target
// architecture, bundled source, and (optionally) the native ABI/fingerprint.

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { lstat, open, readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArchitectures, readRuntimeDependencies } from './native-binary.mjs'
import {
  CHROMAPRINT_ALGORITHM,
  CHROMAPRINT_CMAKE_FLAGS,
  CHROMAPRINT_LICENSE_DIR,
  CHROMAPRINT_MANIFEST,
  CHROMAPRINT_SOURCE_NAME,
  CHROMAPRINT_SOURCE_SHA256,
  CHROMAPRINT_SOURCE_URL,
  CHROMAPRINT_VERSION,
  LGPL_2_1_SHA256,
  chromaprintLibraryName,
  normalizeChromaprintTarget,
} from './chromaprint-config.mjs'

export { parseArchitectures }

const require = createRequire(import.meta.url)
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const MIN_LIBRARY_BYTES = 4 * 1024
const MAX_LIBRARY_BYTES = 32 * 1024 * 1024
export const EXPECTED_SMOKE_ITEMS = 140
export const EXPECTED_SMOKE_SHA256 = '08b03af94661e013b41b79373eb7bac6f49e8e53fecd1b74e1d29db5b7668174'
const EXPECTED_SAMPLE_RATE = 11_025
const EXPECTED_ITEM_DURATION_SAMPLES = 1_365
const EXPECTED_DELAY_SAMPLES = 28_666

function flag(name) {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : undefined
}

const TARGET = normalizeChromaprintTarget(
  flag('--platform') ?? process.platform,
  flag('--arch') ?? process.arch,
)
const EXPLICIT_DIR = flag('--dir')
const EXPLICIT_LICENSES_DIR = flag('--licenses-dir')
const PACKAGED_ROOT = flag('--packaged-root')
const LOAD = process.argv.slice(2).includes('--load')

if (LOAD && TARGET.platform !== process.platform) {
  throw new Error(`Cannot load ${TARGET.platform} libraries on ${process.platform}`)
}
if (LOAD && TARGET.platform !== 'darwin' && TARGET.arch !== process.arch) {
  throw new Error(`Cannot load ${TARGET.arch} libraries on ${process.arch}`)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function classifyManifestBinary(
  manifestBinary,
  binary,
  { platform, packaged = false, sourceBinary } = {},
) {
  const matchesManifest = (candidate) => (
    manifestBinary?.sha256 === sha256(candidate)
    && manifestBinary?.bytes === candidate.length
  )
  if (matchesManifest(binary)) return 'exact'
  if (platform === 'darwin' && packaged && sourceBinary && matchesManifest(sourceBinary)) {
    return 'macos-resigned'
  }
  throw new Error('Chromaprint binary does not match its provenance manifest')
}

function expectedArchitectures(target) {
  return target.arch === 'universal' ? ['arm64', 'x64'] : [target.arch]
}

function assertStringArrayEqual(actual, expected, label) {
  const left = [...new Set(actual)].sort()
  const right = [...new Set(expected)].sort()
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} mismatch: expected ${right.join('+')}, got ${left.join('+') || 'none'}`)
  }
}

export function assertNoExternalAudioDependencies(binary) {
  const text = binary.toString('latin1').toLowerCase()
  const forbidden = [
    /libavcodec(?:-[0-9]+)?\.(?:so(?:\.[0-9]+)*|dylib|dll)/,
    /avcodec-[0-9]+\.dll/,
    /libavutil(?:-[0-9]+)?\.(?:so(?:\.[0-9]+)*|dylib|dll)/,
    /avutil-[0-9]+\.dll/,
    /lib(?:sw|av)resample(?:-[0-9]+)?\.(?:so(?:\.[0-9]+)*|dylib|dll)/,
    /(?:sw|av)resample-[0-9]+\.dll/,
    /libfftw3f?\.(?:so(?:\.[0-9]+)*|dylib|dll)/,
    /fftw3f?-[0-9]+\.dll/,
    /libkissfft[^\0\r\n]*\.(?:so(?:\.[0-9]+)*|dylib)/,
    /kissfft[^\0\r\n]*\.dll/,
  ]
  const hit = forbidden.find((pattern) => pattern.test(text))
  if (hit) throw new Error(`Chromaprint has a forbidden external FFmpeg/FFTW/KissFFT dependency (${hit})`)
}

export function assertExpectedRuntimeDependencies(dependencies, platform) {
  const unexpected = dependencies.filter((dependency) => {
    const normalized = dependency.trim()
    if (!normalized) return false
    if (platform === 'darwin') {
      return !(
        normalized.startsWith('/usr/lib/')
        || normalized.startsWith('/System/Library/')
        || /(?:^|\/)libchromaprint(?:\.\d+)*\.dylib$/i.test(normalized)
      )
    }
    if (platform === 'linux') {
      return !new Set([
        'libc.so.6',
        'libdl.so.2',
        'libgcc_s.so.1',
        'libm.so.6',
        'libpthread.so.0',
        'librt.so.1',
        'libstdc++.so.6',
      ]).has(normalized)
    }
    return normalized.toUpperCase() !== 'KERNEL32.DLL'
  })
  if (unexpected.length > 0) {
    throw new Error(`Chromaprint has unexpected runtime dependencies: ${unexpected.join(', ')}`)
  }
}

function runtimeDependencies(libraryPath, binary) {
  return readRuntimeDependencies(TARGET.platform, libraryPath, binary, 'Chromaprint')
}

async function readManifest(directory) {
  const path = join(directory, CHROMAPRINT_MANIFEST)
  let parsed
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed.schemaVersion !== 1 || parsed.name !== 'chromaprint') throw new Error(`${path} has an unsupported schema`)
  if (parsed.version !== CHROMAPRINT_VERSION) throw new Error(`${path} must pin Chromaprint ${CHROMAPRINT_VERSION}`)
  if (parsed.algorithm !== CHROMAPRINT_ALGORITHM) throw new Error(`${path} has the wrong default algorithm`)
  if (parsed.source?.url !== CHROMAPRINT_SOURCE_URL || parsed.source?.sha256 !== CHROMAPRINT_SOURCE_SHA256) {
    throw new Error(`${path} does not reference the pinned upstream source`)
  }
  if (parsed.build?.fft !== 'kissfft' || parsed.build?.shared !== true || parsed.build?.externalAudioLibraries !== false) {
    throw new Error(`${path} must describe a shared KissFFT build without external audio libraries`)
  }
  for (const requiredFlag of CHROMAPRINT_CMAKE_FLAGS) {
    if (!parsed.build?.cmakeFlags?.includes(requiredFlag)) throw new Error(`${path} is missing build flag ${requiredFlag}`)
  }
  if (!parsed.build?.cmakeFlags?.includes('-DKISSFFT_SOURCE_DIR=<source>/src/3rdparty/kissfft')) {
    throw new Error(`${path} does not force the vendored KissFFT source`)
  }
  const platformFlags = TARGET.platform === 'darwin'
    ? ['-DCMAKE_OSX_ARCHITECTURES=x86_64;arm64', '-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0']
    : TARGET.platform === 'win32'
      ? ['-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded']
      : []
  for (const requiredFlag of platformFlags) {
    if (!parsed.build?.cmakeFlags?.includes(requiredFlag)) throw new Error(`${path} is missing target build flag ${requiredFlag}`)
  }
  return parsed
}

async function verifySourceBundle(licensesDirectory) {
  for (const required of ['LICENSE.md', 'LGPL-2.1.txt', 'KISSFFT-LICENSE.txt', 'SOURCE.md']) {
    const stats = await lstat(join(licensesDirectory, required))
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0) {
      throw new Error(`${join(licensesDirectory, required)} is not a regular non-empty file`)
    }
  }
  const lgplPath = join(licensesDirectory, 'LGPL-2.1.txt')
  if (sha256(await readFile(lgplPath)) !== LGPL_2_1_SHA256) {
    throw new Error(`${lgplPath} is not the pinned full LGPL-2.1 text`)
  }
  const sourcePath = join(licensesDirectory, CHROMAPRINT_SOURCE_NAME)
  const stats = await lstat(sourcePath)
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${sourcePath} is not a regular file`)
  const digest = sha256(await readFile(sourcePath))
  if (digest !== CHROMAPRINT_SOURCE_SHA256) throw new Error(`${sourcePath} SHA-256 mismatch`)
}

async function verifyDirectory(directory, licensesDirectory) {
  const manifest = await readManifest(directory)
  const expectedName = chromaprintLibraryName(TARGET.platform)
  if (manifest.binary?.file !== expectedName) throw new Error(`${CHROMAPRINT_MANIFEST} names the wrong binary`)
  if (manifest.target?.platform !== TARGET.platform || manifest.target?.arch !== TARGET.arch) {
    throw new Error(`${CHROMAPRINT_MANIFEST} target does not match ${TARGET.platform}/${TARGET.arch}`)
  }

  const libraryPath = join(directory, expectedName)
  const stats = await lstat(libraryPath)
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${libraryPath} is not a regular file`)
  if (stats.size < MIN_LIBRARY_BYTES || stats.size > MAX_LIBRARY_BYTES) {
    throw new Error(`${libraryPath} has an unexpected size (${stats.size} bytes)`)
  }
  const binary = await readFile(libraryPath)
  const sourceBinary = PACKAGED_ROOT && TARGET.platform === 'darwin'
    ? await readFile(join(REPO_ROOT, 'native', 'libs', expectedName))
    : undefined
  let integrity
  try {
    integrity = classifyManifestBinary(manifest.binary, binary, {
      platform: TARGET.platform,
      packaged: Boolean(PACKAGED_ROOT),
      sourceBinary,
    })
  } catch {
    throw new Error(`${libraryPath} does not match ${CHROMAPRINT_MANIFEST}`)
  }
  if (integrity === 'macos-resigned') {
    const signature = spawnSync('codesign', ['--verify', '--strict', '--verbose=2', libraryPath], {
      encoding: 'utf8',
    })
    if (signature.error || signature.status !== 0) {
      throw new Error(`${libraryPath} differs after packaging but has no valid macOS code signature`)
    }
  }
  const architectures = parseArchitectures(binary, TARGET.platform)
  assertStringArrayEqual(architectures, expectedArchitectures(TARGET), 'native architecture')
  assertStringArrayEqual(manifest.binary?.architectures ?? [], architectures, 'manifest architecture')
  assertNoExternalAudioDependencies(binary)
  assertExpectedRuntimeDependencies(runtimeDependencies(libraryPath, binary), TARGET.platform)
  await verifySourceBundle(licensesDirectory)

  console.log(`[verify-chromaprint] ${directory}: Chromaprint ${CHROMAPRINT_VERSION} ${TARGET.platform}/${TARGET.arch} provenance and binary passed`)
  if (integrity === 'macos-resigned') {
    console.log(`[verify-chromaprint] ${libraryPath}: accepted verified macOS code-signing mutation`)
  }
  return libraryPath
}

export function makeSmokePcm() {
  const sampleRate = 11_025
  const duration = 20
  const samples = new Int16Array(sampleRate * duration)
  for (let index = 0; index < samples.length; index++) {
    const time = index / sampleRate
    const sweep = 180 + 520 * time / duration
    const value = Math.round(
      11_000 * Math.sin(2 * Math.PI * 440 * time)
      + 7_000 * Math.sin(2 * Math.PI * sweep * time)
      + 3_000 * Math.sin(2 * Math.PI * 37 * time),
    )
    samples[index] = Math.max(-32_768, Math.min(32_767, value))
  }
  return { sampleRate, samples }
}

function smokeLoad(libraryPath) {
  const koffi = require('koffi')
  const library = koffi.load(libraryPath)
  const Context = koffi.opaque('VerifyChromaprintContext')
  const New = library.func('chromaprint_new', koffi.pointer(Context), ['int'])
  const Free = library.func('chromaprint_free', 'void', [koffi.pointer(Context)])
  const Start = library.func('chromaprint_start', 'int', [koffi.pointer(Context), 'int', 'int'])
  const Feed = library.func('chromaprint_feed', 'int', [koffi.pointer(Context), 'const int16_t *', 'int'])
  const Finish = library.func('chromaprint_finish', 'int', [koffi.pointer(Context)])
  const GetSampleRate = library.func('chromaprint_get_sample_rate', 'int', [koffi.pointer(Context)])
  const GetItemDuration = library.func('chromaprint_get_item_duration', 'int', [koffi.pointer(Context)])
  const GetDelay = library.func('chromaprint_get_delay', 'int', [koffi.pointer(Context)])
  const GetRaw = library.func(
    'chromaprint_get_raw_fingerprint',
    'int',
    [koffi.pointer(Context), koffi.out(koffi.pointer('uint32_t', 2)), koffi.out(koffi.pointer('int'))],
  )
  const Dealloc = library.func('chromaprint_dealloc', 'void', ['void *'])
  const GetVersion = library.func('const char *chromaprint_get_version(void)')

  const version = GetVersion()
  if (version !== CHROMAPRINT_VERSION) throw new Error(`Loaded Chromaprint ${version ?? 'unknown'}, expected ${CHROMAPRINT_VERSION}`)
  const context = New(CHROMAPRINT_ALGORITHM)
  if (!context) throw new Error('chromaprint_new failed')
  let rawPointer = null
  try {
    const timing = [GetSampleRate(context), GetItemDuration(context), GetDelay(context)]
    if (timing[0] !== EXPECTED_SAMPLE_RATE || timing[1] !== EXPECTED_ITEM_DURATION_SAMPLES || timing[2] !== EXPECTED_DELAY_SAMPLES) {
      throw new Error(`Frozen algorithm timing mismatch (${timing.join(', ')})`)
    }
    const { sampleRate, samples } = makeSmokePcm()
    if (!Start(context, sampleRate, 1)) throw new Error('chromaprint_start failed')
    for (let offset = 0; offset < samples.length; offset += 4096) {
      const chunk = samples.subarray(offset, Math.min(samples.length, offset + 4096))
      if (!Feed(context, chunk, chunk.length)) throw new Error('chromaprint_feed failed')
    }
    if (!Finish(context)) throw new Error('chromaprint_finish failed')
    const pointerOut = [null]
    const sizeOut = [0]
    if (!GetRaw(context, pointerOut, sizeOut) || !pointerOut[0]) throw new Error('chromaprint_get_raw_fingerprint failed')
    rawPointer = pointerOut[0]
    const values = koffi.decode(rawPointer, 'uint32_t', sizeOut[0])
    const encoded = Buffer.alloc(sizeOut[0] * 4)
    for (let index = 0; index < sizeOut[0]; index++) encoded.writeUInt32LE(values[index] >>> 0, index * 4)
    const digest = sha256(encoded)
    if (sizeOut[0] !== EXPECTED_SMOKE_ITEMS || digest !== EXPECTED_SMOKE_SHA256) {
      throw new Error(`Frozen fingerprint mismatch (${sizeOut[0]} items, ${digest})`)
    }
  } finally {
    if (rawPointer) Dealloc(rawPointer)
    Free(context)
  }
  console.log(`[verify-chromaprint] native load and frozen fingerprint passed (Chromaprint ${version})`)
}

async function findPackagedDirectories(root, depth = 0) {
  if (depth > 8) return []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  if (basename(root) === 'libs' && basename(dirname(root)) === 'native') return [root]
  const result = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    result.push(...await findPackagedDirectories(join(root, entry.name), depth + 1))
  }
  return result
}

async function main() {
  let directories
  if (EXPLICIT_DIR) {
    directories = [resolve(REPO_ROOT, EXPLICIT_DIR)]
  } else if (PACKAGED_ROOT) {
    directories = await findPackagedDirectories(resolve(REPO_ROOT, PACKAGED_ROOT))
    if (directories.length === 0) throw new Error(`No packaged native/libs directory found under ${PACKAGED_ROOT}`)
  } else {
    directories = [join(REPO_ROOT, 'native', 'libs')]
  }

  const verified = []
  for (const directory of directories) {
    const licensesDirectory = EXPLICIT_LICENSES_DIR
      ? resolve(REPO_ROOT, EXPLICIT_LICENSES_DIR)
      : join(directory, CHROMAPRINT_LICENSE_DIR)
    verified.push(await verifyDirectory(directory, licensesDirectory))
  }
  if (LOAD) smokeLoad(verified[0])
}

if (process.argv[1]?.endsWith('verify-chromaprint.mjs')) {
  main().catch((error) => {
    console.error(`[verify-chromaprint] failed:\n${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
