#!/usr/bin/env node
// Install a verified Crate Chromaprint shared-library artifact. These assets are
// produced from the pinned upstream source by chromaprint-native.yml; upstream
// fpcalc bundles do not contain the shared library used by the Koffi binding.

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
  CHROMAPRINT_LICENSE_DIR,
  CHROMAPRINT_MANIFEST,
  CHROMAPRINT_NATIVE_RELEASE,
  CHROMAPRINT_NATIVE_REPOSITORY,
  CHROMAPRINT_SOURCE_NAME,
  chromaprintArtifactName,
  chromaprintLibraryName,
  normalizeChromaprintTarget,
} from './chromaprint-config.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const OUT_DIR = join(REPO_ROOT, 'native', 'libs')
const MAX_ARTIFACT_BYTES = 48 * 1024 * 1024

function flag(name) {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : undefined
}

const TARGET = normalizeChromaprintTarget(
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
    headers: { 'User-Agent': 'Crate-Chromaprint-Fetcher', ...headers },
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

async function downloadPublishedArtifact(assetName) {
  const headers = { Accept: 'application/vnd.github+json' }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`
  const apiUrl = `https://api.github.com/repos/${CHROMAPRINT_NATIVE_REPOSITORY}/releases/tags/${CHROMAPRINT_NATIVE_RELEASE}`
  let release
  try {
    const bytes = await fetchBytes(apiUrl, headers)
    release = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(
      `Unable to resolve verified Chromaprint assets from ${CHROMAPRINT_NATIVE_RELEASE}: `
      + `${error instanceof Error ? error.message : String(error)}. `
      + 'Run `npm run build:chromaprint` (requires CMake) or publish the native-assets workflow first.',
    )
  }
  const asset = release.assets?.find((candidate) => candidate.name === assetName)
  if (!asset) {
    throw new Error(`Release ${CHROMAPRINT_NATIVE_RELEASE} does not contain ${assetName}`)
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
    if (!LOCAL_SHA256 || !/^[0-9a-f]{64}$/.test(LOCAL_SHA256)) {
      throw new Error('--archive requires a 64-character --sha256 value')
    }
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

function expectedFiles() {
  return [
    chromaprintLibraryName(TARGET.platform),
    CHROMAPRINT_MANIFEST,
    `${CHROMAPRINT_LICENSE_DIR}/LICENSE.md`,
    `${CHROMAPRINT_LICENSE_DIR}/LGPL-2.1.txt`,
    `${CHROMAPRINT_LICENSE_DIR}/KISSFFT-LICENSE.txt`,
    `${CHROMAPRINT_LICENSE_DIR}/SOURCE.md`,
    `${CHROMAPRINT_LICENSE_DIR}/${CHROMAPRINT_SOURCE_NAME}`,
  ].sort()
}

function verify(directory) {
  const result = spawnSync(process.execPath, [
    join(SCRIPT_DIR, 'verify-chromaprint.mjs'),
    `--platform=${TARGET.platform}`,
    `--arch=${TARGET.arch}`,
    `--dir=${directory}`,
  ], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Chromaprint verification failed')
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
  if (!existsSync(join(OUT_DIR, chromaprintLibraryName(TARGET.platform))) || !existsSync(join(OUT_DIR, CHROMAPRINT_MANIFEST))) {
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
  const assetName = chromaprintArtifactName(TARGET.platform, TARGET.arch)
  if (!FORCE && await existingInstallIsValid()) {
    console.log(`[fetch-chromaprint] skip ${assetName} (verified install already present)`)
    return
  }

  console.log(`[fetch-chromaprint] target ${TARGET.platform}/${TARGET.arch} -> ${OUT_DIR}`)
  const artifact = await loadArtifact(assetName)
  if (artifact.bytes.length > MAX_ARTIFACT_BYTES) throw new Error(`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`)
  const actualDigest = sha256(artifact.bytes)
  if (actualDigest !== artifact.expectedDigest) {
    throw new Error(`SHA-256 mismatch for ${artifact.source}: expected ${artifact.expectedDigest}, got ${actualDigest}`)
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'crate-chromaprint-fetch-'))
  try {
    const archivePath = join(temporaryRoot, assetName)
    const staged = join(temporaryRoot, 'staged')
    await writeFile(archivePath, artifact.bytes, { flag: 'wx' })
    await mkdir(staged)
    await extractZip(archivePath, { dir: staged })
    const actualFiles = await listFiles(staged)
    const allowedFiles = expectedFiles()
    if (JSON.stringify(actualFiles) !== JSON.stringify(allowedFiles)) {
      throw new Error(`Artifact layout mismatch; expected ${allowedFiles.join(', ')}, got ${actualFiles.join(', ')}`)
    }
    console.log(verify(staged))

    // Install only after the complete staging tree passes provenance, source,
    // format, architecture, dependency, and checksum validation.
    for (const path of allowedFiles) await atomicCopy(join(staged, path), join(OUT_DIR, path))
    console.log(verify(OUT_DIR))
    console.log(`[fetch-chromaprint] installed ${assetName} (SHA-256 ${actualDigest})`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

if (process.argv[1]?.endsWith('fetch-chromaprint.mjs')) {
  main().catch((error) => {
    console.error(`[fetch-chromaprint] fatal: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
