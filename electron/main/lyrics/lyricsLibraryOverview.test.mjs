import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  buildLyricsLibraryOverview,
  buildOverviewWithIndex,
  emptyLyricsView,
  lyricsIndexEntryToView,
  lyricsViewHasLibraryLyrics,
  lyricsViewToIndexEntry,
  viewFromDiskReads,
  viewFromLyricsResult,
} from './lyricsLibraryOverview.ts'

function track(id, patch = {}) {
  return {
    id,
    path: `/music/${id}.flac`,
    filename: `${id}.flac`,
    title: `Title ${id}`,
    artist: 'Artist',
    album: 'Album',
    duration: 120,
    format: 'FLAC',
    folder_id: 1,
    file_size: null,
    date_modified: null,
    album_artist: null,
    composer: '',
    genre: '',
    year: '',
    is_favorite: 0,
    play_count: 0,
    last_played_date: null,
    rating: null,
    track_number: null,
    total_tracks: null,
    disc_number: null,
    total_discs: null,
    compilation: 0,
    release_date: null,
    original_release_date: null,
    bpm: null,
    musical_key: null,
    media_type: null,
    sort_title: null,
    sort_artist: null,
    sort_album: null,
    sort_album_artist: null,
    bitrate: null,
    sample_rate: null,
    channels: null,
    codec: null,
    bit_depth: null,
    artwork_data: null,
    artwork_path: null,
    date_added: '',
    is_duplicate: 0,
    primary_track_id: null,
    duplicate_group_id: null,
    extended_metadata: null,
    album_id: null,
    artist_id: null,
    genre_id: null,
    r128_integrated_loudness: null,
    state_updated_at: null,
    ...patch,
  }
}

function view(status, patch = {}) {
  return {
    trackId: 0,
    status,
    source: null,
    plainLyrics: null,
    syncedLyricsLrc: null,
    instrumental: false,
    isUserEdited: false,
    embeddedInFile: false,
    sidecarWritten: false,
    confidence: 0,
    ...patch,
  }
}

test('classifies sidecar, embedded, instrumental and missing lyrics', () => {
  const views = new Map([
    [1, view('found_synced', { source: 'sidecar', sidecarWritten: true, syncedLyricsLrc: '[00:01.00]a' })],
    [2, view('found_plain', { source: 'embedded', embeddedInFile: true, plainLyrics: 'b' })],
    [3, view('instrumental', { source: 'lrclib', instrumental: true })],
    [4, view('none')],
  ])
  const overview = buildLyricsLibraryOverview(
    [track(4), track(1), track(2), track(3)],
    id => views.get(id),
  )

  assert.equal(overview.total, 4)
  assert.equal(overview.withLyrics, 3)
  assert.equal(overview.missingLyrics, 1)
  assert.equal(overview.items.find(item => item.trackId === 1).hasLyrics, true)
  assert.equal(overview.items.find(item => item.trackId === 2).embeddedInFile, true)
  assert.equal(overview.items.find(item => item.trackId === 4).hasLyrics, false)
})

test('lyricsViewToIndexEntry keeps only the cached subset', () => {
  const entry = lyricsViewToIndexEntry(
    view('found_synced', { source: 'sidecar', sidecarWritten: true, syncedLyricsLrc: '[00:01.00]a' }),
  )
  assert.deepEqual(entry, {
    status: 'found_synced',
    source: 'sidecar',
    hasLyrics: true,
    embeddedInFile: false,
    sidecarWritten: true,
  })
})

test('view <-> entry round-trips the overview-relevant fields', () => {
  const original = view('found_plain', { source: 'embedded', embeddedInFile: true, plainLyrics: 'b' })
  const entry = lyricsViewToIndexEntry(original)
  const restored = lyricsIndexEntryToView(7, entry)
  assert.equal(restored.trackId, 7)
  assert.equal(restored.status, original.status)
  assert.equal(restored.source, original.source)
  assert.equal(restored.embeddedInFile, original.embeddedInFile)
  assert.equal(restored.sidecarWritten, original.sidecarWritten)
  // hasLyrics is re-derived from status and must agree with the canonical helper.
  assert.equal(lyricsViewHasLibraryLyrics(restored), entry.hasLyrics)
})

test('hasLyrics matches lyricsViewHasLibraryLyrics for every status', () => {
  for (const status of ['found_synced', 'found_plain', 'instrumental']) {
    assert.equal(lyricsViewToIndexEntry(view(status)).hasLyrics, true, status)
  }
  for (const status of ['none', 'not_found', 'low_confidence', 'failed_provider']) {
    assert.equal(lyricsViewToIndexEntry(view(status)).hasLyrics, false, status)
  }
})

test('buildOverviewWithIndex uses the cache and only scans unknown tracks', async () => {
  const tracks = [track(1), track(2), track(3)]
  const cache = new Map([
    [1, { status: 'found_synced', source: 'sidecar', hasLyrics: true, embeddedInFile: false, sidecarWritten: true }],
    [3, { status: 'none', source: null, hasLyrics: false, embeddedInFile: false, sidecarWritten: false }],
  ])
  const scanned = []
  const populated = []
  const progress = []
  const overview = await buildOverviewWithIndex(tracks, {
    yieldEvery: 1,
    lookup: t => cache.get(t.id) ?? null,
    scan: t => {
      scanned.push(t.id)
      return view('found_plain', { trackId: t.id, source: 'sidecar', sidecarWritten: true, plainLyrics: 'x' })
    },
    onScanned: (t, entry) => populated.push([t.id, entry.status]),
    onProgress: (done, total) => progress.push([done, total]),
  })

  // Only track 2 (absent from the cache) hit the disk scan.
  assert.deepEqual(scanned, [2])
  assert.deepEqual(populated, [[2, 'found_plain']])
  // Progress fires only because a scan happened, and ends at (total, total).
  assert.ok(progress.length > 0)
  assert.deepEqual(progress.at(-1), [3, 3])
  assert.equal(overview.total, 3)
  // Track 1 (synced) and track 2 (scanned plain) have lyrics; track 3 (none) does not.
  assert.equal(overview.withLyrics, 2)
  assert.equal(overview.missingLyrics, 1)
})

test('buildOverviewWithIndex skips progress when everything is cached', async () => {
  const tracks = [track(1)]
  const cache = new Map([
    [1, { status: 'found_synced', source: 'sidecar', hasLyrics: true, embeddedInFile: false, sidecarWritten: true }],
  ])
  const progress = []
  await buildOverviewWithIndex(tracks, {
    lookup: t => cache.get(t.id) ?? null,
    scan: () => { throw new Error('should not scan a cached track') },
    onProgress: (done, total) => progress.push([done, total]),
  })
  assert.equal(progress.length, 0)
})

function lyricsResult(patch = {}) {
  return {
    source: 'sidecar',
    plainLyrics: undefined,
    syncedLyricsLrc: undefined,
    instrumental: false,
    confidence: 1,
    ...patch,
  }
}

test('viewFromDiskReads: sidecar wins over embedded and sets the right flags', () => {
  const sidecar = lyricsResult({ source: 'sidecar', syncedLyricsLrc: '[00:01.00]a' })
  const embedded = lyricsResult({ source: 'embedded', plainLyrics: 'b' })
  const v = viewFromDiskReads(5, sidecar, embedded)
  assert.equal(v.trackId, 5)
  assert.equal(v.status, 'found_synced')
  assert.equal(v.source, 'sidecar')
  assert.equal(v.sidecarWritten, true)
  assert.equal(v.embeddedInFile, false)
  assert.equal(v.syncedLyricsLrc, '[00:01.00]a')
})

test('viewFromDiskReads: embedded-only marks embeddedInFile', () => {
  const v = viewFromDiskReads(6, null, lyricsResult({ source: 'embedded', plainLyrics: 'b' }))
  assert.equal(v.status, 'found_plain')
  assert.equal(v.source, 'embedded')
  assert.equal(v.embeddedInFile, true)
  assert.equal(v.sidecarWritten, false)
})

test('viewFromDiskReads: instrumental result is instrumental', () => {
  const v = viewFromDiskReads(7, lyricsResult({ instrumental: true }), null)
  assert.equal(v.status, 'instrumental')
  assert.equal(v.instrumental, true)
})

test('viewFromDiskReads: no reads yields a none view (matches emptyLyricsView)', () => {
  const v = viewFromDiskReads(8, null, null)
  assert.equal(v.status, 'none')
  assert.equal(v.embeddedInFile, false)
  assert.equal(v.sidecarWritten, false)
  assert.deepEqual(v, emptyLyricsView(8, 'none'))
})

test('viewFromDiskReads → lyricsViewToIndexEntry mirrors the worker scan path', () => {
  // The library worker composes exactly these two pure helpers, so the index
  // entry it produces must match the in-main getForTrack derivation.
  const entry = lyricsViewToIndexEntry(viewFromDiskReads(9, lyricsResult({ source: 'sidecar', plainLyrics: 'x' }), null))
  assert.deepEqual(entry, {
    status: 'found_plain',
    source: 'sidecar',
    hasLyrics: true,
    embeddedInFile: false,
    sidecarWritten: true,
  })
})

test('viewFromLyricsResult: plain text without sync is found_plain', () => {
  const v = viewFromLyricsResult(10, lyricsResult({ source: 'embedded', plainLyrics: 'hi' }), {
    sidecarWritten: false,
    embeddedInFile: true,
  })
  assert.equal(v.status, 'found_plain')
  assert.equal(v.plainLyrics, 'hi')
  assert.equal(v.syncedLyricsLrc, null)
})

test('buildOverviewWithIndex force rescans everything', async () => {
  const tracks = [track(1), track(2)]
  const cache = new Map([
    [1, { status: 'found_synced', source: 'sidecar', hasLyrics: true, embeddedInFile: false, sidecarWritten: true }],
    [2, { status: 'found_synced', source: 'sidecar', hasLyrics: true, embeddedInFile: false, sidecarWritten: true }],
  ])
  const scanned = []
  await buildOverviewWithIndex(tracks, {
    force: true,
    lookup: t => cache.get(t.id) ?? null,
    scan: t => {
      scanned.push(t.id)
      return view('none', { trackId: t.id })
    },
  })
  assert.deepEqual(scanned, [1, 2])
})
