#!/usr/bin/env node
// Verify that every BASS binary Crate promises to ship exists, has the native
// format expected for the target platform, and (with --load) can be opened and
// queried through koffi without requiring an audio device.

import { createRequire } from 'node:module'
import { lstat, open, readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const MIN_LIBRARY_BYTES = 4 * 1024

function flag(name) {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(`${name}=`))
  return hit ? hit.slice(name.length + 1) : undefined
}

const TARGET_PLATFORM = flag('--platform') ?? process.platform
const EXPLICIT_DIR = flag('--dir')
const PACKAGED_ROOT = flag('--packaged-root')
const LOAD = process.argv.slice(2).includes('--load')

const platformConfig = {
  darwin: { fileName: (base) => `lib${base}.dylib`, magic: isMachO },
  linux: { fileName: (base) => `lib${base}.so`, magic: isElf },
  win32: { fileName: (base) => `${base}.dll`, magic: isPortableExecutable },
}[TARGET_PLATFORM]

if (!platformConfig) throw new Error(`Unsupported platform: ${TARGET_PLATFORM}`)
if (LOAD && TARGET_PLATFORM !== process.platform) {
  throw new Error(`Cannot load ${TARGET_PLATFORM} libraries on ${process.platform}`)
}

const CORE_BASE = 'bass'
const FX_BASE = 'bass_fx'
const PLUGIN_BASES = [
  'bassflac',
  'bassopus',
  'basswebm',
  'basswv',
  'bassape',
  'bassdsd',
  'bassmidi',
  'basshls',
  'bass_mpc',
  'bass_spx',
  'bass_tta',
]
const REQUIRED_BASES = [CORE_BASE, FX_BASE, ...PLUGIN_BASES]

function isMachO(header) {
  const magic = header.subarray(0, 4).toString('hex')
  return new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']).has(magic)
}

function isElf(header) {
  return header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
}

function isPortableExecutable(header) {
  return header.subarray(0, 2).equals(Buffer.from('MZ'))
}

async function findPackagedLibDirectories(root, depth = 0) {
  if (depth > 8) return []
  const result = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return result
  }
  if (basename(root) === 'libs' && basename(dirname(root)) === 'native') return [root]
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    result.push(...await findPackagedLibDirectories(join(root, entry.name), depth + 1))
  }
  return result
}

async function verifyFile(path) {
  const stats = await lstat(path)
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${path} is not a regular file`)
  if (stats.size < MIN_LIBRARY_BYTES) throw new Error(`${path} is unexpectedly small (${stats.size} bytes)`)
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(4)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead !== header.length || !platformConfig.magic(header)) {
      throw new Error(`${path} is not a valid ${TARGET_PLATFORM} shared library`)
    }
  } finally {
    await handle.close()
  }
}

async function verifyDirectory(directory) {
  const missing = []
  for (const base of REQUIRED_BASES) {
    const path = join(directory, platformConfig.fileName(base))
    try {
      await verifyFile(path)
    } catch (error) {
      missing.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (missing.length > 0) throw new Error(missing.join('\n'))
  console.log(`[verify-bass] ${directory}: ${REQUIRED_BASES.length} binaries present and valid`)
}

function formatVersion(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.')
}

function smokeLoad(directory) {
  const koffi = require('koffi')
  const corePath = join(directory, platformConfig.fileName(CORE_BASE))
  const core = koffi.load(corePath)
  const getVersion = core.func('uint32_t BASS_GetVersion(void)')
  const pluginLoad = core.func('uint32_t BASS_PluginLoad(const char *, uint32_t)')
  const pluginFree = core.func('int32_t BASS_PluginFree(uint32_t)')
  const getError = core.func('int32_t BASS_ErrorGetCode(void)')
  const coreVersion = getVersion()
  if (coreVersion === 0) throw new Error('BASS_GetVersion returned zero')

  const fxPath = join(directory, platformConfig.fileName(FX_BASE))
  const fx = koffi.load(fxPath)
  const getFxVersion = fx.func('uint32_t BASS_FX_GetVersion(void)')
  const fxVersion = getFxVersion()
  if (fxVersion === 0) throw new Error('BASS_FX_GetVersion returned zero')

  for (const base of PLUGIN_BASES) {
    const name = platformConfig.fileName(base)
    const handle = pluginLoad(join(directory, name), 0)
    if (handle === 0) throw new Error(`${name} failed to load (BASS error ${getError()})`)
    pluginFree(handle)
  }
  console.log(`[verify-bass] native load passed (BASS ${formatVersion(coreVersion)}, BASS_FX ${formatVersion(fxVersion)}, ${PLUGIN_BASES.length} plugins)`)
}

async function main() {
  let directories
  if (EXPLICIT_DIR) {
    directories = [resolve(REPO_ROOT, EXPLICIT_DIR)]
  } else if (PACKAGED_ROOT) {
    directories = await findPackagedLibDirectories(resolve(REPO_ROOT, PACKAGED_ROOT))
    if (directories.length === 0) throw new Error(`No packaged native/libs directory found under ${PACKAGED_ROOT}`)
  } else {
    directories = [join(REPO_ROOT, 'native', 'libs')]
  }

  for (const directory of directories) await verifyDirectory(directory)
  if (LOAD) smokeLoad(directories[0])
}

main().catch((error) => {
  console.error(`[verify-bass] failed:\n${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
