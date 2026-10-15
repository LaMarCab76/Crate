#!/usr/bin/env node
// Verify libcrate_audio: provenance manifest, binary integrity, architectures,
// exported symbols, runtime dependencies, license material and (with --load)
// that it loads, reports an LGPL FFmpeg and decodes a fixture.

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArchitectures, readRuntimeDependencies } from './native-binary.mjs'
import {
  CRATE_AUDIO_API_VERSION,
  CRATE_AUDIO_LICENSE_DIR,
  CRATE_AUDIO_LICENSE_FILES,
  CRATE_AUDIO_MANIFEST,
  CRATE_AUDIO_VERSION,
  FFMPEG_CONFIGURE_FLAGS,
  FFMPEG_LGPL_SHA256,
  FFMPEG_SOURCE_NAME,
  FFMPEG_SOURCE_SHA256,
  FFMPEG_SOURCE_URL,
  FFMPEG_VERSION,
  MINIAUDIO_HEADER_SHA256,
  MINIAUDIO_LICENSE_SHA256,
  MINIAUDIO_VERSION,
  crateAudioLibraryName,
  normalizeCrateAudioTarget,
} from './crate-audio-config.mjs'

const require = createRequire(import.meta.url)
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const MIN_LIBRARY_BYTES = 256 * 1024
const MAX_LIBRARY_BYTES = 32 * 1024 * 1024
const SMOKE_FIXTURE = join(REPO_ROOT, 'native', 'crate-audio', 'tests', 'fixtures', 'flac-44100-16-stereo.flac')

function flag(name) {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : undefined
}

const TARGET = normalizeCrateAudioTarget(flag('--platform') ?? process.platform, flag('--arch') ?? process.arch)
const EXPLICIT_DIR = flag('--dir')
const PACKAGED_ROOT = flag('--packaged-root')
const LOAD = process.argv.slice(2).includes('--load')

if (LOAD && TARGET.platform !== process.platform) {
  throw new Error(`Cannot load ${TARGET.platform} libraries on ${process.platform}`)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function assertSameSet(actual, expected, label) {
  const left = [...new Set(actual)].sort()
  const right = [...new Set(expected)].sort()
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} mismatch: expected ${right.join('+')}, got ${left.join('+') || 'none'}`)
  }
}

export function assertCrateAudioRuntimeDependencies(dependencies, platform) {
  const linux = new Set(['libc.so.6', 'libm.so.6', 'libdl.so.2', 'libpthread.so.0', 'librt.so.1', 'libgcc_s.so.1', 'ld-linux-x86-64.so.2'])
  const windows = new Set(['KERNEL32.DLL', 'USER32.DLL', 'ADVAPI32.DLL', 'OLE32.DLL', 'OLEAUT32.DLL', 'BCRYPT.DLL', 'MSVCRT.DLL', 'UCRTBASE.DLL'])
  const unexpected = dependencies.filter((dependency) => {
    const name = dependency.trim()
    if (!name) return false
    if (platform === 'darwin') {
      return !(name.startsWith('/usr/lib/') || name.startsWith('/System/Library/') || name === '@rpath/libcrate_audio.dylib')
    }
    if (platform === 'linux') return !linux.has(name)
    const upper = name.toUpperCase()
    return !(windows.has(upper) || /^API-MS-WIN-CRT-[A-Z0-9-]+\.DLL$/.test(upper))
  })
  if (unexpected.length > 0) throw new Error(`crate-audio has unexpected runtime dependencies: ${unexpected.join(', ')}`)
}

export function assertOnlyEngineExports(symbols) {
  const foreign = symbols.filter(symbol => !/^ca_[a-z0-9_]+$/.test(symbol) || symbol.startsWith('ca__'))
  if (foreign.length > 0) {
    throw new Error(`crate-audio exports non-engine symbols (FFmpeg/miniaudio must stay private): ${foreign.slice(0, 8).join(', ')}`)
  }
  if (!symbols.includes('ca_get_build_info')) throw new Error('crate-audio does not export ca_get_build_info')
}

function peSections(binary, peOffset) {
  const coffOffset = peOffset + 4
  const sectionCount = binary.readUInt16LE(coffOffset + 2)
  const optionalSize = binary.readUInt16LE(coffOffset + 16)
  const sectionTable = coffOffset + 20 + optionalSize
  const sections = []
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTable + index * 40
    sections.push({
      virtualSize: binary.readUInt32LE(offset + 8),
      virtualAddress: binary.readUInt32LE(offset + 12),
      rawOffset: binary.readUInt32LE(offset + 20),
    })
  }
  return sections
}

function peRva(binary, sections, rva) {
  const section = sections.find(s => rva >= s.virtualAddress && rva < s.virtualAddress + s.virtualSize)
  if (!section) throw new Error(`PE export RVA 0x${rva.toString(16)} is outside every section`)
  return section.rawOffset + (rva - section.virtualAddress)
}

export function parsePeExports(binary) {
  const peOffset = binary.readUInt32LE(0x3c)
  const optionalOffset = peOffset + 24
  const magic = binary.readUInt16LE(optionalOffset)
  const directories = optionalOffset + (magic === 0x20b ? 112 : 96)
  const exportRva = binary.readUInt32LE(directories)
  if (exportRva === 0) return []
  const sections = peSections(binary, peOffset)
  const directory = peRva(binary, sections, exportRva)
  const count = binary.readUInt32LE(directory + 24)
  const namesRva = binary.readUInt32LE(directory + 32)
  if (count > 4096) throw new Error('PE export table exceeds the safety limit')
  const names = []
  for (let index = 0; index < count; index += 1) {
    const nameOffset = peRva(binary, sections, binary.readUInt32LE(peRva(binary, sections, namesRva) + index * 4))
    names.push(binary.toString('ascii', nameOffset, binary.indexOf(0, nameOffset)))
  }
  return names
}

function exportedSymbols(libraryPath, binary) {
  if (TARGET.platform === 'win32') return parsePeExports(binary)
  const args = TARGET.platform === 'darwin' ? ['-gU', libraryPath] : ['-D', '--defined-only', libraryPath]
  const result = spawnSync('nm', args, { encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to list crate-audio exports with nm: ${result.stderr || result.error?.message || 'unknown error'}`)
  }
  return [...new Set(result.stdout
    .split(/\r?\n/)
    .map(line => line.trim().split(/\s+/))
    .filter(parts => parts.length >= 3 && /^[TtDdBbRrSsVWi]$/.test(parts[1]))
    .map(parts => parts[2].replace(/^_/, '').replace(/@.*$/, ''))
    .filter(name => name && !name.startsWith('.'))
    .filter(name => TARGET.platform !== 'linux' || !['_init', '_fini', '_edata', '_end', '__bss_start'].includes(name)))]
}

async function readManifest(directory) {
  const path = join(directory, CRATE_AUDIO_MANIFEST)
  let manifest
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (manifest.schemaVersion !== 1 || manifest.name !== 'crate-audio') throw new Error(`${path} has an unsupported schema`)
  if (manifest.version !== CRATE_AUDIO_VERSION) throw new Error(`${path} must describe crate-audio ${CRATE_AUDIO_VERSION}`)
  if (manifest.ffmpeg?.version !== FFMPEG_VERSION || manifest.ffmpeg?.url !== FFMPEG_SOURCE_URL || manifest.ffmpeg?.sha256 !== FFMPEG_SOURCE_SHA256) {
    throw new Error(`${path} does not reference the pinned FFmpeg source`)
  }
  if (manifest.ffmpeg?.license !== 'LGPL-2.1-or-later') throw new Error(`${path} must describe an LGPL FFmpeg build`)
  assertSameSet(manifest.ffmpeg?.configureFlags ?? [], FFMPEG_CONFIGURE_FLAGS, `${path} FFmpeg configure flags`)
  for (const forbidden of ['--enable-gpl', '--enable-nonfree', '--enable-version3']) {
    if (manifest.ffmpeg.configureFlags.includes(forbidden)) throw new Error(`${path} uses ${forbidden}`)
  }
  if (manifest.miniaudio?.version !== MINIAUDIO_VERSION || manifest.miniaudio?.sha256 !== MINIAUDIO_HEADER_SHA256) {
    throw new Error(`${path} does not reference the pinned miniaudio header`)
  }
  return manifest
}

async function verifyLicenses(directory) {
  const licenses = join(directory, CRATE_AUDIO_LICENSE_DIR)
  for (const file of [...CRATE_AUDIO_LICENSE_FILES, FFMPEG_SOURCE_NAME]) {
    const stats = await lstat(join(licenses, file))
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0) throw new Error(`${join(licenses, file)} is not a regular non-empty file`)
  }
  if (sha256(await readFile(join(licenses, 'LGPL-2.1.txt'))) !== FFMPEG_LGPL_SHA256) {
    throw new Error(`${join(licenses, 'LGPL-2.1.txt')} is not FFmpeg's LGPL-2.1 text`)
  }
  if (sha256(await readFile(join(licenses, 'MINIAUDIO-LICENSE.txt'))) !== MINIAUDIO_LICENSE_SHA256) {
    throw new Error(`${join(licenses, 'MINIAUDIO-LICENSE.txt')} is not miniaudio's license`)
  }
  if (sha256(await readFile(join(licenses, FFMPEG_SOURCE_NAME))) !== FFMPEG_SOURCE_SHA256) {
    throw new Error(`${join(licenses, FFMPEG_SOURCE_NAME)} SHA-256 mismatch`)
  }
}

async function verifyDirectory(directory) {
  const manifest = await readManifest(directory)
  const name = crateAudioLibraryName(TARGET.platform)
  if (manifest.binary?.file !== name) throw new Error(`${CRATE_AUDIO_MANIFEST} names the wrong binary`)
  if (manifest.target?.platform !== TARGET.platform || manifest.target?.arch !== TARGET.arch) {
    throw new Error(`${CRATE_AUDIO_MANIFEST} target does not match ${TARGET.platform}/${TARGET.arch}`)
  }
  const libraryPath = join(directory, name)
  const stats = await lstat(libraryPath)
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${libraryPath} is not a regular file`)
  if (stats.size < MIN_LIBRARY_BYTES || stats.size > MAX_LIBRARY_BYTES) throw new Error(`${libraryPath} has an unexpected size (${stats.size} bytes)`)

  const binary = await readFile(libraryPath)
  const exact = manifest.binary?.sha256 === sha256(binary) && manifest.binary?.bytes === binary.length
  if (!exact) {
    // electron-builder re-signs macOS binaries; accept that only with a valid signature.
    const signed = PACKAGED_ROOT && TARGET.platform === 'darwin' &&
      spawnSync('codesign', ['--verify', '--strict', libraryPath]).status === 0
    if (!signed) throw new Error(`${libraryPath} does not match ${CRATE_AUDIO_MANIFEST}`)
  }
  const expectedArchitectures = TARGET.arch === 'universal' ? ['arm64', 'x64'] : [TARGET.arch]
  const architectures = parseArchitectures(binary, TARGET.platform)
  assertSameSet(architectures, expectedArchitectures, 'native architecture')
  assertSameSet(manifest.binary?.architectures ?? [], architectures, 'manifest architecture')
  assertOnlyEngineExports(exportedSymbols(libraryPath, binary))
  assertCrateAudioRuntimeDependencies(readRuntimeDependencies(TARGET.platform, libraryPath, binary, 'crate-audio'), TARGET.platform)
  await verifyLicenses(directory)
  console.log(`[verify-crate-audio] ${directory}: crate-audio ${CRATE_AUDIO_VERSION} ${TARGET.platform}/${TARGET.arch} (FFmpeg ${FFMPEG_VERSION}, miniaudio ${MINIAUDIO_VERSION}) passed`)
  return libraryPath
}

function smokeLoad(libraryPath) {
  const koffi = require('koffi')
  const library = koffi.load(libraryPath)
  const BuildInfo = koffi.struct('VerifyCaBuildInfo', {
    api_version: 'int32_t',
    version: koffi.array('char', 32),
    ffmpeg_version: koffi.array('char', 64),
    ffmpeg_license: koffi.array('char', 64),
    miniaudio_version: koffi.array('char', 32),
  })
  const StreamInfo = koffi.struct('VerifyCaStreamInfo', {
    sample_rate: 'int32_t', channels: 'int32_t', source_sample_rate: 'int32_t', source_channels: 'int32_t',
    bits_per_sample: 'int32_t', is_float: 'int32_t', is_lossless: 'int32_t', is_dsd: 'int32_t',
    frames: 'int64_t', duration: 'double', bit_rate: 'int64_t',
    codec: koffi.array('char', 32), container: koffi.array('char', 32),
  })
  const getBuildInfo = library.func('int ca_get_build_info(_Out_ VerifyCaBuildInfo *out)')
  const lastError = library.func('const char *ca_last_error(void)')
  const open = library.func('void *ca_decoder_open_file(const char *path, void *opts)')
  const getInfo = library.func('int ca_decoder_get_info(void *dec, _Out_ VerifyCaStreamInfo *out)')
  const read = library.func('int64_t ca_decoder_read(void *dec, _Out_ float *out, int64_t frames)')
  const close = library.func('void ca_decoder_close(void *dec)')

  const info = {}
  if (getBuildInfo(info) !== 0) throw new Error('ca_get_build_info failed')
  if (info.api_version !== CRATE_AUDIO_API_VERSION) throw new Error(`Loaded crate-audio API ${info.api_version}, expected ${CRATE_AUDIO_API_VERSION}`)
  if (info.version !== CRATE_AUDIO_VERSION) throw new Error(`Loaded crate-audio ${info.version}, expected ${CRATE_AUDIO_VERSION}`)
  if (!info.ffmpeg_license.startsWith('LGPL')) throw new Error(`Loaded FFmpeg reports license "${info.ffmpeg_license}"`)
  if (info.ffmpeg_version !== FFMPEG_VERSION) throw new Error(`Loaded FFmpeg ${info.ffmpeg_version}, expected ${FFMPEG_VERSION}`)

  const decoder = open(SMOKE_FIXTURE, null)
  if (!decoder) throw new Error(`Smoke decode failed to open ${SMOKE_FIXTURE}: ${lastError()}`)
  try {
    const stream = {}
    getInfo(decoder, stream)
    if (stream.codec !== 'flac' || stream.sample_rate !== 44100 || stream.channels !== 2) {
      throw new Error(`Smoke decode reported ${stream.codec} ${stream.sample_rate} Hz ${stream.channels} ch`)
    }
    const buffer = new Float32Array(4096 * 2)
    let frames = 0
    for (;;) {
      const n = Number(read(decoder, buffer, 4096))
      if (n < 0) throw new Error(`Smoke decode failed: ${lastError()}`)
      if (n === 0) break
      frames += n
    }
    if (frames !== 44100) throw new Error(`Smoke decode produced ${frames} frames, expected 44100`)
  } finally {
    close(decoder)
  }
  console.log(`[verify-crate-audio] native load and smoke decode passed (FFmpeg ${info.ffmpeg_version}, ${info.ffmpeg_license}; miniaudio ${info.miniaudio_version})`)
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
    if (entry.isDirectory() && !entry.isSymbolicLink()) result.push(...await findPackagedDirectories(join(root, entry.name), depth + 1))
  }
  return result
}

async function main() {
  let directories
  if (EXPLICIT_DIR) directories = [resolve(REPO_ROOT, EXPLICIT_DIR)]
  else if (PACKAGED_ROOT) {
    directories = await findPackagedDirectories(resolve(REPO_ROOT, PACKAGED_ROOT))
    if (directories.length === 0) throw new Error(`No packaged native/libs directory found under ${PACKAGED_ROOT}`)
  } else directories = [join(REPO_ROOT, 'native', 'libs')]

  const verified = []
  for (const directory of directories) verified.push(await verifyDirectory(directory))
  if (LOAD) smokeLoad(verified[0])
}

if (process.argv[1]?.endsWith('verify-crate-audio.mjs')) {
  main().catch((error) => {
    console.error(`[verify-crate-audio] failed:\n${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
