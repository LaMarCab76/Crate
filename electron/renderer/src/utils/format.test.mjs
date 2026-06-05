import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { fmtTime, formatPlaybackTimePair } from './format.ts'

test('fmtTime keeps the existing floored minute-second format', () => {
  assert.equal(fmtTime(99.9), '1:39')
})

test('playback time pair keeps elapsed and remaining counters in lockstep', () => {
  const beforeTick = formatPlaybackTimePair(99.9, 265.8)
  const afterTick = formatPlaybackTimePair(100, 265.8)

  assert.equal(beforeTick.elapsedText, '1:39')
  assert.equal(beforeTick.remainingText, '2:46')
  assert.equal(afterTick.elapsedText, '1:40')
  assert.equal(afterTick.remainingText, '2:45')
})

test('playback time pair clamps the playhead to the displayed duration', () => {
  assert.deepEqual(formatPlaybackTimePair(266.2, 265.8), {
    elapsedSec: 265,
    remainingSec: 0,
    elapsedText: '4:25',
    remainingText: '0:00',
  })
})

test('playback time pair preserves elapsed time when duration is unknown', () => {
  assert.deepEqual(formatPlaybackTimePair(7.4, 0), {
    elapsedSec: 7,
    remainingSec: 0,
    elapsedText: '0:07',
    remainingText: '0:00',
  })
})
