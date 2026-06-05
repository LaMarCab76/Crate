import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  FEATURED_PREFIX,
  formatFeatured,
  parseArtistName,
  titleWithFeatured,
} from './artistName.ts'

test('parseArtistName: empty / whitespace', () => {
  assert.deepEqual(parseArtistName(''), { primary: '', featured: [] })
  assert.deepEqual(parseArtistName('   '), { primary: '', featured: [] })
})

test('parseArtistName: no guests', () => {
  assert.deepEqual(parseArtistName('Bad Bunny'), { primary: 'Bad Bunny', featured: [] })
})

test('parseArtistName: feat.', () => {
  assert.deepEqual(parseArtistName('Bad Bunny feat. Drake'), {
    primary: 'Bad Bunny',
    featured: ['Drake'],
  })
})

test('parseArtistName: ft. with multiple guests', () => {
  assert.deepEqual(parseArtistName('A ft. B, C & D'), {
    primary: 'A',
    featured: ['B', 'C', 'D'],
  })
})

test('parseArtistName: "with" marker', () => {
  assert.deepEqual(parseArtistName('A with B'), { primary: 'A', featured: ['B'] })
})

test('parseArtistName: parenthetical credit', () => {
  assert.deepEqual(parseArtistName('A (feat. B)'), { primary: 'A', featured: ['B'] })
})

test('parseArtistName: plain "&" collaborators are NOT split (regression guard)', () => {
  assert.deepEqual(parseArtistName('Crosby, Stills & Nash'), {
    primary: 'Crosby, Stills & Nash',
    featured: [],
  })
})

test('formatFeatured', () => {
  assert.equal(formatFeatured([]), '')
  assert.equal(formatFeatured(['B', 'C']), `${FEATURED_PREFIX} B, C`)
})

test('titleWithFeatured', () => {
  assert.equal(titleWithFeatured('Song', []), 'Song')
  assert.equal(titleWithFeatured('Song', ['B']), `Song (${FEATURED_PREFIX} B)`)
})
