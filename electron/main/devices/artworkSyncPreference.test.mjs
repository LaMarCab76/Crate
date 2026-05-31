import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  canRunSyncWithArtworkOnly,
  resolveOptimizeArtworkSelection,
} from './artworkSyncPreference.ts'

test('explicit optimizeArtwork selection wins over the persisted device default', () => {
  assert.equal(resolveOptimizeArtworkSelection(false, true), false)
  assert.equal(resolveOptimizeArtworkSelection(true, false), true)
})

test('missing optimizeArtwork selection falls back to the persisted device default', () => {
  assert.equal(resolveOptimizeArtworkSelection(undefined, true), true)
  assert.equal(resolveOptimizeArtworkSelection(undefined, false), false)
})

test('a resumed journal keeps its stored artwork decision', () => {
  const persistedDefaultChangedLater = true
  const storedJournalDecision = false

  assert.equal(
    resolveOptimizeArtworkSelection(storedJournalDecision, persistedDefaultChangedLater),
    false,
  )
})

test('sync can run with zero copy actions when artwork optimization is selected', () => {
  assert.equal(canRunSyncWithArtworkOnly(0, true), true)
  assert.equal(canRunSyncWithArtworkOnly(0, false), false)
  assert.equal(canRunSyncWithArtworkOnly(2, false), true)
})
