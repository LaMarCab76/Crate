import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isOrphanLrc } from './orphanLrc.ts'

test('not orphaned when a sibling audio shares the basename', () => {
  assert.equal(isOrphanLrc('Song.lrc', new Set(['song'])), false)
})

test('orphaned when no sibling audio shares the basename', () => {
  assert.equal(isOrphanLrc('Song.lrc', new Set(['other'])), true)
})

test('match is case-insensitive (Song.lrc vs song.flac)', () => {
  assert.equal(isOrphanLrc('Song.lrc', new Set(['song'])), false)
  assert.equal(isOrphanLrc('SONG.lrc', new Set(['song'])), false)
})

test('non-.lrc files are never reported as orphans', () => {
  assert.equal(isOrphanLrc('Song.mp3', new Set()), false)
  assert.equal(isOrphanLrc('cover.jpg', new Set()), false)
})

test('orphaned when the directory has no audio at all', () => {
  assert.equal(isOrphanLrc('Song.lrc', new Set()), true)
})

test('basename with dots is handled (only the .lrc extension is stripped)', () => {
  assert.equal(isOrphanLrc('Artist - 1.2.3.lrc', new Set(['artist - 1.2.3'])), false)
  assert.equal(isOrphanLrc('Artist - 1.2.3.lrc', new Set(['artist - 1.2'])), true)
})
