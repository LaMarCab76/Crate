import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  diceTokenSimilarity,
  isUnknownArtist,
  normalizeDuplicateText,
  normalizeDuplicateTitle,
  normalizePrimaryArtist,
} from './normalization.ts'

test('normalizes accents, punctuation and whitespace deterministically', () => {
  assert.equal(normalizeDuplicateText('  Canción—N.º 2!  '), 'cancion n o 2')
  assert.equal(normalizePrimaryArtist('Beyoncé feat. JAY-Z'), 'beyonce')
  assert.equal(isUnknownArtist('Artista desconocido'), true)
})

test('removes controlled edition qualifiers but preserves real title clauses', () => {
  assert.deepEqual(normalizeDuplicateTitle('The Song (2011 Remastered) - Live'), {
    original: 'The Song (2011 Remastered) - Live',
    base: 'the song',
    tokens: ['the', 'song'],
    qualifiers: ['remastered', 'live'],
  })
  assert.equal(normalizeDuplicateTitle('The Song (Part 2)').base, 'the song part 2')
})

test('computes Dice similarity over unique normalized tokens', () => {
  assert.equal(diceTokenSimilarity(['blue', 'song'], ['blue', 'song', 'extended']), 0.8)
  assert.equal(diceTokenSimilarity(['blue'], ['red']), 0)
  assert.equal(diceTokenSimilarity([], []), 0)
})
