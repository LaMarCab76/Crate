import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { join } from 'node:path'
import {
  albumDirectoryFromTrackPaths,
  chooseNewAlbumDirectory,
  detectAlbumFolderStyle,
  newAlbumFolderName,
  planNewAlbumDestination,
} from './newAlbumMovePlanner.ts'

const root = join('/music', 'Library')

test('albumDirectoryFromTrackPaths returns the album folder, climbing out of disc folders', () => {
  assert.equal(
    albumDirectoryFromTrackPaths([join(root, 'Band', 'Album', '01 - A.flac'), join(root, 'Band', 'Album', '02 - B.flac')]),
    join(root, 'Band', 'Album'),
  )
  assert.equal(
    albumDirectoryFromTrackPaths([join(root, 'Band', 'Album', 'CD1', '01 - A.flac'), join(root, 'Band', 'Album', 'CD1', '02 - B.flac')]),
    join(root, 'Band', 'Album'),
  )
  assert.equal(albumDirectoryFromTrackPaths([]), null)
})

test('detectAlbumFolderStyle follows the majority of sibling folders', () => {
  assert.equal(detectAlbumFolderStyle(['2009 - First', '2012 - Second', 'Odd One']), 'year-dash-title')
  assert.equal(detectAlbumFolderStyle(['First (2009)', 'Second (2012)']), 'title-paren-year')
  assert.equal(detectAlbumFolderStyle(['[2009] First', 'Second']), 'plain', 'no strict majority')
  assert.equal(detectAlbumFolderStyle([]), 'plain')
})

test('newAlbumFolderName applies the style and sanitizes the name', () => {
  assert.equal(newAlbumFolderName({ title: 'Original Album', year: '2009', style: 'year-dash-title' }), '2009 - Original Album')
  assert.equal(newAlbumFolderName({ title: 'Original Album', year: '2009', style: 'title-bracket-year' }), 'Original Album [2009]')
  assert.equal(newAlbumFolderName({ title: 'Original Album', year: null, style: 'year-dash-title' }), 'Original Album', 'no year, no prefix')
  assert.equal(newAlbumFolderName({ title: 'AC/DC: Live?', year: null, style: 'plain' }), 'AC DC Live')
  assert.equal(newAlbumFolderName({ title: 'CON', year: null, style: 'plain' }), '_CON', 'Windows reserved names are escaped')
})

test('chooseNewAlbumDirectory places the album next to the artist albums with their naming style', () => {
  const plan = chooseNewAlbumDirectory({
    rootPath: root,
    albumArtist: 'The Band',
    albumTitle: 'Original Album',
    year: '2009',
    artistAlbumDirectories: [join(root, 'The Band', '2012 - Second'), join(root, 'The Band', '2015 - Third')],
  })
  assert.equal(plan.strategy, 'artist-siblings')
  assert.equal(plan.directory, join(root, 'The Band', '2009 - Original Album'))
})

test('chooseNewAlbumDirectory falls back to <root>/<Album Artist>/<Album>', () => {
  const plan = chooseNewAlbumDirectory({
    rootPath: root,
    albumArtist: 'The Band',
    albumTitle: 'Original Album',
    year: '2009',
    artistAlbumDirectories: [join('/elsewhere', 'The Band', 'Second')],
  })
  assert.equal(plan.strategy, 'artist-folder')
  assert.equal(plan.directory, join(root, 'The Band', 'Original Album'))
  assert.equal(
    chooseNewAlbumDirectory({ rootPath: root, albumArtist: null, albumTitle: 'X', year: null, artistAlbumDirectories: [] }).directory,
    join(root, 'Unknown Artist', 'X'),
  )
})

test('planNewAlbumDestination names the file like the rest of the album moves', () => {
  const single = planNewAlbumDestination({
    directory: join(root, 'The Band', 'Original Album'),
    sourcePath: join(root, 'Crate Downloads', 'Now Hits 42', '07 - Borrowed Song.flac'),
    title: 'Borrowed Song',
    trackNumber: 4,
    totalTracks: 12,
    discNumber: 1,
    totalDiscs: 1,
  })
  assert.equal(single.filename, '04 - Borrowed Song.flac')
  assert.equal(single.destinationPath, join(root, 'The Band', 'Original Album', '04 - Borrowed Song.flac'))

  const multi = planNewAlbumDestination({
    directory: join(root, 'The Band', 'Big Album'),
    sourcePath: 'x.m4a',
    title: 'Song',
    trackNumber: 3,
    totalTracks: 9,
    discNumber: 2,
    totalDiscs: 2,
  })
  assert.equal(multi.filename, 'D2-03 - Song.m4a')
  assert.equal(multi.usesDiscPrefix, true)
})
