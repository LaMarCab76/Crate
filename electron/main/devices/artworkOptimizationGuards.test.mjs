import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  artworkBytesSaved,
  artworkOptimizationTempPath,
  assertOptimizedArtworkWithinLimit,
  countProcessedArtworkSteps,
  hasArtworkOverLimit,
  resizedArtworkOutcome,
  shouldYieldArtworkAnalysis,
} from './artworkOptimizationGuards.ts'

function probe(pictures) {
  return { pictures }
}

test('pending and running artwork steps do not advance processed progress', () => {
  assert.equal(countProcessedArtworkSteps([
    { status: 'pending' },
    { status: 'running' },
  ]), 0)
})

test('completed artwork steps advance processed progress', () => {
  assert.equal(countProcessedArtworkSteps([
    { status: 'completed' },
    { status: 'completed' },
    { status: 'pending' },
  ]), 2)
})

test('failed artwork steps advance processed progress', () => {
  assert.equal(countProcessedArtworkSteps([
    { status: 'completed' },
    { status: 'failed' },
    { status: 'running' },
  ]), 2)
})

test('artwork analysis yields periodically before the terminal update', () => {
  assert.equal(shouldYieldArtworkAnalysis(0, 20, 4), false)
  assert.equal(shouldYieldArtworkAnalysis(3, 20, 4), false)
  assert.equal(shouldYieldArtworkAnalysis(4, 20, 4), true)
  assert.equal(shouldYieldArtworkAnalysis(8, 20, 4), true)
  assert.equal(shouldYieldArtworkAnalysis(20, 20, 4), false)
})

test('resized artwork can be accepted without reporting negative savings', () => {
  assert.equal(artworkBytesSaved(1_024, 1_500), 0)
  assert.equal(artworkBytesSaved(1_024, 1_024), 0)
  assert.equal(artworkBytesSaved(1_024, 768), 256)
  assert.deepEqual(resizedArtworkOutcome(1_024, 1_500), {
    optimized: true,
    bytesSaved: 0,
  })
})

test('artwork temp path preserves the audio extension for tag writers', () => {
  assert.equal(
    artworkOptimizationTempPath('/Volumes/H2-SD/ABBA/Arrival/1 - When I Kissed the Teacher.flac'),
    '/Volumes/H2-SD/ABBA/Arrival/1 - When I Kissed the Teacher.crate-tmp.flac',
  )
  assert.equal(
    artworkOptimizationTempPath('/Volumes/H2-SD/ABBA/Arrival/01 - Arrival.mp3'),
    '/Volumes/H2-SD/ABBA/Arrival/01 - Arrival.crate-tmp.mp3',
  )
  assert.equal(
    artworkOptimizationTempPath('/Volumes/H2-SD/ABBA/Arrival/README'),
    '/Volumes/H2-SD/ABBA/Arrival/README.crate-tmp',
  )
})

test('optimized artwork verification accepts supported pictures within limit', () => {
  assert.doesNotThrow(() => assertOptimizedArtworkWithinLimit(probe([
    { format: 'jpeg', width: 600, height: 400 },
    { format: 'png', width: 320, height: 600 },
  ]), 600))
})

test('optimized artwork verification rejects supported pictures over limit', () => {
  assert.throws(
    () => assertOptimizedArtworkWithinLimit(probe([
      { format: 'jpeg', width: 601, height: 500 },
    ]), 600),
    /over 600px limit/,
  )
})

test('optimized artwork verification ignores unsupported pictures', () => {
  assert.doesNotThrow(() => assertOptimizedArtworkWithinLimit(probe([
    { format: null, width: null, height: null },
    { format: 'jpeg', width: null, height: 800 },
    { format: 'png', width: 800, height: null },
  ]), 600))
})

test('artwork over-limit detection only flags supported oversized pictures', () => {
  assert.equal(hasArtworkOverLimit(probe([
    { format: 'jpeg', width: 600, height: 600 },
    { format: 'png', width: 320, height: 480 },
  ]), 600), false)

  assert.equal(hasArtworkOverLimit(probe([
    { format: 'jpeg', width: 601, height: 600 },
  ]), 600), true)

  assert.equal(hasArtworkOverLimit(probe([
    { format: null, width: null, height: null },
    { format: 'png', width: null, height: 900 },
  ]), 600), false)
})
