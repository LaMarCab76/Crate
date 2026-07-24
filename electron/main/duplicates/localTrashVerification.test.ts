import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
  confirmLocalTrashAbsence,
  LocalTrashConfirmationError,
  type LocalTrashStat,
} from './localTrashVerification.ts'

async function fixture(t: TestContext): Promise<{ root: string; audio: string; trash: string }> {
  const root = await mkdtemp(join(tmpdir(), 'crate-duplicate-trash-'))
  t.after(() => rm(root, { force: true, recursive: true }))
  const trash = join(root, '.trash')
  await mkdir(trash)
  return { root, audio: join(root, 'song.flac'), trash }
}

test('accepts a Trash result only after the original path is absent', async t => {
  const value = await fixture(t)
  await writeFile(value.audio, 'audio')
  await rename(value.audio, join(value.trash, 'song.flac'))

  await assert.doesNotReject(confirmLocalTrashAbsence(value.root, value.audio))
  await assert.rejects(stat(value.audio), { code: 'ENOENT' })
})

test('rejects a false successful Trash result while the original file still exists', async t => {
  const value = await fixture(t)
  await writeFile(value.audio, 'audio')

  await assert.rejects(
    confirmLocalTrashAbsence(value.root, value.audio),
    (error: unknown) => {
      assert.ok(error instanceof LocalTrashConfirmationError)
      assert.equal(error.keepJournalPlanned, false)
      assert.match(error.message, /todavía existe/)
      return true
    },
  )
  await assert.doesNotReject(stat(value.audio))
})

test('marks an indeterminate post-Trash check as recoverable by the journal', async t => {
  const value = await fixture(t)
  await writeFile(value.audio, 'audio')
  const statPath: LocalTrashStat = async path => {
    if (path === value.audio) throw Object.assign(new Error('I/O unavailable'), { code: 'EIO' })
    return stat(path)
  }

  await assert.rejects(
    confirmLocalTrashAbsence(value.root, value.audio, statPath),
    (error: unknown) => {
      assert.ok(error instanceof LocalTrashConfirmationError)
      assert.equal(error.keepJournalPlanned, true)
      assert.match(error.message, /no se pudo confirmar/)
      return true
    },
  )
})
