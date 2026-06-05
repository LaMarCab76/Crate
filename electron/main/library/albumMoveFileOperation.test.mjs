import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  albumMoveSidecarPathFor,
  applyAlbumMoveFileOperation,
} from './trackAlbumMoveFileOperation.ts'

async function tempRoot() {
  return await mkdtemp(join(tmpdir(), 'crate-album-move-'))
}

test('file operation moves audio and .lrc without overwriting existing files', async () => {
  const root = await tempRoot()
  const source = join(root, 'imports', 'borrowed.flac')
  const destination = join(root, 'album', '02 - Borrowed.flac')
  await mkdir(join(root, 'imports'), { recursive: true })
  await writeFile(source, 'audio-bytes', { flag: 'wx' })
  await writeFile(albumMoveSidecarPathFor(source), '[00:01.00]line')

  await applyAlbumMoveFileOperation({
    sourcePath: source,
    destinationPath: destination,
    id: (() => {
      let n = 0
      return () => `id-${++n}`
    })(),
    writeTempMetadata: async tempPath => {
      const content = await readFile(tempPath, 'utf8')
      await writeFile(tempPath, `${content}+tags`)
    },
  })

  assert.equal(existsSync(source), false)
  assert.equal(existsSync(albumMoveSidecarPathFor(source)), false)
  assert.equal(await readFile(destination, 'utf8'), 'audio-bytes+tags')
  assert.equal(await readFile(albumMoveSidecarPathFor(destination), 'utf8'), '[00:01.00]line')
})

test('file operation rolls back source audio and .lrc when the post-move callback fails', async () => {
  const root = await tempRoot()
  const sourceDir = join(root, 'imports')
  const source = join(sourceDir, 'borrowed.flac')
  const destination = join(root, 'album', '02 - Borrowed.flac')
  await mkdir(sourceDir, { recursive: true })
  await writeFile(source, 'audio-bytes')
  await writeFile(albumMoveSidecarPathFor(source), 'lyrics')

  await assert.rejects(
    applyAlbumMoveFileOperation({
      sourcePath: source,
      destinationPath: destination,
      id: (() => {
        let n = 0
        return () => `rollback-${++n}`
      })(),
      writeTempMetadata: () => undefined,
      afterFilesMoved: () => {
        throw new Error('db failed')
      },
    }),
    /db failed/,
  )

  assert.equal(await readFile(source, 'utf8'), 'audio-bytes')
  assert.equal(await readFile(albumMoveSidecarPathFor(source), 'utf8'), 'lyrics')
  assert.equal(existsSync(destination), false)
  assert.equal(existsSync(albumMoveSidecarPathFor(destination)), false)
})

test('file operation blocks existing destination audio before touching the source', async () => {
  const root = await tempRoot()
  const sourceDir = join(root, 'imports')
  const destinationDir = join(root, 'album')
  const source = join(sourceDir, 'borrowed.flac')
  const destination = join(destinationDir, '02 - Borrowed.flac')
  await mkdir(sourceDir, { recursive: true })
  await mkdir(destinationDir, { recursive: true })
  await writeFile(source, 'source')
  await writeFile(destination, 'existing')

  await assert.rejects(
    applyAlbumMoveFileOperation({
      sourcePath: source,
      destinationPath: destination,
      writeTempMetadata: () => undefined,
    }),
    /EEXIST/,
  )

  assert.equal(await readFile(source, 'utf8'), 'source')
  assert.equal(await readFile(destination, 'utf8'), 'existing')
})
