#!/usr/bin/env node
// Build libcrate_audio: download the pinned FFmpeg and miniaudio sources,
// compile an audio-only static LGPL FFmpeg for every target architecture,
// link it with the engine code in native/crate-audio, and install the shared
// library, its provenance manifest and license material into native/libs.
//
//   npm run build:crate-audio [-- --force] [--test] [--platform=darwin --arch=universal]
//
// Requirements: a C compiler, make and CMake 3.16+. On Windows run it from an
// MSYS2 UCRT64 shell (gcc, make, cmake). Downloads are cached in
// native/crate-audio/.cache; objects go to $CRATE_AUDIO_BUILD_DIR or a temp
// directory, because FFmpeg's configure cannot handle paths with spaces.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { MINIAUDIO_PATCHES, applyMiniaudioPatches } from '../native/crate-audio/patches/miniaudio.mjs'
import {
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
  MACOS_DEPLOYMENT_TARGET,
  MINIAUDIO_HEADER_SHA256,
  MINIAUDIO_HEADER_URL,
  MINIAUDIO_VERSION,
  crateAudioLibraryName,
  ffmpegTargetFlags,
  normalizeCrateAudioTarget,
} from './crate-audio-config.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const ENGINE_DIR = join(REPO_ROOT, 'native', 'crate-audio')
const CACHE_DIR = join(ENGINE_DIR, '.cache')
const BUILD_DIR = resolve(process.env.CRATE_AUDIO_BUILD_DIR || join(tmpdir(), 'crate-audio-build'))
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024

function flag(name) {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : undefined
}

const TARGET = normalizeCrateAudioTarget(flag('--platform') ?? process.platform, flag('--arch') ?? process.arch)
const OUT_DIR = resolve(REPO_ROOT, flag('--out-dir') ?? join('native', 'libs'))
const FORCE = process.argv.slice(2).includes('--force')
const RUN_TESTS = process.argv.slice(2).includes('--test')
const JOBS = String(Math.max(2, Math.min(16, cpus().length)))

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

// MSYS2's bash and make expect forward slashes.
function toolPath(path) {
  return process.platform === 'win32' ? path.replaceAll('\\', '/') : path
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: options.env ?? process.env,
  })
  if (result.error) throw new Error(`${command} is unavailable: ${result.error.message}`)
  if (result.status !== 0) {
    const details = options.capture ? `\n${result.stderr || result.stdout}` : ''
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}${details}`)
  }
  return result.stdout?.trim() ?? ''
}

function requireTools() {
  if (/\s/.test(BUILD_DIR)) {
    throw new Error(`FFmpeg cannot be built under a path with spaces (${BUILD_DIR}); set CRATE_AUDIO_BUILD_DIR`)
  }
  const cmake = spawnSync('cmake', ['--version'], { encoding: 'utf8' })
  if (cmake.error?.code === 'ENOENT') {
    throw new Error('CMake 3.16+ is required to build crate-audio. Install it, or run `npm run fetch:crate-audio` for a verified prebuilt artifact.')
  }
  const match = /cmake version (\d+)\.(\d+)/.exec(cmake.stdout ?? '')
  if (!match || Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 16)) {
    throw new Error(`CMake 3.16+ is required (found ${match?.[0] ?? 'unknown version'})`)
  }
  for (const tool of ['make', 'tar']) run(tool, ['--version'], { capture: true })
  if (TARGET.platform === 'darwin') run('xcrun', ['--find', 'lipo'], { capture: true })
}

async function download(url, expectedSha256, fileName) {
  const path = join(CACHE_DIR, fileName)
  if (existsSync(path) && sha256(readFileSync(path)) === expectedSha256) return path
  console.log(`[build-crate-audio] downloading ${url}`)
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
    headers: { 'User-Agent': 'Crate-Audio-Builder' },
  })
  if (!response.ok) throw new Error(`Unable to download ${url}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error(`${url} exceeds ${MAX_DOWNLOAD_BYTES} bytes`)
  const digest = sha256(bytes)
  if (digest !== expectedSha256) throw new Error(`SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${digest}`)
  await mkdir(CACHE_DIR, { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, bytes, { flag: 'wx' })
  await rename(temporary, path)
  return path
}

async function prepareSources() {
  const archive = await download(FFMPEG_SOURCE_URL, FFMPEG_SOURCE_SHA256, FFMPEG_SOURCE_NAME)
  const miniaudioDir = join(BUILD_DIR, `miniaudio-${MINIAUDIO_VERSION}`)
  await mkdir(miniaudioDir, { recursive: true })
  const header = await download(MINIAUDIO_HEADER_URL, MINIAUDIO_HEADER_SHA256, `miniaudio-${MINIAUDIO_VERSION}.h`)
  // Patched copy (see native/crate-audio/patches/miniaudio.mjs).
  await writeFile(join(miniaudioDir, 'miniaudio.h'), applyMiniaudioPatches(await readFile(header, 'utf8')))

  const sourceRoot = join(BUILD_DIR, 'src')
  const ffmpegSource = join(sourceRoot, `ffmpeg-${FFMPEG_VERSION}`)
  const marker = join(ffmpegSource, '.crate-extracted')
  if (!existsSync(marker)) {
    await rm(ffmpegSource, { recursive: true, force: true })
    await mkdir(sourceRoot, { recursive: true })
    // GNU tar reads "D:/..." as host:path unless told the archive is local.
    const local = process.platform === 'win32' ? ['--force-local'] : []
    run('tar', [...local, '-xJf', toolPath(archive), '-C', toolPath(sourceRoot)])
    if (!existsSync(join(ffmpegSource, 'configure'))) throw new Error('Pinned FFmpeg archive has an unexpected layout')
    if (sha256(await readFile(join(ffmpegSource, 'COPYING.LGPLv2.1'))) !== FFMPEG_LGPL_SHA256) {
      throw new Error('FFmpeg COPYING.LGPLv2.1 differs from the pinned text')
    }
    await writeFile(marker, FFMPEG_SOURCE_SHA256)
  }
  return { archive, ffmpegSource, miniaudioDir }
}

function sliceArchitectures() {
  if (TARGET.platform === 'darwin') return ['arm64', 'x64']
  return [TARGET.arch]
}

async function buildFfmpeg(ffmpegSource, arch) {
  const sliceDir = join(BUILD_DIR, `${TARGET.platform}-${arch}`)
  const buildDir = join(sliceDir, 'ffmpeg-build')
  const prefix = join(sliceDir, 'ffmpeg')
  const flags = [...FFMPEG_CONFIGURE_FLAGS, ...ffmpegTargetFlags(TARGET.platform, arch), `--prefix=${toolPath(prefix)}`]
  const stamp = join(sliceDir, 'ffmpeg.stamp')
  const fingerprint = sha256(Buffer.from(JSON.stringify({ version: FFMPEG_VERSION, flags })))
  if (!FORCE && existsSync(stamp) && readFileSync(stamp, 'utf8') === fingerprint &&
      existsSync(join(prefix, 'lib', 'libavcodec.a'))) {
    console.log(`[build-crate-audio] FFmpeg ${arch}: up to date`)
    return prefix
  }
  await rm(sliceDir, { recursive: true, force: true })
  await mkdir(buildDir, { recursive: true })
  console.log(`[build-crate-audio] FFmpeg ${FFMPEG_VERSION} ${TARGET.platform}/${arch}: configure`)
  // Only the flags above may influence the build.
  const env = { ...process.env }
  for (const name of ['CFLAGS', 'CPPFLAGS', 'LDFLAGS', 'PKG_CONFIG_PATH']) delete env[name]
  run('bash', [toolPath(join(ffmpegSource, 'configure')), ...flags], { cwd: buildDir, env, capture: true })
  console.log(`[build-crate-audio] FFmpeg ${arch}: make -j${JOBS}`)
  run('make', [`-j${JOBS}`], { cwd: buildDir, env, capture: true })
  run('make', ['install'], { cwd: buildDir, env, capture: true })
  const license = run('bash', ['-c', `grep -h '^#define FFMPEG_LICENSE' config.h`], { cwd: buildDir, capture: true })
  if (!license.includes('LGPL')) throw new Error(`FFmpeg configured with a non-LGPL license: ${license}`)
  await writeFile(stamp, fingerprint)
  return prefix
}

function cmakeFlags(arch, ffmpegPrefix, miniaudioDir) {
  const flags = [
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCA_FFMPEG_PREFIX=${toolPath(ffmpegPrefix)}`,
    `-DCA_MINIAUDIO_DIR=${toolPath(miniaudioDir)}`,
  ]
  if (TARGET.platform === 'darwin') {
    flags.push(`-DCMAKE_OSX_ARCHITECTURES=${arch === 'arm64' ? 'arm64' : 'x86_64'}`)
    flags.push(`-DCMAKE_OSX_DEPLOYMENT_TARGET=${MACOS_DEPLOYMENT_TARGET}`)
  }
  if (TARGET.platform === 'win32') flags.push('-G', 'MSYS Makefiles')
  return flags
}

function canRunSlice(arch) {
  if (TARGET.platform !== process.platform) return false
  if (TARGET.platform !== 'darwin') return arch === process.arch
  if (arch === process.arch) return true
  // x86_64 slices run on Apple silicon only when Rosetta is installed.
  return spawnSync('arch', ['-x86_64', '/usr/bin/true']).status === 0
}

async function buildEngine(arch, ffmpegPrefix, miniaudioDir) {
  const buildDir = join(BUILD_DIR, `${TARGET.platform}-${arch}`, 'engine')
  console.log(`[build-crate-audio] engine ${TARGET.platform}/${arch}: cmake`)
  run('cmake', ['-S', toolPath(ENGINE_DIR), '-B', toolPath(buildDir), ...cmakeFlags(arch, ffmpegPrefix, miniaudioDir)], { capture: true })
  run('cmake', ['--build', toolPath(buildDir), '--config', 'Release', '--parallel', JOBS], { capture: true })
  if (RUN_TESTS) {
    if (canRunSlice(arch)) {
      console.log(`[build-crate-audio] engine ${arch}: running tests`)
      const runner = join(buildDir, process.platform === 'win32' ? 'crate_audio_tests.exe' : 'crate_audio_tests')
      run(runner, [join(ENGINE_DIR, 'tests', 'fixtures')])
    } else {
      console.log(`[build-crate-audio] engine ${arch}: tests skipped (cannot run this architecture here)`)
    }
  }
  return join(buildDir, crateAudioLibraryName(TARGET.platform))
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

async function main() {
  if (process.platform !== TARGET.platform) {
    throw new Error(`Cross-platform crate-audio builds are not supported: run this on ${TARGET.platform}`)
  }
  const outputName = crateAudioLibraryName(TARGET.platform)
  const outputPath = join(OUT_DIR, outputName)
  const manifestPath = join(OUT_DIR, CRATE_AUDIO_MANIFEST)
  if (!FORCE && !RUN_TESTS && existsSync(outputPath) && existsSync(manifestPath)) {
    const verify = spawnSync(process.execPath, [join(SCRIPT_DIR, 'verify-crate-audio.mjs'), `--dir=${OUT_DIR}`], { encoding: 'utf8' })
    if (verify.status === 0) {
      console.log(`[build-crate-audio] skip ${outputName} (verified build already present; pass --force to rebuild)`)
      return
    }
  }
  requireTools()
  console.log(`[build-crate-audio] target ${TARGET.platform}/${TARGET.arch} -> ${OUT_DIR}`)
  const { archive, ffmpegSource, miniaudioDir } = await prepareSources()

  const slices = []
  for (const arch of sliceArchitectures()) {
    const prefix = await buildFfmpeg(ffmpegSource, arch)
    slices.push(await buildEngine(arch, prefix, miniaudioDir))
  }

  const stagedLibrary = join(BUILD_DIR, `${TARGET.platform}-${TARGET.arch}-${outputName}`)
  if (TARGET.platform === 'darwin') {
    run('lipo', ['-create', ...slices, '-output', stagedLibrary])
    run('strip', ['-x', stagedLibrary])
  } else {
    await copyFile(slices[0], stagedLibrary)
    run('strip', ['--strip-unneeded', toolPath(stagedLibrary)])
  }

  await mkdir(OUT_DIR, { recursive: true })
  await atomicCopy(stagedLibrary, outputPath)
  const binary = await readFile(outputPath)
  const manifest = {
    schemaVersion: 1,
    name: 'crate-audio',
    version: CRATE_AUDIO_VERSION,
    ffmpeg: {
      version: FFMPEG_VERSION,
      archive: FFMPEG_SOURCE_NAME,
      url: FFMPEG_SOURCE_URL,
      sha256: FFMPEG_SOURCE_SHA256,
      license: 'LGPL-2.1-or-later',
      configureFlags: [...FFMPEG_CONFIGURE_FLAGS],
    },
    miniaudio: {
      version: MINIAUDIO_VERSION,
      url: MINIAUDIO_HEADER_URL,
      sha256: MINIAUDIO_HEADER_SHA256,
      patches: MINIAUDIO_PATCHES.map(patch => patch.name),
    },
    target: TARGET,
    build: {
      macosDeploymentTarget: TARGET.platform === 'darwin' ? MACOS_DEPLOYMENT_TARGET : null,
      staticFfmpeg: true,
    },
    binary: {
      file: outputName,
      bytes: binary.length,
      sha256: sha256(binary),
      architectures: TARGET.arch === 'universal' ? ['x64', 'arm64'] : [TARGET.arch],
    },
  }
  const temporaryManifest = `${manifestPath}.${randomUUID()}.tmp`
  await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  if (process.platform === 'win32' && existsSync(manifestPath)) await rm(manifestPath, { force: true })
  await rename(temporaryManifest, manifestPath)

  const licenseDirectory = join(OUT_DIR, CRATE_AUDIO_LICENSE_DIR)
  for (const required of CRATE_AUDIO_LICENSE_FILES) {
    if (!existsSync(join(licenseDirectory, required))) {
      throw new Error(`Missing committed license material: ${join(licenseDirectory, required)}`)
    }
  }
  await atomicCopy(archive, join(licenseDirectory, FFMPEG_SOURCE_NAME))
  console.log(`[build-crate-audio] wrote ${outputName} (${binary.length} bytes, SHA-256 ${manifest.binary.sha256})`)
}

main().catch((error) => {
  console.error(`[build-crate-audio] fatal: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
