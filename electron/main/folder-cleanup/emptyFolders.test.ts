import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  classifyFolderEntry,
  confirmFolderRemoval,
  createTrashFolderRemover,
  pruneEmptyFolders,
  removeJunkAndEmptyDirectories,
  type FolderRemover,
} from './emptyFolders.ts'

const PLAYABLE = new Set(['.flac', '.mp3', '.m4a'])

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'crate-empty-folders-'))
}

async function touch(root: string, relativePath: string): Promise<string> {
  const path = join(root, ...relativePath.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, 'x')
  return path
}

function recordingRemover(): { remover: FolderRemover; trashed: string[] } {
  const trashed: string[] = []
  // Same strategy as the PC library, with an in-memory "Trash" for folders
  // that still hold recoverable files.
  const remover = createTrashFolderRemover(async path => {
    trashed.push(path)
    const { rm } = await import('node:fs/promises')
    await rm(path, { recursive: true, force: true })
  })
  return { remover, trashed }
}

test('classifies playable, accessory and junk entries', () => {
  assert.equal(classifyFolderEntry('01 - Song.FLAC', PLAYABLE), 'playable')
  assert.equal(classifyFolderEntry('._01 - Song.flac', PLAYABLE), 'junk')
  assert.equal(classifyFolderEntry('.DS_Store', PLAYABLE), 'junk')
  assert.equal(classifyFolderEntry('Thumbs.db', PLAYABLE), 'junk')
  assert.equal(classifyFolderEntry('.song.flac.crate-copy-123.tmp', PLAYABLE), 'junk')
  assert.equal(classifyFolderEntry('song.flac.crate-replaced-123', PLAYABLE), 'playable')
  assert.equal(classifyFolderEntry('cover.jpg', PLAYABLE), 'image')
  assert.equal(classifyFolderEntry('album.m3u8', PLAYABLE), 'playlist')
  assert.equal(classifyFolderEntry('album.cue', PLAYABLE), 'playlist')
  assert.equal(classifyFolderEntry('01 - Song.lrc', PLAYABLE), 'lyrics')
  assert.equal(classifyFolderEntry('rip.log', PLAYABLE), 'other')
})

test('removes an emptied album folder and its emptied artist folder, never the root', async () => {
  const root = await tempRoot()
  const album = join(root, 'Artist', 'Album')
  await mkdir(album, { recursive: true })
  await touch(root, 'Artist/Album/.DS_Store')
  await touch(root, 'Artist/Album/._01 - Song.flac')
  await touch(root, 'Artist/Album/rip.log')
  const { remover, trashed } = recordingRemover()

  const result = await pruneEmptyFolders({ root, startDirs: [album], playableExtensions: PLAYABLE, removeFolder: remover })

  assert.deepEqual(result.removed, [join(root, 'Artist')])
  assert.deepEqual(result.needsConfirmation, [])
  assert.equal(existsSync(join(root, 'Artist')), false)
  assert.equal(existsSync(root), true)
  // rip.log is not junk: that folder went to the Trash instead of being unlinked.
  assert.deepEqual(trashed, [album])
})

test('keeps folders that still hold a playable file anywhere below them', async () => {
  const root = await tempRoot()
  await mkdir(join(root, 'Artist', 'Album A'), { recursive: true })
  await touch(root, 'Artist/Album B/CD1/01 - Song.mp3')
  const { remover } = recordingRemover()

  const result = await pruneEmptyFolders({
    root,
    startDirs: [join(root, 'Artist', 'Album A')],
    playableExtensions: PLAYABLE,
    removeFolder: remover,
  })

  assert.deepEqual(result.removed, [join(root, 'Artist', 'Album A')])
  assert.equal(existsSync(join(root, 'Artist', 'Album B', 'CD1', '01 - Song.mp3')), true)
  assert.equal(existsSync(join(root, 'Artist')), true)
})

test('asks once, for the top-most folder, when images, playlists or lyrics remain', async () => {
  const root = await tempRoot()
  await touch(root, 'Artist/Album/cover.jpg')
  await touch(root, 'Artist/Album/Scans/back.png')
  await touch(root, 'Artist/artist.jpg')
  await touch(root, 'Other/Album/01 - Song.flac')
  const { remover } = recordingRemover()

  const result = await pruneEmptyFolders({
    root,
    startDirs: [join(root, 'Artist', 'Album')],
    playableExtensions: PLAYABLE,
    removeFolder: remover,
  })

  assert.deepEqual(result.removed, [])
  assert.equal(result.needsConfirmation.length, 1)
  assert.equal(result.needsConfirmation[0].dir, join(root, 'Artist'))
  assert.deepEqual(result.needsConfirmation[0].contents.images.sort(), ['Album/Scans/back.png', 'Album/cover.jpg', 'artist.jpg'])
  assert.equal(existsSync(join(root, 'Artist', 'Album', 'cover.jpg')), true)
})

test('removes junk-only siblings automatically and asks for the parent holding lyrics', async () => {
  const root = await tempRoot()
  await touch(root, 'Artist/Album 1/.DS_Store')
  await touch(root, 'Artist/Album 2/01 - Song.lrc')
  const { remover } = recordingRemover()

  const result = await pruneEmptyFolders({
    root,
    startDirs: [join(root, 'Artist', 'Album 1'), join(root, 'Artist', 'Album 2')],
    playableExtensions: PLAYABLE,
    removeFolder: remover,
  })

  assert.deepEqual(result.removed, [join(root, 'Artist', 'Album 1')])
  assert.deepEqual(result.needsConfirmation.map(item => item.dir), [join(root, 'Artist')])
  assert.deepEqual(result.needsConfirmation[0].contents.lyrics, ['Album 2/01 - Song.lrc'])
})

test('never follows symlinks nor touches hidden app folders', async () => {
  const root = await tempRoot()
  const outside = await tempRoot()
  await touch(outside, 'keep.flac')
  await mkdir(join(root, 'Linked'), { recursive: true })
  await symlink(outside, join(root, 'Linked', 'elsewhere'))
  await mkdir(join(root, '.crate', 'trash', 'run'), { recursive: true })
  const { remover } = recordingRemover()

  const result = await pruneEmptyFolders({
    root,
    startDirs: [join(root, 'Linked'), join(root, '.crate', 'trash', 'run')],
    playableExtensions: PLAYABLE,
    removeFolder: remover,
  })

  assert.deepEqual(result.removed, [])
  assert.equal(existsSync(join(root, 'Linked', 'elsewhere')), true)
  assert.equal(existsSync(join(root, '.crate', 'trash', 'run')), true)
  assert.equal(existsSync(join(outside, 'keep.flac')), true)
})

test('climbs past start folders that are already gone', async () => {
  const root = await tempRoot()
  await mkdir(join(root, 'Artist'), { recursive: true })
  const { remover } = recordingRemover()

  const result = await pruneEmptyFolders({
    root,
    startDirs: [join(root, 'Artist', 'Album')],
    playableExtensions: PLAYABLE,
    removeFolder: remover,
  })

  assert.deepEqual(result.removed, [join(root, 'Artist')])
})

test('a file created after inspection keeps the folder', async () => {
  const root = await tempRoot()
  const album = join(root, 'Album')
  await mkdir(album, { recursive: true })
  const errors: string[] = []

  const result = await pruneEmptyFolders({
    root,
    startDirs: [album],
    playableExtensions: PLAYABLE,
    removeFolder: async (dir, contents) => {
      await touch(dir, 'late.flac')
      await removeJunkAndEmptyDirectories(dir, contents)
    },
    onError: dir => errors.push(dir),
  })

  assert.deepEqual(result.removed, [])
  assert.deepEqual(errors, [album])
  assert.equal(existsSync(join(album, 'late.flac')), true)
})

test('confirming removes the folder with its images and keeps folders that gained music', async () => {
  const root = await tempRoot()
  await touch(root, 'Artist/Album/cover.jpg')
  await touch(root, 'Changed/cover.jpg')
  await touch(root, 'Changed/01 - New.flac')
  const { remover, trashed } = recordingRemover()

  const result = await confirmFolderRemoval({
    root,
    relativePaths: ['Artist/Album', 'Changed', '../escape'],
    playableExtensions: PLAYABLE,
    removeFolder: remover,
  })

  assert.deepEqual(result.removed, [join(root, 'Artist')])
  assert.deepEqual(result.kept.map(item => item.reason), ['playable', 'outside'])
  assert.deepEqual(trashed, [join(root, 'Artist', 'Album')])
  assert.equal(existsSync(join(root, 'Changed', '01 - New.flac')), true)
})
