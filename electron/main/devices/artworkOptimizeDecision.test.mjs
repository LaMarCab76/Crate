import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { classifyArtwork } from './artworkOptimizeDecision.ts'

function state(patch = {}) {
  return {
    maxEdge: 600,
    hasPicture: true,
    format: 'jpeg',
    width: 500,
    height: 500,
    ...patch,
  }
}

test('no embedded picture -> no_artwork', () => {
  assert.equal(classifyArtwork(state({ hasPicture: false })), 'no_artwork')
})

test('picture with unknown format -> unsupported', () => {
  assert.equal(classifyArtwork(state({ format: null })), 'unsupported')
})

test('picture without decoded dimensions -> unsupported', () => {
  assert.equal(classifyArtwork(state({ width: null })), 'unsupported')
  assert.equal(classifyArtwork(state({ height: null })), 'unsupported')
})

test('width over the edge -> oversized', () => {
  assert.equal(classifyArtwork(state({ width: 601, height: 500 })), 'oversized')
})

test('height over the edge -> oversized', () => {
  assert.equal(classifyArtwork(state({ width: 500, height: 601 })), 'oversized')
})

test('png over the edge -> oversized', () => {
  assert.equal(classifyArtwork(state({ format: 'png', width: 2000, height: 2000 })), 'oversized')
})

test('exactly at the edge on both axes -> within_limit', () => {
  assert.equal(classifyArtwork(state({ width: 600, height: 600 })), 'within_limit')
})

test('comfortably below the edge -> within_limit', () => {
  assert.equal(classifyArtwork(state({ width: 300, height: 450 })), 'within_limit')
})
