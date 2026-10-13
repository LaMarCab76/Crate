import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  albumIdentityTitle,
  formatArtistCredit,
  isVariousArtists,
  matchLocalAlbumForRelease,
  originalReleaseTier,
  rankOriginalReleases,
} from './originalAlbumCandidates.ts'

const query = { title: 'Borrowed Song', artist: 'The Band', durationSeconds: 214 }

function release(patch) {
  return {
    id: patch.id,
    title: patch.title,
    status: patch.status ?? 'Official',
    date: patch.date ?? null,
    country: patch.country ?? 'US',
    'artist-credit': patch.artistCredit,
    'release-group': {
      id: patch.rg,
      'primary-type': patch.primaryType ?? 'Album',
      'secondary-types': patch.secondaryTypes ?? [],
    },
    'track-count': patch.releaseTrackCount ?? 12,
    media: [{
      position: patch.disc ?? 1,
      format: 'CD',
      'track-count': patch.discTrackCount ?? 12,
      'track-offset': (patch.track ?? 1) - 1,
      track: [{ id: `${patch.id}-t`, number: String(patch.track ?? 1), title: 'Borrowed Song', length: 214000 }],
    }],
  }
}

// One studio recording that appears on its original album (two editions), its
// lead single, a live album and a various-artists compilation — plus a cover by
// someone else that must not leak in.
const recordings = [
  {
    id: 'rec-studio',
    title: 'Borrowed Song',
    length: 214000,
    'artist-credit': [{ name: 'The Band', artist: { id: 'artist-band', name: 'The Band' } }],
    releases: [
      release({
        id: 'rel-comp',
        title: 'Now Hits 42',
        date: '2015-06-01',
        rg: 'rg-comp',
        secondaryTypes: ['Compilation'],
        artistCredit: [{ name: 'Various Artists', artist: { id: 'va', name: 'Various Artists' } }],
        track: 7,
        discTrackCount: 20,
      }),
      release({ id: 'rel-single', title: 'Borrowed Song', date: '2009-03-02', rg: 'rg-single', primaryType: 'Single', track: 1, discTrackCount: 2 }),
      release({ id: 'rel-deluxe', title: 'Original Album', date: '2010-11-20', rg: 'rg-album', track: 4, discTrackCount: 16 }),
      release({ id: 'rel-album', title: 'Original Album', date: '2009-05-01', rg: 'rg-album', track: 4, discTrackCount: 12 }),
      release({ id: 'rel-bootleg', title: 'Original Album', date: '2008-12-01', rg: 'rg-album', status: 'Bootleg', track: 4 }),
      release({ id: 'rel-live', title: 'Live at Somewhere', date: '2011-01-01', rg: 'rg-live', secondaryTypes: ['Live'], track: 9 }),
      release({ id: 'rel-pseudo', title: 'Original Album (Transliterated)', date: '2009-05-01', rg: 'rg-pseudo', status: 'Pseudo-Release' }),
    ],
  },
  {
    id: 'rec-cover',
    title: 'Borrowed Song',
    length: 190000,
    'artist-credit': [{ name: 'Someone Else' }],
    releases: [release({ id: 'rel-cover', title: 'Covers', date: '2001-01-01', rg: 'rg-cover', track: 2 })],
  },
]

test('rankOriginalReleases puts the studio album first and the compilation last', () => {
  const ranked = rankOriginalReleases(recordings, query)
  assert.deepEqual(ranked.map(item => item.releaseGroupId), ['rg-album', 'rg-single', 'rg-live', 'rg-comp'])
})

test('rankOriginalReleases represents a release group by its earliest official edition', () => {
  const [album] = rankOriginalReleases(recordings, query)
  assert.equal(album.releaseId, 'rel-album', 'the 2009 official pressing beats the 2010 deluxe and the earlier bootleg')
  assert.deepEqual(album.releaseIds.sort(), ['rel-album', 'rel-bootleg', 'rel-deluxe'])
  assert.equal(album.title, 'Original Album')
  assert.equal(album.artist, 'The Band', 'release without its own credit inherits the recording artist')
  assert.equal(album.year, '2009')
  assert.equal(album.trackNumber, 4)
  assert.equal(album.discNumber, 1)
  assert.equal(album.totalTracks, 12)
  assert.equal(album.recordingId, 'rec-studio')
  assert.equal(album.primaryType, 'Album')
})

test('rankOriginalReleases drops pseudo-releases and recordings by other artists', () => {
  const ids = rankOriginalReleases(recordings, query).map(item => item.releaseGroupId)
  assert.ok(!ids.includes('rg-pseudo'))
  assert.ok(!ids.includes('rg-cover'))
})

test('rankOriginalReleases tolerates empty or malformed input', () => {
  assert.deepEqual(rankOriginalReleases(null, query), [])
  assert.deepEqual(rankOriginalReleases([{ title: 'x' }, 'junk', { releases: 'nope' }], query), [])
})

test('rankOriginalReleases honours the limit', () => {
  assert.equal(rankOriginalReleases(recordings, query, { limit: 2 }).length, 2)
})

test('release tier ranks albums over EPs over singles, and flags compilations', () => {
  const tier = patch => originalReleaseTier({ primaryType: 'Album', secondaryTypes: [], status: 'Official', artist: 'The Band', ...patch })
  assert.ok(tier({}) < tier({ primaryType: 'EP' }))
  assert.ok(tier({ primaryType: 'EP' }) < tier({ primaryType: 'Single' }))
  assert.ok(tier({ primaryType: 'Single' }) < tier({ secondaryTypes: ['Live'] }))
  assert.ok(tier({ secondaryTypes: ['Live'] }) < tier({ secondaryTypes: ['Compilation'] }))
  assert.equal(tier({ artist: 'Various Artists' }), tier({ secondaryTypes: ['Compilation'] }))
  assert.ok(tier({ secondaryTypes: ['Soundtrack'] }) < tier({ primaryType: 'EP' }), 'a soundtrack album still beats an EP')
  assert.ok(tier({ status: 'Bootleg' }) > tier({ secondaryTypes: ['Compilation'] }))
})

test('isVariousArtists recognises common spellings only', () => {
  for (const name of ['Various Artists', 'VA', 'V.A.', 'Varios Artistas', 'various']) {
    assert.equal(isVariousArtists(name), true, name)
  }
  for (const name of ['The Various', 'Vampire Weekend', '', null]) {
    assert.equal(isVariousArtists(name), false, String(name))
  }
})

test('formatArtistCredit honours join phrases', () => {
  assert.equal(formatArtistCredit([
    { name: 'Artist', joinphrase: ' feat. ' },
    { name: 'Guest', joinphrase: '' },
  ]), 'Artist feat. Guest')
  assert.equal(formatArtistCredit([{ name: 'A' }, { name: 'B' }]), 'A, B')
  assert.equal(formatArtistCredit([]), null)
})

test('albumIdentityTitle ignores edition suffixes', () => {
  assert.equal(albumIdentityTitle('Rumours (Deluxe Edition)'), albumIdentityTitle('Rumours'))
  assert.equal(albumIdentityTitle('Rumours [2004 Remaster]'), 'rumours')
  assert.notEqual(albumIdentityTitle('Rumours (Live)'), 'rumours', 'a different work is not an edition')
})

function album(patch) {
  return {
    id: patch.id,
    title: patch.title,
    album_artist: patch.album_artist ?? 'The Band',
    musicbrainz_album_id: patch.musicbrainz_album_id ?? null,
    musicbrainz_release_group_id: patch.musicbrainz_release_group_id ?? null,
    track_count: patch.track_count ?? 5,
  }
}

const original = { releaseIds: ['rel-album', 'rel-deluxe'], releaseGroupId: 'rg-album', title: 'Original Album', artist: 'The Band' }

test('matchLocalAlbumForRelease prefers MusicBrainz ids', () => {
  const albums = [
    album({ id: 1, title: 'Original Album' }),
    album({ id: 2, title: 'Something Else', musicbrainz_release_group_id: 'rg-album' }),
  ]
  assert.equal(matchLocalAlbumForRelease(original, albums)?.id, 2)
  assert.equal(matchLocalAlbumForRelease(original, [album({ id: 3, title: 'X', musicbrainz_album_id: 'rel-deluxe' })])?.id, 3)
})

test('matchLocalAlbumForRelease matches title + album artist ignoring year and edition', () => {
  const albums = [
    album({ id: 1, title: 'Original Album (Remastered)', album_artist: 'the band' }),
    album({ id: 2, title: 'Original Album', album_artist: 'Another Band' }),
  ]
  assert.equal(matchLocalAlbumForRelease(original, albums)?.id, 1)
  assert.equal(
    matchLocalAlbumForRelease({ ...original, releaseGroupId: null, releaseIds: [], artist: 'Simon & Garfunkel', title: 'Bookends' }, [
      album({ id: 9, title: 'Bookends', album_artist: 'Simon and Garfunkel' }),
    ])?.id,
    9,
  )
})

test('matchLocalAlbumForRelease ignores empty album rows and unrelated albums', () => {
  assert.equal(matchLocalAlbumForRelease(original, [album({ id: 1, title: 'Original Album', track_count: 0 })]), null)
  assert.equal(matchLocalAlbumForRelease(original, [album({ id: 1, title: 'Now Hits 42', album_artist: 'Various Artists' })]), null)
})
