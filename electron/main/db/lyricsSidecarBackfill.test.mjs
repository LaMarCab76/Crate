import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  materializeLyricsSidecars,
  requireLocalLyricsSidecarSource,
  retryLyricsRecoveryArchives,
  verifyLyricsRecoveryPayload,
} from './lyricsSidecarBackfill.ts'

test('legacy sidecar materialization rejects synthetic OneDrive paths', () => {
  assert.equal(requireLocalLyricsSidecarSource('/Music/song.flac'), '/Music/song.flac')
  assert.throws(
    () => requireLocalLyricsSidecarSource('ONEDRIVE://drive/item'),
    /cannot be materialized/,
  )
})

test('lyrics drop preflight archives every row and retains failed sidecar writes', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'crate-lyrics-recovery-'))
  const goodAudio = join(userData, 'good.flac')
  const unwritableAudio = join(userData, 'missing', 'bad.flac')
  await writeFile(goodAudio, 'audio')

  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE tracks (id INTEGER PRIMARY KEY, path TEXT NOT NULL);
    CREATE TABLE track_lyrics (
      track_id INTEGER PRIMARY KEY,
      synced_lyrics_lrc TEXT,
      plain_lyrics TEXT,
      source TEXT NOT NULL,
      source_id TEXT,
      source_url TEXT,
      confidence REAL NOT NULL,
      instrumental INTEGER NOT NULL,
      is_user_edited INTEGER NOT NULL,
      fetched_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  db.prepare('INSERT INTO tracks VALUES (?, ?)').run(1, goodAudio)
  db.prepare('INSERT INTO tracks VALUES (?, ?)').run(2, unwritableAudio)
  const insert = db.prepare(`
    INSERT INTO track_lyrics VALUES (?, ?, ?, 'user', NULL, NULL, 1, 0, 1, NULL, 1, 2)
  `)
  insert.run(1, '[00:01.00]safe', null)
  insert.run(2, null, 'also safe in recovery')

  const result = materializeLyricsSidecars(db, userData)
  assert.equal(result.archived, 2)
  assert.equal(result.written, 1)
  assert.equal(result.failed, 1)
  assert.ok(result.recoveryPath && existsSync(result.recoveryPath))
  assert.equal(await readFile(join(userData, 'good.lrc'), 'utf8'), '[00:01.00]safe')

  const recovery = JSON.parse(await readFile(result.recoveryPath, 'utf8'))
  verifyLyricsRecoveryPayload(recovery)
  assert.equal(recovery.rowCount, 2)
  assert.equal(recovery.entries[1].plain, 'also safe in recovery')

  await mkdir(join(userData, 'missing'))
  await writeFile(unwritableAudio, 'audio')
  assert.deepEqual(retryLyricsRecoveryArchives(userData), { recovered: 1, failed: 0 })
  assert.equal(await readFile(join(userData, 'missing', 'bad.lrc'), 'utf8'), 'also safe in recovery')

  recovery.entries[1].plain = 'tampered'
  assert.throws(() => verifyLyricsRecoveryPayload(recovery), /checksum mismatch/)
})
