import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  LYRICS_AUTOSCROLL_RESUME_LINE_DELTA,
  lyricsAutoScrollDecision,
  pauseLyricsAutoScroll,
} from './lyricsAutoScroll.ts'

test('auto-scrolls immediately when the user has not moved through lyrics', () => {
  assert.deepEqual(lyricsAutoScrollDecision(null, 7), {
    shouldScroll: true,
    pausedAtLineIndex: null,
  })
})

test('pauses auto-scroll after manual lyric navigation', () => {
  const pausedAt = pauseLyricsAutoScroll(10)

  assert.deepEqual(lyricsAutoScrollDecision(pausedAt, 11), {
    shouldScroll: false,
    pausedAtLineIndex: 10,
  })
  assert.deepEqual(lyricsAutoScrollDecision(pausedAt, 13), {
    shouldScroll: false,
    pausedAtLineIndex: 10,
  })
})

test('resumes auto-scroll after four active lyric lines pass', () => {
  const pausedAt = pauseLyricsAutoScroll(10)

  assert.deepEqual(lyricsAutoScrollDecision(pausedAt, 10 + LYRICS_AUTOSCROLL_RESUME_LINE_DELTA), {
    shouldScroll: true,
    pausedAtLineIndex: null,
  })
})

test('resumes after large jumps in either direction', () => {
  const pausedAt = pauseLyricsAutoScroll(10)

  assert.deepEqual(lyricsAutoScrollDecision(pausedAt, 6), {
    shouldScroll: true,
    pausedAtLineIndex: null,
  })
  assert.deepEqual(lyricsAutoScrollDecision(pausedAt, 15), {
    shouldScroll: true,
    pausedAtLineIndex: null,
  })
})

test('handles intro navigation before the first timed line', () => {
  const pausedAt = pauseLyricsAutoScroll(-1)

  assert.deepEqual(lyricsAutoScrollDecision(pausedAt, 2), {
    shouldScroll: false,
    pausedAtLineIndex: -1,
  })
  assert.deepEqual(lyricsAutoScrollDecision(pausedAt, 3), {
    shouldScroll: true,
    pausedAtLineIndex: null,
  })
})
