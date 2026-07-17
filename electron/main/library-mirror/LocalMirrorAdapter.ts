import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  utimes,
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { DbFolder } from '@shared/types/db'
import { createMirrorHashers, digestMirrorHashers, updateMirrorHashers } from './hashes.ts'
import {
  MirrorPreconditionError,
  MirrorRootUnavailableError,
  MirrorVerificationError,
  type MirrorAdapter,
  type MirrorEntry,
  type MirrorInventory,
} from './types.ts'

const IGNORED_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

export function isExcludedMirrorPath(relativePath: string): boolean {
  const parts = relativePath.split('/')
  const name = parts.at(-1) ?? ''
  const lower = name.toLowerCase()
  if (IGNORED_NAMES.has(lower) || name.startsWith('._')) return true
  if (/\.part\.[^/]+$/i.test(name)) return true
  if (/^\..*\.crate-(?:copy|album-move|mirror)-/i.test(name)) return true
  if (/^\.crate-(?:copy|album-move|mirror)-/i.test(name)) return true
  if (/^\.write-test-.*\.tmp$/i.test(name)) return true
  if (/\.tmp-[0-9a-f-]{8,}$/i.test(name)) return true
  if (/\.previous-[0-9a-f-]{8,}$/i.test(name)) return true
  if (parts[0] === '.crate' && parts[1] === 'migrations') return true
  if (parts.includes('.crate') && /(?:\.tmp|\.part)$/i.test(name) && name !== 'library.yaml') return true
  return false
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe mirror relative path: ${value}`)
  }
  return normalized
}

function localRoot(location: DbFolder): string {
  if (location.provider !== 'local') throw new Error(`Local adapter cannot handle ${location.provider}.`)
  if (!isAbsolute(location.path)) throw new MirrorRootUnavailableError(`Library root is not absolute: ${location.path}`)
  return resolve(location.path)
}

function targetPath(location: DbFolder, relativePath: string): string {
  const root = localRoot(location)
  const normalized = normalizeRelativePath(relativePath)
  const target = resolve(root, ...normalized.split('/'))
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Mirror path escapes its root: ${relativePath}`)
  return target
}

async function assertRootAvailable(location: DbFolder): Promise<string> {
  const root = localRoot(location)
  try {
    const info = await stat(root)
    if (!info.isDirectory()) throw new Error('not a directory')
    await realpath(root)
    return root
  } catch (error) {
    throw new MirrorRootUnavailableError(`Library root is unavailable: ${root}`, { cause: error })
  }
}

async function identifyRoot(location: DbFolder): Promise<{ root: string; identity: string }> {
  const root = await assertRootAvailable(location)
  try {
    const [info, canonicalRoot] = await Promise.all([stat(root), realpath(root)])
    return {
      root,
      identity: `local:${canonicalRoot}:${info.dev}:${info.ino}:${Math.round(info.birthtimeMs)}`,
    }
  } catch (error) {
    throw new MirrorRootUnavailableError(`Library root is unavailable: ${root}`, { cause: error })
  }
}

async function assertNoSymlinkBetween(root: string, target: string, includeTarget: boolean): Promise<void> {
  const rel = relative(root, target)
  const parts = rel.split(sep).filter(Boolean)
  const length = includeTarget ? parts.length : Math.max(0, parts.length - 1)
  let current = root
  for (let index = 0; index < length; index++) {
    current = resolve(current, parts[index])
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new MirrorPreconditionError(`Refusing to follow symlink: ${current}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

async function fingerprintFile(path: string, relativePath: string): Promise<MirrorEntry> {
  const before = await stat(path)
  if (!before.isFile()) throw new MirrorPreconditionError(`Expected a regular file: ${relativePath}`)
  const hashers = createMirrorHashers()
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    updateMirrorHashers(hashers, chunk)
  }
  const after = await stat(path)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new MirrorPreconditionError(`File changed while it was inventoried: ${relativePath}`)
  }
  const hashes = digestMirrorHashers(hashers)
  return {
    relativePath,
    kind: 'file',
    size: after.size,
    modifiedAtMs: after.mtimeMs,
    sha256: hashes.sha256,
    quickXorHash: hashes.quickXorHash,
    etag: null,
  }
}

function sameLocalEntry(left: MirrorEntry | null, right: MirrorEntry | null): boolean {
  if (!left || !right) return left === right
  if (left.kind !== right.kind) return false
  if (left.kind === 'directory') return true
  return left.size === right.size && left.sha256 !== null && left.sha256 === right.sha256
}

function matchesPlannedSource(observed: MirrorEntry | null, expected: MirrorEntry): boolean {
  if (!observed || observed.kind !== 'file' || expected.kind !== 'file' || observed.size !== expected.size) return false
  if (expected.sha256) return observed.sha256 === expected.sha256
  return Boolean(expected.quickXorHash && observed.quickXorHash === expected.quickXorHash)
}

async function inspectLocalEntry(location: DbFolder, relativePath: string): Promise<MirrorEntry | null> {
  const root = localRoot(location)
  const path = targetPath(location, relativePath)
  await assertNoSymlinkBetween(root, path, true)
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new MirrorPreconditionError(`Refusing to follow symlink: ${relativePath}`)
    if (info.isDirectory()) {
      return { relativePath, kind: 'directory', size: 0, modifiedAtMs: info.mtimeMs, sha256: null, quickXorHash: null, etag: null }
    }
    if (info.isFile()) return fingerprintFile(path, relativePath)
    return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export class LocalMirrorAdapter implements MirrorAdapter {
  readonly provider = 'local' as const
  private readonly observedRootIdentities = new Map<number, string>()

  async inventory(location: DbFolder, signal?: AbortSignal): Promise<MirrorInventory> {
    const { root, identity: rootIdentity } = await identifyRoot(location)
    const entries: MirrorEntry[] = []
    const warnings: MirrorInventory['warnings'][number][] = []

    const walk = async (directory: string, prefix: string): Promise<void> => {
      signal?.throwIfAborted()
      let children
      try {
        children = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        throw new MirrorRootUnavailableError(`Cannot enumerate library root: ${directory}`, { cause: error })
      }
      children.sort((a, b) => a.name.localeCompare(b.name))
      for (const child of children) {
        signal?.throwIfAborted()
        const relativePath = prefix ? `${prefix}/${child.name}` : child.name
        if (isExcludedMirrorPath(relativePath)) {
          warnings.push({ code: 'entry_excluded', relativePath, message: 'Crate or operating-system temporary entry excluded.' })
          continue
        }
        const path = resolve(directory, child.name)
        const info = await lstat(path)
        if (info.isSymbolicLink()) {
          warnings.push({ code: 'symlink_skipped', relativePath, message: 'Symbolic links are never followed or mirrored.' })
          continue
        }
        if (info.isDirectory()) {
          entries.push({ relativePath, kind: 'directory', size: 0, modifiedAtMs: info.mtimeMs, sha256: null, quickXorHash: null, etag: null })
          await walk(path, relativePath)
        } else if (info.isFile()) {
          entries.push(await fingerprintFile(path, relativePath))
        } else {
          warnings.push({ code: 'special_entry_skipped', relativePath, message: 'Non-file filesystem entry skipped.' })
        }
      }
    }

    await walk(root, '')
    const completedIdentity = (await identifyRoot(location)).identity
    if (completedIdentity !== rootIdentity) {
      throw new MirrorRootUnavailableError(`Library root changed while it was inventoried: ${root}`)
    }
    this.observedRootIdentities.set(location.id, rootIdentity)
    return { rootIdentity, entries, warnings }
  }

  async *readFile(location: DbFolder, entry: MirrorEntry, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    if (entry.kind !== 'file') throw new Error(`Cannot read directory as a file: ${entry.relativePath}`)
    const root = await this.assertCurrentRoot(location)
    const path = targetPath(location, entry.relativePath)
    await assertNoSymlinkBetween(root, path, true)
    const before = await stat(path)
    if (!before.isFile() || before.size !== entry.size || before.mtimeMs !== entry.modifiedAtMs) {
      throw new MirrorPreconditionError(`Source changed after planning: ${entry.relativePath}`)
    }
    const stream = createReadStream(path, { highWaterMark: 1024 * 1024, signal })
    for await (const chunk of stream) yield chunk
    await this.assertCurrentRoot(location)
    const after = await stat(path)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new MirrorPreconditionError(`Source changed while copying: ${entry.relativePath}`)
    }
  }

  async createDirectory(location: DbFolder, relativePath: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const root = await this.assertCurrentRoot(location)
    const path = targetPath(location, relativePath)
    await assertNoSymlinkBetween(root, path, true)
    await mkdir(path, { recursive: true })
  }

  async writeFile(request: Parameters<MirrorAdapter['writeFile']>[0]): Promise<MirrorEntry> {
    const { location, relativePath, source, expectedSource, destinationBefore, signal, onProgress } = request
    signal?.throwIfAborted()
    const root = await this.assertCurrentRoot(location)
    const destination = targetPath(location, relativePath)
    await assertNoSymlinkBetween(root, destination, true)
    const observed = await inspectLocalEntry(location, relativePath)
    if (!sameLocalEntry(observed, destinationBefore)) {
      // Crash window: bytes may have been atomically published immediately
      // before the completed journal write. Accept only exact planned content.
      if (matchesPlannedSource(observed, expectedSource)) {
        onProgress?.(expectedSource.size)
        return observed!
      }
      throw new MirrorPreconditionError(`Backup destination changed after planning: ${relativePath}`)
    }
    await mkdir(dirname(destination), { recursive: true })
    const temp = resolve(dirname(destination), `.${relativePath.split('/').at(-1)}.crate-mirror-${randomUUID()}.tmp`)
    const handle = await open(temp, 'wx')
    const hashers = createMirrorHashers()
    let bytes = 0
    try {
      for await (const chunk of source) {
        signal?.throwIfAborted()
        let offset = 0
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset)
          if (bytesWritten <= 0) throw new Error(`Could not make progress writing ${relativePath}.`)
          offset += bytesWritten
        }
        updateMirrorHashers(hashers, chunk)
        bytes += chunk.byteLength
        onProgress?.(bytes)
      }
      await handle.sync()
      await handle.close()
      const hashes = digestMirrorHashers(hashers)
      if (
        bytes !== expectedSource.size
        || (expectedSource.sha256 !== null && hashes.sha256 !== expectedSource.sha256)
        || (expectedSource.quickXorHash !== null && hashes.quickXorHash !== expectedSource.quickXorHash)
      ) {
        throw new MirrorVerificationError(`Copied bytes did not match the planned source: ${relativePath}`)
      }
      const latest = await inspectLocalEntry(location, relativePath)
      if (!sameLocalEntry(latest, destinationBefore)) {
        throw new MirrorPreconditionError(`Backup destination changed while copying: ${relativePath}`)
      }
      await this.assertCurrentRoot(location)
      await rename(temp, destination)
      if (expectedSource.modifiedAtMs !== null) {
        const date = new Date(expectedSource.modifiedAtMs)
        await utimes(destination, date, date)
      }
      return await fingerprintFile(destination, relativePath)
    } catch (error) {
      await handle.close().catch(() => undefined)
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async moveEntry(request: NonNullable<MirrorAdapter['moveEntry']> extends (...args: infer A) => unknown ? A[0] : never): Promise<MirrorEntry> {
    const { location, sourceRelativePath, destinationRelativePath, sourceBefore, destinationBefore, signal } = request
    signal?.throwIfAborted()
    const root = await this.assertCurrentRoot(location)
    const source = targetPath(location, sourceRelativePath)
    const destination = targetPath(location, destinationRelativePath)
    await assertNoSymlinkBetween(root, source, true)
    await assertNoSymlinkBetween(root, destination, true)
    const [observedSource, observedDestination] = await Promise.all([
      inspectLocalEntry(location, sourceRelativePath),
      inspectLocalEntry(location, destinationRelativePath),
    ])
    // Crash recovery: the rename may have completed just before the journal
    // write. Accept only a destination that exactly matches staged content.
    if (!observedSource && matchesPlannedSource(observedDestination, sourceBefore)) {
      return observedDestination!
    }
    if (!sameLocalEntry(observedSource, sourceBefore)) {
      throw new MirrorPreconditionError(`Staged file changed before publication: ${sourceRelativePath}`)
    }
    if (!sameLocalEntry(observedDestination, destinationBefore)) {
      throw new MirrorPreconditionError(`Migration destination changed before publication: ${destinationRelativePath}`)
    }
    await mkdir(dirname(destination), { recursive: true })
    await rename(source, destination)
    return fingerprintFile(destination, destinationRelativePath)
  }

  async deleteEntry(request: Parameters<MirrorAdapter['deleteEntry']>[0]): Promise<void> {
    const { location, relativePath, destinationBefore, signal } = request
    signal?.throwIfAborted()
    const root = await this.assertCurrentRoot(location)
    const path = targetPath(location, relativePath)
    await assertNoSymlinkBetween(root, path, true)
    const observed = await inspectLocalEntry(location, relativePath)
    if (observed === null) return
    if (destinationBefore && !sameLocalEntry(observed, destinationBefore)) {
      throw new MirrorPreconditionError(`Backup destination changed after planning: ${relativePath}`)
    }
    if (!destinationBefore) {
      throw new MirrorPreconditionError(`Refusing to delete an unplanned destination entry: ${relativePath}`)
    }
    await this.assertCurrentRoot(location)
    // Never recursively remove a directory after planning: a foreign child
    // created in the meantime must make the action fail safely (ENOTEMPTY).
    if (observed.kind === 'directory') await rmdir(path)
    else await rm(path, { force: false })
  }

  private async assertCurrentRoot(location: DbFolder): Promise<string> {
    const { root, identity } = await identifyRoot(location)
    const expected = this.observedRootIdentities.get(location.id)
    if (expected && expected !== identity) {
      throw new MirrorRootUnavailableError(`Library root identity changed: ${root}`)
    }
    if (!expected) this.observedRootIdentities.set(location.id, identity)
    return root
  }
}
