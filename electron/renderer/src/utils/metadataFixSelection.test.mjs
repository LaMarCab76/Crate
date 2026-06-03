import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  countSelectedFields,
  initialSelection,
  isTrackFullySelected,
  isTrackPartiallySelected,
  keyFor,
  selectionsFromState,
  toggleTrackInSelection,
  trackKeys,
} from './metadataFixSelection.ts'

function field(patch) {
  return {
    field: patch.field,
    current: patch.current ?? null,
    proposed: patch.proposed ?? null,
    source: patch.source ?? 'filename',
    confidence: patch.confidence ?? 0.9,
    selected: patch.selected ?? false,
  }
}

function candidate(patch) {
  return {
    trackId: patch.trackId,
    title: patch.title ?? 'Title',
    artist: patch.artist ?? 'Artist',
    album: patch.album ?? 'Album',
    path: patch.path ?? '/music/song.flac',
    confidence: patch.confidence ?? 0.9,
    fields: patch.fields ?? [],
    artwork: patch.artwork ?? null,
    warnings: patch.warnings ?? [],
  }
}

function artwork(patch = {}) {
  return {
    currentArtworkPath: patch.currentArtworkPath ?? null,
    proposedDataUrl: patch.proposedDataUrl ?? 'data:image/png;base64,AAAA',
    mimeType: patch.mimeType ?? 'image/png',
    source: patch.source ?? 'cover-art-archive',
    confidence: patch.confidence ?? 0.8,
    selected: patch.selected ?? false,
  }
}

const preview = {
  previewId: 'prev-1',
  createdAt: 0,
  candidates: [
    candidate({
      trackId: 1,
      fields: [
        field({ field: 'title', current: null, proposed: 'Bohemian Rhapsody', selected: true }),
        field({ field: 'artist', current: 'Unknown', proposed: 'Queen', selected: true }),
      ],
      artwork: artwork({ selected: false }),
    }),
    candidate({
      trackId: 2,
      fields: [field({ field: 'album', current: null, proposed: 'Hot Space', selected: false })],
      artwork: null,
    }),
  ],
}

test('keyFor builds the trackId:field key', () => {
  assert.equal(keyFor(7, 'artist'), '7:artist')
})

test('trackKeys lists every field key plus artwork when present', () => {
  assert.deepEqual(trackKeys(preview.candidates[0]), ['1:title', '1:artist', '1:artwork'])
  assert.deepEqual(trackKeys(preview.candidates[1]), ['2:album'])
})

test('initialSelection picks only the pre-flagged fields and artwork', () => {
  const selected = initialSelection(preview)
  assert.deepEqual([...selected].sort(), ['1:artist', '1:title'])
})

test('initialSelection includes artwork when flagged selected', () => {
  const withArt = {
    ...preview,
    candidates: [candidate({ trackId: 9, fields: [], artwork: artwork({ selected: true }) })],
  }
  assert.deepEqual([...initialSelection(withArt)], ['9:artwork'])
})

test('selectionsFromState maps keys back and drops empty tracks', () => {
  const selected = new Set(['1:title', '1:artist', '1:artwork'])
  const result = selectionsFromState(preview, selected)
  assert.deepEqual(result, [{ trackId: 1, fields: ['title', 'artist', 'artwork'] }])
})

test('selectionsFromState omits artwork when its key is not selected', () => {
  const selected = new Set(['1:title'])
  const result = selectionsFromState(preview, selected)
  assert.deepEqual(result, [{ trackId: 1, fields: ['title'] }])
})

test('isTrackFullySelected / isTrackPartiallySelected reflect the set', () => {
  const none = new Set()
  const some = new Set(['1:title'])
  const all = new Set(['1:title', '1:artist', '1:artwork'])
  const track = preview.candidates[0]

  assert.equal(isTrackFullySelected(track, none), false)
  assert.equal(isTrackPartiallySelected(track, none), false)

  assert.equal(isTrackFullySelected(track, some), false)
  assert.equal(isTrackPartiallySelected(track, some), true)

  assert.equal(isTrackFullySelected(track, all), true)
  assert.equal(isTrackPartiallySelected(track, all), false)
})

test('toggleTrackInSelection adds/removes all keys immutably', () => {
  const start = new Set(['2:album'])
  const track = preview.candidates[0]

  const added = toggleTrackInSelection(track, start, true)
  assert.notEqual(added, start)
  assert.deepEqual([...start], ['2:album'])
  assert.deepEqual([...added].sort(), ['1:artist', '1:title', '1:artwork', '2:album'].sort())

  const removed = toggleTrackInSelection(track, added, false)
  assert.deepEqual([...removed], ['2:album'])
})

test('countSelectedFields sums field counts', () => {
  const selections = [
    { trackId: 1, fields: ['title', 'artist'] },
    { trackId: 2, fields: ['album'] },
  ]
  assert.equal(countSelectedFields(selections), 3)
})
