#!/usr/bin/env node
// Build the pinned Chromaprint source as one shared library. The build uses the
// vendored KissFFT and internal sample converter, so no FFmpeg/FFTW/KissFFT
// runtime libraries are introduced.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  CHROMAPRINT_ALGORITHM,
  CHROMAPRINT_CMAKE_FLAGS,
  CHROMAPRINT_LICENSE_DIR,
  CHROMAPRINT_MANIFEST,
  CHROMAPRINT_SOURCE_NAME,
  CHROMAPRINT_SOURCE_SHA256,
  CHROMAPRINT_SOURCE_URL,
  CHROMAPRINT_VERSION,
  chromaprintLibraryName,
  normalizeChromaprintTarget,
} from './chromaprint-config.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const MAX_SOURCE_BYTES = 8 * 1024 * 1024

function flag(name) {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : undefined
}

const TARGET = normalizeChromaprintTarget(
  flag('--platform') ?? process.platform,
  flag('--arch') ?? process.arch,
)
const OUT_DIR = resolve(REPO_ROOT, flag('--out-dir') ?? join('native', 'libs'))
const SOURCE_ARCHIVE = flag('--source-archive')
const FORCE = process.argv.slice(2).includes('--force')
const BUILD_ENV = { ...process.env }
for (const name of [
  'CFLAGS',
  'CPPFLAGS',
  'CXXFLAGS',
  'KISSFFT_ROOT',
  'LDFLAGS',
]) delete BUILD_ENV[name]

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: BUILD_ENV,
  })
  if (result.error) throw new Error(`${command} is unavailable: ${result.error.message}`)
  if (result.status !== 0) {
    const details = options.capture ? `\n${result.stderr || result.stdout}` : ''
    throw new Error(`${command} exited with status ${result.status}${details}`)
  }
  return result.stdout?.trim() ?? ''
}

function requireBuildTools() {
  const result = spawnSync('cmake', ['--version'], { encoding: 'utf8' })
  if (result.error?.code === 'ENOENT') {
    throw new Error(
      'CMake 3.10+ is required to build Chromaprint from source. Install CMake, '
      + 'or use `npm run fetch:chromaprint` to install a verified prebuilt artifact.',
    )
  }
  if (result.status !== 0) throw new Error(`Unable to run CMake: ${result.stderr || result.error?.message || 'unknown error'}`)
  const match = /cmake version (\d+)\.(\d+)/.exec(result.stdout)
  if (!match || Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 10)) {
    throw new Error(`CMake 3.10+ is required (found ${match?.[0] ?? 'unknown version'})`)
  }
  run('tar', ['--version'], { capture: true })
  if (TARGET.platform === 'darwin') {
    const installNameTool = spawnSync('install_name_tool', [], { encoding: 'utf8' })
    if (installNameTool.error?.code === 'ENOENT') {
      throw new Error('install_name_tool is required for the macOS Chromaprint build')
    }
  }
}

async function downloadSource() {
  if (SOURCE_ARCHIVE) {
    const bytes = await readFile(resolve(REPO_ROOT, SOURCE_ARCHIVE))
    if (bytes.length > MAX_SOURCE_BYTES) throw new Error(`Source archive exceeds ${MAX_SOURCE_BYTES} bytes`)
    return bytes
  }
  const response = await fetch(CHROMAPRINT_SOURCE_URL, {
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
    headers: { 'User-Agent': 'Crate-Chromaprint-Builder' },
  })
  if (!response.ok) throw new Error(`Unable to download ${CHROMAPRINT_SOURCE_URL}: HTTP ${response.status}`)
  const declaredSize = Number(response.headers.get('content-length') ?? 0)
  if (declaredSize > MAX_SOURCE_BYTES) throw new Error(`Source archive exceeds ${MAX_SOURCE_BYTES} bytes`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error(`Source archive exceeds ${MAX_SOURCE_BYTES} bytes`)
  return bytes
}

async function findBuiltLibrary(root) {
  const expected = chromaprintLibraryName(TARGET.platform)
  const candidates = []
  async function walk(directory, depth) {
    if (depth > 5) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path, depth + 1)
      if (!entry.isFile()) continue
      const lower = entry.name.toLowerCase()
      const match = TARGET.platform === 'darwin'
        ? lower.startsWith('libchromaprint') && lower.endsWith('.dylib')
        : TARGET.platform === 'linux'
          ? lower.startsWith('libchromaprint.so')
          : lower === expected
      if (match) candidates.push(path)
    }
  }
  await walk(root, 0)
  if (candidates.length === 0) throw new Error(`CMake did not install ${expected}`)
  const ranked = await Promise.all(candidates.map(async (path) => ({ path, size: (await lstat(path)).size })))
  ranked.sort((left, right) => right.size - left.size || left.path.localeCompare(right.path))
  return ranked[0].path
}

async function atomicCopy(source, destination) {
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    await copyFile(source, temporary)
    if (process.platform === 'win32' && existsSync(destination)) await rm(destination, { force: true })
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true })
  }
}

function platformCmakeFlags() {
  const result = []
  if (TARGET.platform === 'darwin') {
    result.push('-DCMAKE_OSX_ARCHITECTURES=x86_64;arm64', '-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0')
  }
  if (TARGET.platform === 'win32') {
    result.push(
      '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW',
      '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded',
    )
  }
  return result
}

function targetCmakeFlags(installDirectory, sourceDirectory) {
  return [
    ...CHROMAPRINT_CMAKE_FLAGS,
    ...platformCmakeFlags(),
    `-DKISSFFT_SOURCE_DIR=${join(sourceDirectory, 'src', '3rdparty', 'kissfft')}`,
    `-DCMAKE_INSTALL_PREFIX=${installDirectory}`,
  ]
}

function verifyExistingInstall(directory) {
  const result = spawnSync(process.execPath, [
    join(SCRIPT_DIR, 'verify-chromaprint.mjs'),
    `--platform=${TARGET.platform}`,
    `--arch=${TARGET.arch}`,
    `--dir=${directory}`,
  ], { encoding: 'utf8' })
  return result.status === 0
}

async function main() {
  if (process.platform !== TARGET.platform) {
    throw new Error(`Cross-platform Chromaprint builds are not supported: run this on ${TARGET.platform}`)
  }

  const outputName = chromaprintLibraryName(TARGET.platform)
  const outputPath = join(OUT_DIR, outputName)
  const manifestPath = join(OUT_DIR, CHROMAPRINT_MANIFEST)
  if (!FORCE && existsSync(outputPath) && existsSync(manifestPath)) {
    if (verifyExistingInstall(OUT_DIR)) {
      console.log(`[build-chromaprint] skip ${outputName} (verified build already present; pass --force to rebuild)`)
      return
    }
    throw new Error(`Existing ${outputName} package is invalid; pass --force to replace it`)
  }
  requireBuildTools()

  console.log(`[build-chromaprint] target ${TARGET.platform}/${TARGET.arch} -> ${OUT_DIR}`)
  const sourceBytes = await downloadSource()
  const sourceDigest = sha256(sourceBytes)
  if (sourceDigest !== CHROMAPRINT_SOURCE_SHA256) {
    throw new Error(`Chromaprint source SHA-256 mismatch: expected ${CHROMAPRINT_SOURCE_SHA256}, got ${sourceDigest}`)
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'crate-chromaprint-build-'))
  try {
    const archivePath = join(temporaryRoot, CHROMAPRINT_SOURCE_NAME)
    const sourceRoot = join(temporaryRoot, 'source')
    const buildRoot = join(temporaryRoot, 'build')
    const installRoot = join(temporaryRoot, 'install')
    await mkdir(sourceRoot)
    await writeFile(archivePath, sourceBytes, { flag: 'wx' })
    run('tar', ['-xzf', archivePath, '-C', sourceRoot])

    const extractedRoot = join(sourceRoot, `chromaprint-${CHROMAPRINT_VERSION}`)
    if (!existsSync(join(extractedRoot, 'CMakeLists.txt'))) throw new Error('Pinned source archive has an unexpected layout')
    const cmakeFlags = targetCmakeFlags(installRoot, extractedRoot)
    run('cmake', ['-S', extractedRoot, '-B', buildRoot, ...cmakeFlags])
    run('cmake', ['--build', buildRoot, '--config', 'Release', '--parallel', '2'])
    run('cmake', ['--install', buildRoot, '--config', 'Release'])

    const installedLibrary = await findBuiltLibrary(installRoot)
    await mkdir(OUT_DIR, { recursive: true })
    await atomicCopy(installedLibrary, outputPath)
    if (TARGET.platform === 'darwin') {
      run('install_name_tool', ['-id', '@rpath/libchromaprint.dylib', outputPath])
    }

    const binary = await readFile(outputPath)
    const architectures = TARGET.arch === 'universal' ? ['x64', 'arm64'] : [TARGET.arch]
    const manifest = {
      schemaVersion: 1,
      name: 'chromaprint',
      version: CHROMAPRINT_VERSION,
      algorithm: CHROMAPRINT_ALGORITHM,
      source: {
        archive: CHROMAPRINT_SOURCE_NAME,
        url: CHROMAPRINT_SOURCE_URL,
        sha256: CHROMAPRINT_SOURCE_SHA256,
      },
      target: TARGET,
      build: {
        shared: true,
        fft: 'kissfft',
        externalAudioLibraries: false,
        internalAvresample: true,
        cmakeFlags: [
          ...CHROMAPRINT_CMAKE_FLAGS,
          ...platformCmakeFlags(),
          '-DKISSFFT_SOURCE_DIR=<source>/src/3rdparty/kissfft',
          '-DCMAKE_INSTALL_PREFIX=<staging>',
        ],
      },
      binary: {
        file: outputName,
        bytes: binary.length,
        sha256: sha256(binary),
        architectures,
      },
    }
    const temporaryManifest = `${manifestPath}.${randomUUID()}.tmp`
    await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    if (process.platform === 'win32' && existsSync(manifestPath)) await rm(manifestPath, { force: true })
    await rename(temporaryManifest, manifestPath)

    const licenseDirectory = join(OUT_DIR, CHROMAPRINT_LICENSE_DIR)
    for (const required of ['LICENSE.md', 'LGPL-2.1.txt', 'KISSFFT-LICENSE.txt', 'SOURCE.md']) {
      if (!existsSync(join(licenseDirectory, required))) {
        throw new Error(`Missing committed license material: ${join(licenseDirectory, required)}`)
      }
    }
    await atomicCopy(archivePath, join(licenseDirectory, CHROMAPRINT_SOURCE_NAME))
    console.log(`[build-chromaprint] wrote ${outputName} (${binary.length} bytes, SHA-256 ${manifest.binary.sha256})`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`[build-chromaprint] fatal: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
