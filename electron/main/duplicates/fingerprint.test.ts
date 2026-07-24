import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  compareFingerprints,
  compareFingerprintsCooperative,
  decodeFingerprintFrames,
  encodeFingerprintFrames,
  fingerprintDigest,
  hammingDistance32,
  type AudioFingerprint,
} from './fingerprint.ts'

function fingerprint(frames: readonly number[], framesPerSecond = 1): AudioFingerprint {
  return {
    algorithm: 'test-fingerprint',
    algorithmVersion: '1',
    framesPerSecond,
    durationSeconds: frames.length / framesPerSecond,
    frames: Uint32Array.from(frames),
  }
}

const DISTINCT = [
  0x00000000, 0xffffffff, 0xaaaaaaaa, 0x55555555, 0x0f0f0f0f,
  0xf0f0f0f0, 0x33333333, 0xcccccccc, 0xff00ff00, 0x00ff00ff,
]

test('encodes raw uint32 frames deterministically and preserves unsigned values', () => {
  const frames = Uint32Array.from(DISTINCT)
  const first = encodeFingerprintFrames(frames)
  const second = encodeFingerprintFrames(frames)
  assert.deepEqual(first, second)
  assert.deepEqual([...decodeFingerprintFrames(first)], [...frames])
  assert.equal(fingerprintDigest(frames), fingerprintDigest(decodeFingerprintFrames(first)))
})

test('uses a 32-bit Hamming distance with the inclusive two-bit tolerance', () => {
  assert.equal(hammingDistance32(0, 0), 0)
  assert.equal(hammingDistance32(0, 0b11), 2)
  assert.equal(hammingDistance32(0, 0b111), 3)
  const result = compareFingerprints(
    fingerprint([0]),
    fingerprint([0b11]),
    { maxAlignmentSeconds: 0 },
  )
  assert.equal(result.similarity, 1)
})

test('requires similarity to be strictly greater than 60 percent', () => {
  const sixty = compareFingerprints(
    fingerprint(DISTINCT),
    fingerprint([...DISTINCT.slice(0, 6), 1, 2, 4, 8]),
    { maxAlignmentSeconds: 0, maxHammingDistance: 0 },
  )
  assert.equal(sixty.similarity, 0.6)
  assert.equal(sixty.isCandidate, false)

  const seventy = compareFingerprints(
    fingerprint(DISTINCT),
    fingerprint([...DISTINCT.slice(0, 7), 1, 2, 4]),
    { maxAlignmentSeconds: 0, maxHammingDistance: 0 },
  )
  assert.equal(seventy.similarity, 0.7)
  assert.equal(seventy.isCandidate, true)
})

test('finds the best offset and maps unmatched intros onto the shared timeline', () => {
  const left = DISTINCT
  const right = [0x12345678, 0x87654321, 0x13579bdf, ...left]
  const result = compareFingerprints(
    fingerprint(left),
    fingerprint(right),
    {
      maxAlignmentSeconds: 10,
      maxHammingDistance: 0,
      segmentWindowSeconds: 1,
      mergeGapSeconds: 0,
    },
  )
  assert.equal(result.offsetFrames, 3)
  assert.equal(result.matchingFrames, 10)
  assert.equal(result.comparedFrames, 13)
  assert.equal(result.similarity, 10 / 13)
  assert.deepEqual(result.segments.map(segment => segment.kind), ['difference', 'match'])
  assert.equal(result.segments[0].leftStartSec, null)
  assert.equal(result.segments[0].rightStartSec, 0)
  assert.equal(result.segments[1].leftStartSec, 0)
  assert.equal(result.segments[1].rightStartSec, 3)
})

test('rejects incompatible fingerprint versions and rates', () => {
  assert.throws(() => compareFingerprints(
    fingerprint([1]),
    { ...fingerprint([1]), algorithmVersion: '2' },
  ), /incompatible algorithm versions/)
  assert.throws(() => compareFingerprints(
    fingerprint([1], 1),
    fingerprint([1], 2),
  ), /incompatible frame rates/)
  assert.throws(() => compareFingerprints(
    { ...fingerprint([1]), delaySeconds: 2.6 },
    { ...fingerprint([1]), delaySeconds: 0 },
  ), /incompatible algorithm delays/)
})

test('maps raw frames onto the decoded timeline using the algorithm delay', () => {
  const left = { ...fingerprint([1, 2, 3]), delaySeconds: 2.6 }
  const right = { ...fingerprint([1, 2, 3]), delaySeconds: 2.6 }
  const result = compareFingerprints(left, right, { segmentWindowSeconds: 1 })
  assert.equal(result.segments[0].startSec, 2.6)
  assert.equal(result.segments[0].leftStartSec, 2.6)
  assert.equal(result.segments[0].rightStartSec, 2.6)
})

test('merges a transition shorter than two seconds between equal regions', () => {
  const result = compareFingerprints(
    fingerprint([0, 0, 0, 0, 0], 2),
    fingerprint([0, 0, 1, 0, 0], 2),
    { maxAlignmentSeconds: 0, maxHammingDistance: 0, segmentWindowSeconds: 0.5 },
  )
  assert.deepEqual(result.segments.map(segment => segment.kind), ['match'])
})

test('cooperative comparison preserves results while yielding inside alignment work', async () => {
  const left = fingerprint(Array.from({ length: 10_000 }, (_, index) => index >>> 0), 8)
  const right = fingerprint(Array.from({ length: 10_000 }, (_, index) => index >>> 0), 8)
  const expected = compareFingerprints(left, right, { maxAlignmentSeconds: 2 })
  let clock = 0
  let yields = 0
  const actual = await compareFingerprintsCooperative(
    left,
    right,
    { maxAlignmentSeconds: 2 },
    {
      budgetMs: 1,
      now: () => ++clock,
      yieldToEventLoop: async () => { yields += 1 },
    },
  )
  assert.deepEqual(actual, expected)
  assert.ok(yields > 1)
})
