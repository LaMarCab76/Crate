import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  assertExpectedRuntimeDependencies,
  assertNoExternalAudioDependencies,
  parseArchitectures,
} from './verify-chromaprint.mjs'
import { releaseAssetDownloadRequest } from './fetch-chromaprint.mjs'
import {
  chromaprintArtifactName,
  chromaprintLibraryName,
  normalizeChromaprintTarget,
} from './chromaprint-config.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const VERIFY_SCRIPT = join(SCRIPT_DIR, 'verify-chromaprint.mjs')
const FETCH_SCRIPT = join(SCRIPT_DIR, 'fetch-chromaprint.mjs')
const BUILD_SCRIPT = join(SCRIPT_DIR, 'build-chromaprint.mjs')

function thinMachO(cpu) {
  const binary = Buffer.alloc(4096)
  binary.writeUInt32LE(0xfeedfacf, 0)
  binary.writeUInt32LE(cpu, 4)
  return binary
}

function universalMachO() {
  const binary = Buffer.alloc(4096)
  binary.writeUInt32BE(0xcafebabe, 0)
  binary.writeUInt32BE(2, 4)
  binary.writeUInt32BE(0x01000007, 8)
  binary.writeUInt32BE(0x0100000c, 28)
  return binary
}

function elf(machine) {
  const binary = Buffer.alloc(4096)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(binary)
  binary[4] = 2
  binary[5] = 1
  binary.writeUInt16LE(machine, 18)
  return binary
}

function pe(machine) {
  const binary = Buffer.alloc(4096)
  binary.write('MZ', 0)
  binary.writeUInt32LE(128, 0x3c)
  binary.write('PE\0\0', 128)
  binary.writeUInt16LE(machine, 132)
  return binary
}

test('normalizes the supported release targets and file names', () => {
  assert.deepEqual(normalizeChromaprintTarget('darwin', 'arm64'), { platform: 'darwin', arch: 'universal' })
  assert.deepEqual(normalizeChromaprintTarget('darwin', 'x64'), { platform: 'darwin', arch: 'universal' })
  assert.deepEqual(normalizeChromaprintTarget('linux', 'x64'), { platform: 'linux', arch: 'x64' })
  assert.equal(chromaprintLibraryName('win32'), 'chromaprint.dll')
  assert.equal(chromaprintArtifactName('darwin', 'arm64'), 'chromaprint-1.6.0-darwin-universal.zip')
  assert.throws(() => normalizeChromaprintTarget('linux', 'arm64'), /x64 only/)
})

test('reads the architectures from Mach-O, ELF, and PE headers', () => {
  assert.deepEqual(parseArchitectures(thinMachO(0x0100000c), 'darwin'), ['arm64'])
  assert.deepEqual(parseArchitectures(universalMachO(), 'darwin').sort(), ['arm64', 'x64'])
  assert.deepEqual(parseArchitectures(elf(62), 'linux'), ['x64'])
  assert.deepEqual(parseArchitectures(elf(183), 'linux'), ['arm64'])
  assert.deepEqual(parseArchitectures(pe(0x8664), 'win32'), ['x64'])
  assert.throws(() => parseArchitectures(pe(0x014c), 'win32'), /Unsupported PE machine/)
})

test('rejects external FFmpeg, FFTW, and KissFFT shared-library dependencies', () => {
  assert.doesNotThrow(() => assertNoExternalAudioDependencies(Buffer.from('libc.so.6\0libstdc++.so.6\0kiss_fft_alloc')))
  for (const dependency of [
    'libavcodec.so.61',
    'avutil-59.dll',
    'libswresample.dylib',
    'libfftw3f.so.3',
    'kissfft-double.dll',
  ]) {
    assert.throws(() => assertNoExternalAudioDependencies(Buffer.from(dependency)), /forbidden external/)
  }
})

test('allows only the expected platform runtime dependencies', () => {
  assert.doesNotThrow(() => assertExpectedRuntimeDependencies([
    '@rpath/libchromaprint.dylib',
    '/usr/lib/libc++.1.dylib',
    '/usr/lib/libSystem.B.dylib',
  ], 'darwin'))
  assert.doesNotThrow(() => assertExpectedRuntimeDependencies([
    'libstdc++.so.6', 'libm.so.6', 'libgcc_s.so.1', 'libc.so.6',
  ], 'linux'))
  assert.doesNotThrow(() => assertExpectedRuntimeDependencies(['KERNEL32.dll'], 'win32'))
  assert.throws(
    () => assertExpectedRuntimeDependencies(['libsurprise.so'], 'linux'),
    /unexpected runtime dependencies/,
  )
  assert.throws(
    () => assertExpectedRuntimeDependencies(['VCRUNTIME140.dll'], 'win32'),
    /unexpected runtime dependencies/,
  )
})

test('verification fails clearly when the native package is absent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crate-chromaprint-empty-'))
  try {
    const result = spawnSync(process.execPath, [VERIFY_SCRIPT, '--platform=linux', '--arch=x64', `--dir=${directory}`], {
      encoding: 'utf8',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /chromaprint-manifest\.json/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('local fetch refuses an artifact without an explicit SHA-256', () => {
  const result = spawnSync(process.execPath, [FETCH_SCRIPT, '--platform=linux', '--arch=x64', '--archive=missing.zip'], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--archive requires a 64-character --sha256/)
})

test('authenticated release downloads use the GitHub asset API', () => {
  const asset = {
    url: 'https://api.github.com/repos/owner/repo/releases/assets/123',
    browser_download_url: 'https://github.com/owner/repo/releases/download/tag/native.zip',
  }
  assert.deepEqual(releaseAssetDownloadRequest(asset, 'workflow-token'), {
    url: asset.url,
    headers: {
      Accept: 'application/octet-stream',
      Authorization: 'Bearer workflow-token',
    },
  })
  assert.deepEqual(releaseAssetDownloadRequest(asset), {
    url: asset.browser_download_url,
    headers: {},
  })
})

const cmakeAvailable = spawnSync('cmake', ['--version'], { encoding: 'utf8' }).status === 0
test('source build explains the missing CMake prerequisite', { skip: cmakeAvailable }, () => {
  const result = spawnSync(process.execPath, [BUILD_SCRIPT], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /CMake 3\.10\+ is required/)
  assert.match(result.stderr, /npm run fetch:chromaprint/)
})
