#!/usr/bin/env node
// Download BASS core, BASS_FX, and the decoder plugins shipped by Crate from
// un4seen.com, then extract the current platform binaries into native/libs.
// Binaries are intentionally not committed; CI runs this before packaging.

import { existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(SCRIPT_DIR, '..', 'native', 'libs')
const BASE_URL = 'https://www.un4seen.com/files/'
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
const MAX_LIBRARY_BYTES = 64 * 1024 * 1024

function flag(name) {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : undefined
}

const FORCE = process.argv.slice(2).includes('--force')
const PLATFORM = flag('--platform') ?? process.platform
const ARCH = flag('--arch') ?? process.arch

const platformConfig = {
  darwin: { zipSuffix: '-osx', outputName: (base) => `lib${base}.dylib`, select: selectDarwin },
  linux: { zipSuffix: '-linux', outputName: (base) => `lib${base}.so`, select: selectLinux },
  win32: { zipSuffix: '', outputName: (base) => `${base}.dll`, select: selectWindows },
}[PLATFORM]

if (!platformConfig) {
  throw new Error(`Unsupported platform: ${PLATFORM}`)
}
if (!['x64', 'arm64'].includes(ARCH)) {
  throw new Error(`Unsupported architecture: ${ARCH}`)
}

// Keep this list aligned with scripts/verify-bass.mjs and PluginLoader.ts.
const PRODUCTS = [
  { base: 'bass', slug: 'bass24', prefixes: [''] },
  { base: 'bass_fx', slug: 'bass_fx24', prefixes: ['z/0/', ''] },
  { base: 'bassflac', slug: 'bassflac24', prefixes: [''] },
  { base: 'bassopus', slug: 'bassopus24', prefixes: [''] },
  { base: 'basswebm', slug: 'basswebm24', prefixes: [''] },
  { base: 'basswv', slug: 'basswv24', prefixes: [''] },
  { base: 'bassape', slug: 'bassape24', prefixes: [''] },
  { base: 'bassdsd', slug: 'bassdsd24', prefixes: [''] },
  { base: 'bassmidi', slug: 'bassmidi24', prefixes: [''] },
  { base: 'basshls', slug: 'basshls24', prefixes: [''] },
  { base: 'bass_mpc', slug: 'bass_mpc24', prefixes: ['z/2/'] },
  { base: 'bass_spx', slug: 'bass_spx24', prefixes: ['z/2/'] },
  { base: 'bass_tta', slug: 'bass_tta24', prefixes: ['z/2/'] },
]

function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50
  for (let offset = buffer.length - 22; offset >= 0 && offset >= buffer.length - 22 - 0xffff; offset--) {
    if (buffer.readUInt32LE(offset) === signature) return offset
  }
  throw new Error('Archive has no ZIP central directory')
}

function readCentralDirectory(buffer) {
  const eocd = findEndOfCentralDirectory(buffer)
  const totalEntries = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = new Map()

  for (let index = 0; index < totalEntries; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory entry')
    }
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    entries.set(name, { method, compressedSize, uncompressedSize, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function extractEntry(buffer, entry) {
  if (entry.uncompressedSize > MAX_LIBRARY_BYTES) {
    throw new Error(`Library is too large (${entry.uncompressedSize} bytes)`)
  }
  const offset = entry.localOffset
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error('Invalid ZIP local header')
  }
  const nameLength = buffer.readUInt16LE(offset + 26)
  const extraLength = buffer.readUInt16LE(offset + 28)
  const start = offset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (end > buffer.length) throw new Error('Truncated ZIP entry')

  const raw = buffer.subarray(start, end)
  const extracted = entry.method === 0
    ? Buffer.from(raw)
    : entry.method === 8
      ? inflateRawSync(raw, { maxOutputLength: MAX_LIBRARY_BYTES })
      : null
  if (!extracted) throw new Error(`Unsupported ZIP compression method ${entry.method}`)
  if (extracted.length !== entry.uncompressedSize) throw new Error('ZIP entry size mismatch')
  return extracted
}

function pickShortest(entries) {
  return entries.slice().sort((left, right) => left.length - right.length)[0] ?? null
}

function selectDarwin(names, base) {
  const wanted = `lib${base}.dylib`.toLowerCase()
  return pickShortest(names.filter((name) => basename(name).toLowerCase() === wanted))
}

function selectLinux(names, base) {
  const archDirectory = ARCH === 'arm64' ? 'aarch64' : 'x86_64'
  const wanted = `lib${base}.so`.toLowerCase()
  const matches = names.filter((name) => basename(name).toLowerCase() === wanted)
  const architectureMatches = matches.filter((name) => name.toLowerCase().includes(`${archDirectory}/`))
  return pickShortest(architectureMatches.length > 0 ? architectureMatches : matches.filter((name) => !name.includes('/')))
}

function selectWindows(names, base) {
  const archDirectory = ARCH === 'arm64' ? 'arm64' : 'x64'
  const wanted = `${base}.dll`.toLowerCase()
  return pickShortest(names.filter((name) => {
    const normalized = name.toLowerCase()
    return basename(normalized) === wanted && (normalized.startsWith(`${archDirectory}/`) || normalized.includes(`/${archDirectory}/`))
  }))
}

async function download(product) {
  const failures = []
  for (const prefix of product.prefixes) {
    const url = `${BASE_URL}${prefix}${product.slug}${platformConfig.zipSuffix}.zip`
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) })
      if (!response.ok) {
        failures.push(`${url}: HTTP ${response.status}`)
        continue
      }
      const declaredSize = Number(response.headers.get('content-length') ?? 0)
      if (declaredSize > MAX_ARCHIVE_BYTES) throw new Error(`Archive is too large (${declaredSize} bytes)`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error(`Archive is too large (${bytes.length} bytes)`)
      return { url, bytes }
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(failures.join('; '))
}

async function fetchProduct(product) {
  const outputName = platformConfig.outputName(product.base)
  const outputPath = join(OUT_DIR, outputName)
  if (!FORCE && existsSync(outputPath)) {
    console.log(`[fetch-bass] skip ${outputName} (already present)`)
    return
  }

  const { url, bytes } = await download(product)
  const entries = readCentralDirectory(bytes)
  const member = platformConfig.select([...entries.keys()], product.base)
  if (!member) throw new Error(`No ${PLATFORM}/${ARCH} binary found in ${basename(url)}`)

  const library = extractEntry(bytes, entries.get(member))
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, library, { mode: 0o644, flag: 'wx' })
    await rename(temporaryPath, outputPath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
  console.log(`[fetch-bass] wrote ${outputName} (${member}, ${library.length} bytes)`)
}

async function main() {
  console.log(`[fetch-bass] target ${PLATFORM}/${ARCH} -> ${OUT_DIR}${FORCE ? ' (--force)' : ''}`)
  await mkdir(OUT_DIR, { recursive: true })
  const failures = []
  for (const product of PRODUCTS) {
    try {
      await fetchProduct(product)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[fetch-bass] ERROR ${product.base}: ${message}`)
      failures.push(product.base)
    }
  }
  if (failures.length > 0) throw new Error(`Missing required BASS products: ${failures.join(', ')}`)
  console.log('[fetch-bass] done')
}

main().catch((error) => {
  console.error(`[fetch-bass] fatal: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
