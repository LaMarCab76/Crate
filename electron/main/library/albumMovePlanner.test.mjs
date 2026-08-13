import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { join } from 'node:path'
import {
  albumDiscOccupants,
  albumMoveFilename,
  albumMovePreviewPlacementFlags,
  albumMoveTitlesMatch,
  chooseAlbumMoveDirectory,
  findAlbumMoveDuplicate,
  findTracklistSlot,
  firstFreeAlbumSlot,
  planAlbumMoveDestination,
  sanitizeAlbumMoveFilenamePart,
} from './trackAlbumMovePlanner.ts'

test('blocked album move previews do not claim an estimated append placement', () => {
  assert.deepEqual(albumMovePreviewPlacementFlags(null, 'append'), {
    isEstimated: false,
    isAppend: false,
  })
  assert.deepEqual(albumMovePreviewPlacementFlags({}, 'append'), {
    isEstimated: true,
    isAppend: true,
  })
  assert.deepEqual(albumMovePreviewPlacementFlags({}, 'musicbrainz'), {
    isEstimated: false,
    isAppend: false,
  })
})

function track(patch) {
  return {
    id: patch.id ?? 1,
    path: patch.path,
    title: patch.title ?? 'Track',
    disc_number: patch.disc_number ?? null,
    track_number: patch.track_number ?? null,
    folder_id: patch.folder_id ?? 1,
  }
}

test('album move filename sanitizes unsafe title parts and uses destination track number', () => {
  assert.equal(sanitizeAlbumMoveFilenamePart('  ..A/B: C?*  '), 'A-B- C')
  assert.equal(albumMoveFilename({
    title: 'A/B: C?*',
    sourcePath: '/music/source/song.flac',
    trackNumber: 3,
    totalTracks: 12,
    discNumber: 1,
    totalDiscs: 1,
    singleDirectoryMultiDisc: false,
  }), '03 - A-B- C.flac')
})

test('single-directory multidisc albums get a disc prefix to avoid filename collisions', () => {
  const filename = albumMoveFilename({
    title: 'Same Title',
    sourcePath: '/music/source/song.mp3',
    trackNumber: 1,
    totalTracks: 9,
    discNumber: 2,
    totalDiscs: 2,
    singleDirectoryMultiDisc: true,
  })

  assert.equal(filename, 'D2-01 - Same Title.mp3')
})

test('planner picks the matching disc folder before the album majority folder', () => {
  const tracks = [
    track({ id: 10, path: '/library/Album/CD1/01 - Intro.flac', disc_number: 1 }),
    track({ id: 11, path: '/library/Album/CD1/02 - Single.flac', disc_number: 1 }),
    track({ id: 12, path: '/library/Album/CD2/01 - Deep Cut.flac', disc_number: 2 }),
  ]

  assert.equal(chooseAlbumMoveDirectory(tracks, 2), '/library/Album/CD2')
  assert.equal(chooseAlbumMoveDirectory(tracks, null), '/library/Album/CD1')
})

test('planner builds final path from destination folder and formatted filename', () => {
  const tracks = [
    track({ id: 10, path: '/library/Album/01 - Existing.flac', disc_number: 1 }),
    track({ id: 11, path: '/library/Album/02 - Existing.flac', disc_number: 1 }),
  ]
  const planned = planAlbumMoveDestination({
    sourcePath: '/imports/better-quality-source.wav',
    targetTracks: tracks,
    title: 'Destination Song',
    trackNumber: 7,
    totalTracks: 10,
    discNumber: 1,
    totalDiscs: 1,
  })

  assert.equal(planned.filename, '07 - Destination Song.wav')
  assert.equal(planned.destinationPath, join('/library/Album', '07 - Destination Song.wav'))
  assert.equal(planned.usesDiscPrefix, false)
})

test('duplicate detection blocks an occupied track slot in the destination album', () => {
  const duplicate = findAlbumMoveDuplicate({
    targetTracks: [
      track({ id: 8, path: '/library/Album/03 - Existing.flac', title: 'Different Song', disc_number: 1, track_number: 3 }),
    ],
    sourceTrackId: 1,
    title: 'Borrowed Song',
    trackNumber: 3,
    discNumber: 1,
  })

  assert.deepEqual(duplicate, {
    id: 8,
    title: 'Different Song',
    path: '/library/Album/03 - Existing.flac',
    reason: 'slot',
  })
})

test('duplicate detection blocks an existing local title even with accents/case drift', () => {
  const duplicate = findAlbumMoveDuplicate({
    targetTracks: [
      track({ id: 8, path: '/library/Album/09 - Cancion.flac', title: 'Canción Final', disc_number: 1, track_number: 9 }),
    ],
    sourceTrackId: 1,
    title: 'cancion final',
    trackNumber: 4,
    discNumber: 1,
  })

  assert.equal(duplicate?.reason, 'title')
  assert.equal(duplicate?.id, 8)
})

test('albumDiscOccupants maps occupied numbers on the disc and skips the source track', () => {
  const occupants = albumDiscOccupants(
    [
      track({ id: 1, title: 'Source', disc_number: 1, track_number: 2 }),
      track({ id: 8, title: 'One', disc_number: 1, track_number: 1 }),
      track({ id: 9, title: 'Three', disc_number: 1, track_number: 3 }),
      track({ id: 10, title: 'Other Disc', disc_number: 2, track_number: 1 }),
    ],
    1,
    1,
  )

  assert.deepEqual([...occupants.keys()].sort((a, b) => a - b), [1, 3])
  assert.equal(occupants.get(1)?.title, 'One')
  assert.equal(occupants.has(2), false, 'the source track must not count as an occupant')
})

test('firstFreeAlbumSlot finds the first gap, or null when the album is full', () => {
  const occupants = new Map([
    [1, track({ id: 8, track_number: 1 })],
    [2, track({ id: 9, track_number: 2 })],
    [4, track({ id: 10, track_number: 4 })],
  ])
  assert.equal(firstFreeAlbumSlot(occupants, 5), 3)

  const full = new Map([
    [1, track({ id: 8, track_number: 1 })],
    [2, track({ id: 9, track_number: 2 })],
  ])
  assert.equal(firstFreeAlbumSlot(full, 2), null)
  // unknown total -> probe up to the highest occupied number
  assert.equal(firstFreeAlbumSlot(occupants, null), 3)
})

test('albumMoveTitlesMatch normalizes accents and case', () => {
  assert.equal(albumMoveTitlesMatch('Canción Final', 'cancion final'), true)
  assert.equal(albumMoveTitlesMatch('A', 'B'), false)
})

test('albumMoveTitlesMatch treats curly and straight apostrophes/quotes as equal', () => {
  // Same song tagged with a typographic apostrophe in one album and a straight
  // one in the other must be recognised as the same track (regression).
  assert.equal(albumMoveTitlesMatch("Girl Can't Help It", 'Girl Can’t Help It'), true)
  assert.equal(albumMoveTitlesMatch('Girl Can’t Help It', 'Girl Cant Help It'), true)
  assert.equal(albumMoveTitlesMatch('The “Best”', 'the "best"'), true)
})

test('findAlbumMoveDuplicate matches a same-titled slot across apostrophe styles', () => {
  const duplicate = findAlbumMoveDuplicate({
    targetTracks: [
      track({ id: 8, path: '/library/Album/01 - Girl.flac', title: 'Girl Can’t Help It', disc_number: 1, track_number: 1 }),
    ],
    sourceTrackId: 1,
    title: "Girl Can't Help It",
    trackNumber: 1,
    discNumber: 1,
  })
  assert.equal(duplicate?.reason, 'slot')
  assert.equal(duplicate?.id, 8)
})

const TRACKLIST = [
  { discNumber: 1, trackNumber: 1, title: 'Intro' },
  { discNumber: 1, trackNumber: 2, title: 'Verse' },
  { discNumber: 1, trackNumber: 3, title: 'Borrowed Song' },
  { discNumber: 1, trackNumber: 4, title: 'Outro' },
]

test('findTracklistSlot locates a track by exact title — even on a gap slot', () => {
  const match = findTracklistSlot({ tracklist: TRACKLIST, title: 'Borrowed Song', discNumber: 1 })
  assert.equal(match?.trackNumber, 3)
  assert.equal(match?.discNumber, 1)
  assert.equal(match?.score, 1)
})

test('findTracklistSlot matches despite accent/case and apostrophe drift', () => {
  const tracklist = [
    { discNumber: 1, trackNumber: 7, title: 'Canción Final' },
    { discNumber: 1, trackNumber: 8, title: 'Girl Can’t Help It' },
  ]
  assert.equal(findTracklistSlot({ tracklist, title: 'cancion final', discNumber: 1 })?.trackNumber, 7)
  assert.equal(findTracklistSlot({ tracklist, title: "Girl Can't Help It", discNumber: 1 })?.trackNumber, 8)
})

test('findTracklistSlot uses token overlap above minScore and rejects below it', () => {
  const tracklist = [{ discNumber: 1, trackNumber: 5, title: 'The Long Winding Road Home' }]
  // 4 of 5 tokens overlap -> 0.8, above the default 0.6 threshold.
  assert.equal(findTracklistSlot({ tracklist, title: 'Long Winding Road Home', discNumber: 1 })?.trackNumber, 5)
  // Only 1 of 5 tokens overlaps -> 0.2, below threshold -> no match.
  assert.equal(findTracklistSlot({ tracklist, title: 'Home Alone', discNumber: 1 }), null)
})

test('findTracklistSlot prefers the requested disc when the title repeats', () => {
  const tracklist = [
    { discNumber: 1, trackNumber: 4, title: 'Reprise' },
    { discNumber: 2, trackNumber: 9, title: 'Reprise' },
  ]
  assert.equal(findTracklistSlot({ tracklist, title: 'Reprise', discNumber: 2 })?.trackNumber, 9)
  assert.equal(findTracklistSlot({ tracklist, title: 'Reprise', discNumber: 1 })?.trackNumber, 4)
})

test('findTracklistSlot returns null for an empty tracklist (MusicBrainz offline)', () => {
  assert.equal(findTracklistSlot({ tracklist: [], title: 'Borrowed Song', discNumber: 1 }), null)
})
