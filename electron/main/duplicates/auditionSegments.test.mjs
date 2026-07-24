import assert from 'node:assert/strict'
import test from 'node:test'
import { comparableSegmentPlayback } from './auditionSegments.ts'

function segment(overrides = {}) {
  return {
    startSec: 10,
    endSec: 20,
    leftStartSec: 10,
    rightStartSec: 12,
    ...overrides,
  }
}

test('comparison uses the complete aligned segment when both streams contain it', () => {
  assert.deepEqual(comparableSegmentPlayback(segment(), 100, 100), {
    leftStartSec: 10,
    rightStartSec: 12,
    durationSec: 10,
  })
})

test('comparison clips playback to the shortest remaining side', () => {
  assert.deepEqual(comparableSegmentPlayback(segment(), 17, 19.5), {
    leftStartSec: 10,
    rightStartSec: 12,
    durationSec: 7,
  })
})

test('comparison shifts both sides together when an aligned start is negative', () => {
  assert.deepEqual(comparableSegmentPlayback(segment({ leftStartSec: -2, rightStartSec: 3 }), 30, 30), {
    leftStartSec: 0,
    rightStartSec: 5,
    durationSec: 8,
  })
})

test('comparison rejects missing, non-finite, and exhausted ranges', () => {
  assert.equal(comparableSegmentPlayback(segment({ leftStartSec: null }), 100, 100), null)
  assert.equal(comparableSegmentPlayback(segment({ endSec: Number.NaN }), 100, 100), null)
  assert.equal(comparableSegmentPlayback(segment(), 10, 100), null)
})
