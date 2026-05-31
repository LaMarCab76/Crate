import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { shouldBackfill } from './backfillCandidate.ts'

test('only status "none" is a backfill candidate', () => {
  assert.equal(shouldBackfill('none'), true)
})

test('tracks that already have or were already attempted are skipped', () => {
  for (const status of [
    'found_plain',
    'found_synced',
    'instrumental',
    'not_found',
    'low_confidence',
    'failed_provider',
  ]) {
    assert.equal(shouldBackfill(status), false, `expected ${status} to be skipped`)
  }
})
