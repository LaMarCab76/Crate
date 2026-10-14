import { lstat, readdir, rmdir, unlink } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { probeKind } from '../devices/dirEntryKind.ts'

// Detects folders left without playable files after tracks are deleted and
// removes them, walking up towards (never including) the library/device root.
//
// A folder is removable when its whole subtree holds no playable file. Images,
// playlists and lyrics require user confirmation; anything else (OS junk, logs,
// text…) is removed automatically. Callers supply the removal strategy, so the
// same rules apply to the PC library (macOS Trash) and the device (.crate/trash).

export type FolderEntryKind = 'playable' | 'image' | 'playlist' | 'lyrics' | 'junk' | 'other'

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.tif', '.tiff', '.heic',
])
const PLAYLIST_EXTENSIONS = new Set(['.m3u', '.m3u8', '.pls', '.cue', '.wpl', '.xspf', '.asx'])
const LYRICS_EXTENSIONS = new Set(['.lrc'])
// Metadata the OS drops into folders (AppleDouble `._*` files on FAT/exFAT,
// Finder/Explorer caches). They never make a folder worth keeping.
const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'ehthumbs.db', 'desktop.ini', '.localized', 'icon\r'])
// Temp files Crate writes next to a destination while copying or moving.
const CRATE_TEMP_PATTERN = /\.crate-(?:copy|album-move)-/
// Backups Crate keeps while replacing or moving audio. They hold real audio
// data, so a folder containing one is never treated as empty.
const CRATE_BACKUP_PATTERN = /\.crate-(?:replaced|moving)-/

export const FOLDER_SCAN_ENTRY_LIMIT = 5000

export function classifyFolderEntry(name: string, playableExtensions: ReadonlySet<string>): FolderEntryKind {
  const lower = name.toLowerCase()
  if (lower.startsWith('._') || JUNK_NAMES.has(lower) || CRATE_TEMP_PATTERN.test(lower)) return 'junk'
  if (CRATE_BACKUP_PATTERN.test(lower)) return 'playable'
  const extension = extname(lower)
  if (playableExtensions.has(extension)) return 'playable'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (PLAYLIST_EXTENSIONS.has(extension)) return 'playlist'
  if (LYRICS_EXTENSIONS.has(extension)) return 'lyrics'
  return 'other'
}

export type FolderBlockReason = 'playable' | 'symlink' | 'unreadable' | 'special' | 'too-large'

export interface FolderContents {
  /** Why the folder must be kept; null when it holds no playable file. */
  blocked: FolderBlockReason | null
  /** POSIX paths relative to the inspected folder. */
  images: string[]
  playlists: string[]
  lyrics: string[]
  other: string[]
  junk: string[]
  /** Sub-directories, parents before children. */
  directories: string[]
}

export function folderNeedsConfirmation(contents: FolderContents): boolean {
  return contents.images.length + contents.playlists.length + contents.lyrics.length > 0
}

/** Files worth sending to a trash rather than deleting outright. */
export function folderRecoverableFiles(contents: FolderContents): string[] {
  return [...contents.images, ...contents.playlists, ...contents.lyrics, ...contents.other]
}

/**
 * Inspects a folder's whole subtree. Stops at the first playable file, symlink
 * or unreadable entry: those make the folder non-removable, so there is no
 * point in walking the rest.
 */
export async function inspectFolder(
  dir: string,
  playableExtensions: ReadonlySet<string>,
  entryLimit = FOLDER_SCAN_ENTRY_LIMIT,
): Promise<FolderContents> {
  const contents: FolderContents = {
    blocked: null,
    images: [],
    playlists: [],
    lyrics: [],
    other: [],
    junk: [],
    directories: [],
  }
  let seen = 0

  const walk = async (current: string, prefix: string): Promise<boolean> => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      contents.blocked = 'unreadable'
      return false
    }
    for (const entry of entries) {
      seen += 1
      if (seen > entryLimit) {
        contents.blocked = 'too-large'
        return false
      }
      const full = join(current, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      let kind = probeKind(entry)
      if (kind === 'unknown') {
        // FAT/exFAT via fskit can report unknown dirent types; stat for real.
        try {
          kind = probeKind(await lstat(full))
        } catch {
          contents.blocked = 'unreadable'
          return false
        }
      }
      if (kind === 'link') {
        contents.blocked = 'symlink'
        return false
      }
      if (kind === 'dir') {
        contents.directories.push(rel)
        if (!(await walk(full, rel))) return false
        continue
      }
      if (kind !== 'file') {
        contents.blocked = 'special'
        return false
      }
      const entryKind = classifyFolderEntry(entry.name, playableExtensions)
      if (entryKind === 'playable') {
        contents.blocked = 'playable'
        return false
      }
      if (entryKind === 'image') contents.images.push(rel)
      else if (entryKind === 'playlist') contents.playlists.push(rel)
      else if (entryKind === 'lyrics') contents.lyrics.push(rel)
      else if (entryKind === 'junk') contents.junk.push(rel)
      else contents.other.push(rel)
    }
    return true
  }

  await walk(dir, '')
  return contents
}

export function fromPosixRelative(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/').filter(Boolean))
}

export function toPosixRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function isStrictlyInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

// Hidden folders (.crate, .rockbox, …) and anything below them are app or
// firmware state, never album folders.
function hasHiddenSegment(root: string, path: string): boolean {
  return relative(root, path).split(sep).some(segment => segment.startsWith('.'))
}

function isCandidateFolder(root: string, path: string): boolean {
  return isStrictlyInside(root, path) && !hasHiddenSegment(root, path)
}

function depth(path: string): number {
  return path.split(sep).filter(Boolean).length
}

/** Drops paths nested inside another path of the list. */
export function topMostPaths(paths: readonly string[]): string[] {
  const sorted = [...new Set(paths.map(path => resolve(path)))].sort((a, b) => depth(a) - depth(b))
  const out: string[] = []
  for (const path of sorted) {
    if (out.some(parent => isStrictlyInside(parent, path))) continue
    out.push(path)
  }
  return out
}

type PathState = 'dir' | 'missing' | 'other'

async function pathState(path: string): Promise<PathState> {
  try {
    const info = await lstat(path)
    return info.isDirectory() ? 'dir' : 'other'
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'other'
  }
}

export type FolderRemover = (dir: string, contents: FolderContents) => Promise<void>

export interface PendingFolderConfirmation {
  dir: string
  contents: FolderContents
}

export interface PruneEmptyFoldersResult {
  /** Top-most removed folders (absolute paths). */
  removed: string[]
  /** Top-most folders without playable files that still hold images, playlists or lyrics. */
  needsConfirmation: PendingFolderConfirmation[]
}

export interface PruneEmptyFoldersOptions {
  root: string
  /** Folders that just lost files (usually the parents of deleted tracks). */
  startDirs: readonly string[]
  playableExtensions: ReadonlySet<string>
  removeFolder: FolderRemover
  onError?: (dir: string, error: unknown) => void
}

/**
 * Removes the folders in `startDirs` that no longer hold playable files, and
 * keeps going up while each parent ends up in the same situation. The root
 * itself is never removed. Folders that would be removable but still hold
 * images, playlists or lyrics are returned for confirmation instead — as the
 * top-most such ancestor, so the user answers once per album/artist.
 */
export async function pruneEmptyFolders(options: PruneEmptyFoldersOptions): Promise<PruneEmptyFoldersResult> {
  const root = resolve(options.root)
  const starts = [...new Set(options.startDirs.map(dir => resolve(dir)))]
    .filter(dir => isCandidateFolder(root, dir))
    .sort((a, b) => depth(b) - depth(a))

  const visited = new Set<string>()
  const removed: string[] = []
  const blockedByConfirmation: string[] = []

  for (const start of starts) {
    let dir = start
    while (isCandidateFolder(root, dir) && !visited.has(dir)) {
      visited.add(dir)
      const state = await pathState(dir)
      if (state === 'other') break
      if (state === 'missing') {
        dir = dirname(dir)
        continue
      }
      const contents = await inspectFolder(dir, options.playableExtensions)
      if (contents.blocked) break
      if (folderNeedsConfirmation(contents)) {
        blockedByConfirmation.push(dir)
        break
      }
      try {
        await options.removeFolder(dir, contents)
      } catch (error) {
        options.onError?.(dir, error)
        break
      }
      removed.push(dir)
      dir = dirname(dir)
    }
  }

  const confirmations = new Map<string, FolderContents>()
  for (const blocked of blockedByConfirmation) {
    let target = blocked
    let parent = dirname(blocked)
    while (isCandidateFolder(root, parent)) {
      if (await pathState(parent) !== 'dir') break
      const contents = await inspectFolder(parent, options.playableExtensions)
      if (contents.blocked) break
      target = parent
      parent = dirname(parent)
    }
    if (!confirmations.has(target)) {
      confirmations.set(target, await inspectFolder(target, options.playableExtensions))
    }
  }

  const needsConfirmation = topMostPaths([...confirmations.keys()])
    .map(dir => ({ dir, contents: confirmations.get(dir)! }))
    .filter(item => item.contents.blocked === null)

  return { removed: topMostPaths(removed), needsConfirmation }
}

export interface ConfirmFolderRemovalOptions {
  root: string
  /** POSIX paths relative to the root, as stored in the proposal. */
  relativePaths: readonly string[]
  playableExtensions: ReadonlySet<string>
  removeFolder: FolderRemover
  onError?: (dir: string, error: unknown) => void
}

export interface ConfirmFolderRemovalResult {
  /** Top-most removed folders, including parents that became empty (absolute). */
  removed: string[]
  /** Folders kept because they changed since the proposal (absolute). */
  kept: Array<{ dir: string; reason: FolderBlockReason | 'outside' }>
  /** Parents that, after the removal, also need confirmation. */
  needsConfirmation: PendingFolderConfirmation[]
}

/**
 * Removes folders the user confirmed. Each folder is re-inspected first: if it
 * gained a playable file (or a symlink) since the proposal it is kept. A
 * removal error aborts the confirmation so the caller can offer a retry;
 * folders already removed are simply skipped on the next attempt.
 */
export async function confirmFolderRemoval(options: ConfirmFolderRemovalOptions): Promise<ConfirmFolderRemovalResult> {
  const root = resolve(options.root)
  const removed: string[] = []
  const kept: ConfirmFolderRemovalResult['kept'] = []
  const parents: string[] = []

  for (const relativePath of options.relativePaths) {
    const dir = resolve(fromPosixRelative(root, relativePath))
    if (!isCandidateFolder(root, dir)) {
      kept.push({ dir, reason: 'outside' })
      continue
    }
    const state = await pathState(dir)
    if (state === 'missing') {
      parents.push(dirname(dir))
      continue
    }
    if (state === 'other') {
      kept.push({ dir, reason: 'special' })
      continue
    }
    const contents = await inspectFolder(dir, options.playableExtensions)
    if (contents.blocked) {
      kept.push({ dir, reason: contents.blocked })
      continue
    }
    await options.removeFolder(dir, contents)
    removed.push(dir)
    parents.push(dirname(dir))
  }

  const cascade = await pruneEmptyFolders({
    root,
    startDirs: parents,
    playableExtensions: options.playableExtensions,
    removeFolder: options.removeFolder,
    onError: options.onError,
  })

  return {
    removed: topMostPaths([...removed, ...cascade.removed]),
    kept,
    needsConfirmation: cascade.needsConfirmation,
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/**
 * Deletes the junk files of an inspected folder and then its (now empty)
 * directories bottom-up. `rmdir` is not recursive, so a file that appeared
 * after the inspection makes it fail and the folder is kept.
 */
export async function removeJunkAndEmptyDirectories(dir: string, contents: FolderContents): Promise<void> {
  for (const rel of contents.junk) await unlinkIfPresent(fromPosixRelative(dir, rel))
  for (const rel of [...contents.directories].reverse()) await rmdir(fromPosixRelative(dir, rel))
  await rmdir(dir)
}

/**
 * Removal strategy for PC libraries: folders holding only junk are deleted in
 * place; anything else goes to the OS Trash as a whole so it stays recoverable.
 */
export function createTrashFolderRemover(trashItem: (path: string) => Promise<void>): FolderRemover {
  return async (dir, contents) => {
    if (folderRecoverableFiles(contents).length > 0) {
      await trashItem(dir)
      return
    }
    await removeJunkAndEmptyDirectories(dir, contents)
  }
}
