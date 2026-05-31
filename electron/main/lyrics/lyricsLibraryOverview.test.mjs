import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { buildLyricsLibraryOverview } from './lyricsLibraryOverview.ts'

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
