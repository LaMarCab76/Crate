#!/usr/bin/env node
// Install a verified crate-audio (FFmpeg + miniaudio engine) artifact. These
// assets are produced from the pinned sources by crate-audio-native.yml.

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
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import extractZip from 'extract-zip'
import {
  CRATE_AUDIO_LICENSE_DIR,
  CRATE_AUDIO_LICENSE_FILES,
  CRATE_AUDIO_MANIFEST,
  CRATE_AUDIO_NATIVE_RELEASE,
  CRATE_AUDIO_NATIVE_REPOSITORY,
  FFMPEG_SOURCE_NAME,
  crateAudioArtifactName,
  crateAudioLibraryName,
  normalizeCrateAudioTarget,
} from './crate-audio-config.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const OUT_DIR = join(REPO_ROOT, 'native', 'libs')
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

function flag(name) {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : undefined
}

const TARGET = normalizeCrateAudioTarget(
  flag('--platform') ?? process.platform,
  flag('--arch') ?? process.arch,
)
const LOCAL_ARCHIVE = flag('--archive')
const LOCAL_SHA256 = flag('--sha256')?.toLowerCase()
const FORCE = process.argv.slice(2).includes('--force')

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function fetchBytes(url, headers = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
    headers: { 'User-Agent': 'Crate-Audio-Fetcher', ...headers },
  })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  const declaredSize = Number(response.headers.get('content-length') ?? 0)
  if (declaredSize > MAX_ARTIFACT_BYTES) throw new Error(`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error(`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`)
  return bytes
}

export function releaseAssetDownloadRequest(asset, token) {
  if (token) {
    if (!asset?.url) throw new Error('Authenticated GitHub release asset has no API download URL')
    return {
      url: asset.url,
      headers: {
        Accept: 'application/octet-stream',
        Authorization: `Bearer ${token}`,
      },
    }
  }
  if (!asset?.browser_download_url) throw new Error('GitHub release asset has no public download URL')
  return { url: asset.browser_download_url, headers: {} }
}

export function validateLocalArchiveOptions(localArchive, localSha256) {
  if (localArchive && (!localSha256 || !/^[0-9a-f]{64}$/.test(localSha256))) {
    throw new Error('--archive requires a 64-character --sha256 value')
  }
}

async function downloadPublishedArtifact(assetName) {
  const headers = { Accept: 'application/vnd.github+json' }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`
  const apiUrl = `https://api.github.com/repos/${CRATE_AUDIO_NATIVE_REPOSITORY}/releases/tags/${CRATE_AUDIO_NATIVE_RELEASE}`
  let release
  try {
    const bytes = await fetchBytes(apiUrl, headers)
    release = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(
      `Unable to resolve verified crate-audio assets from ${CRATE_AUDIO_NATIVE_RELEASE}: `
      + `${error instanceof Error ? error.message : String(error)}. `
      + 'Run `npm run build:crate-audio` (requires CMake and a C toolchain) or publish the native-assets workflow first.',
    )
  }
  const asset = release.assets?.find((candidate) => candidate.name === assetName)
  if (!asset) {
    throw new Error(`Release ${CRATE_AUDIO_NATIVE_RELEASE} does not contain ${assetName}`)
  }
  if (typeof asset.digest !== 'string' || !asset.digest.startsWith('sha256:')) {
    throw new Error(`${assetName} has no GitHub SHA-256 digest; refusing an unverifiable artifact`)
  }
  const expectedDigest = asset.digest.slice('sha256:'.length).toLowerCase()
  const request = releaseAssetDownloadRequest(asset, token)
  const bytes = await fetchBytes(request.url, request.headers)
  return { bytes, expectedDigest, source: request.url }
}

async function loadArtifact(assetName) {
  if (LOCAL_ARCHIVE) {
    return {
      bytes: await readFile(resolve(REPO_ROOT, LOCAL_ARCHIVE)),
      expectedDigest: LOCAL_SHA256,
      source: resolve(REPO_ROOT, LOCAL_ARCHIVE),
    }
  }
  return downloadPublishedArtifact(assetName)
}

async function listFiles(root, directory = root) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const stats = await lstat(path)
    if (stats.isSymbolicLink()) throw new Error(`Artifact contains a symbolic link: ${relative(root, path)}`)
    if (stats.isDirectory()) result.push(...await listFiles(root, path))
    else if (stats.isFile()) result.push(relative(root, path).split(sep).join('/'))
    else throw new Error(`Artifact contains an unsupported entry: ${relative(root, path)}`)
  }
  return result.sort()
}

export function expectedCrateAudioArtifactFiles(platform = TARGET.platform) {
  return [
    crateAudioLibraryName(platform),
    CRATE_AUDIO_MANIFEST,
    ...CRATE_AUDIO_LICENSE_FILES.map(file => `${CRATE_AUDIO_LICENSE_DIR}/${file}`),
    `${CRATE_AUDIO_LICENSE_DIR}/${FFMPEG_SOURCE_NAME}`,
  ].sort()
}

function verify(directory) {
  const result = spawnSync(process.execPath, [
    join(SCRIPT_DIR, 'verify-crate-audio.mjs'),
    `--platform=${TARGET.platform}`,
    `--arch=${TARGET.arch}`,
    `--dir=${directory}`,
  ], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'crate-audio verification failed')
  return result.stdout.trim()
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

async function existingInstallIsValid() {
  if (!existsSync(join(OUT_DIR, crateAudioLibraryName(TARGET.platform))) || !existsSync(join(OUT_DIR, CRATE_AUDIO_MANIFEST))) {
    return false
  }
  try {
    verify(OUT_DIR)
    return true
  } catch {
    return false
  }
}

async function main() {
  validateLocalArchiveOptions(LOCAL_ARCHIVE, LOCAL_SHA256)
  const assetName = crateAudioArtifactName(TARGET.platform, TARGET.arch)
  if (!FORCE && await existingInstallIsValid()) {
    console.log(`[fetch-crate-audio] skip ${assetName} (verified install already present)`)
    return
  }

  console.log(`[fetch-crate-audio] target ${TARGET.platform}/${TARGET.arch} -> ${OUT_DIR}`)
  const artifact = await loadArtifact(assetName)
  if (artifact.bytes.length > MAX_ARTIFACT_BYTES) throw new Error(`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`)
  const actualDigest = sha256(artifact.bytes)
  if (actualDigest !== artifact.expectedDigest) {
    throw new Error(`SHA-256 mismatch for ${artifact.source}: expected ${artifact.expectedDigest}, got ${actualDigest}`)
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'crate-audio-fetch-'))
  try {
    const archivePath = join(temporaryRoot, assetName)
    const staged = join(temporaryRoot, 'staged')
    await writeFile(archivePath, artifact.bytes, { flag: 'wx' })
    await mkdir(staged)
    await extractZip(archivePath, { dir: staged })
    const actualFiles = await listFiles(staged)
    const allowedFiles = expectedCrateAudioArtifactFiles()
    if (JSON.stringify(actualFiles) !== JSON.stringify(allowedFiles)) {
      throw new Error(`Artifact layout mismatch; expected ${allowedFiles.join(', ')}, got ${actualFiles.join(', ')}`)
    }
    console.log(verify(staged))

    // Install only after the complete staging tree passes provenance, source,
    // format, architecture, dependency, and checksum validation.
    for (const path of allowedFiles) await atomicCopy(join(staged, path), join(OUT_DIR, path))
    console.log(verify(OUT_DIR))
    console.log(`[fetch-crate-audio] installed ${assetName} (SHA-256 ${actualDigest})`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

if (process.argv[1]?.endsWith('fetch-crate-audio.mjs')) {
  main().catch((error) => {
    console.error(`[fetch-crate-audio] fatal: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
