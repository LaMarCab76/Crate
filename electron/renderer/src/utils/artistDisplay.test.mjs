import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { buildDisplayedArtists } from './artistDisplay.ts'

function track(id, artistId, artist) {
  return {
    id: `t${id}`,
    dbId: id,
    artistId,
    artist,
    t: `Track ${id}`,
  }
}

function album(id, artist, tracks, artworkPath) {
  return {
    id: `a${id}`,
    title: `Album ${id}`,
    artist,
    year: 2020 + id,
    added: `202${id}-01-01`,
    artworkPath,
    tracks,
  }
}

function artist(id, name) {
  return {
    id: `ar${id}`,
    dbId: id,
    name,
    albums: [],
    seed: id,
    palette: ['#000', '#111', '#222'],
    pattern: 'circles',
    trackCount: 0,
  }
}

const lead = artist(1, 'Álbum Lead')
const guest = artist(2, 'Guest')
const albums = [
  album(1, 'Album Lead', [
    track(1, lead.id, lead.name),
    track(2, guest.id, guest.name),
  ], 'cover-1.jpg'),
  album(2, 'Compilation Curator', [
    track(3, guest.id, guest.name),
  ], 'cover-2.jpg'),
]

test('album mode creates artists only from album credits and includes complete albums', () => {
  const result = buildDisplayedArtists([lead, guest], albums, 'album')

  assert.deepEqual(result.map(item => item.name), ['Álbum Lead', 'Compilation Curator'])
  assert.equal(result[0].id, lead.id, 'normalized album credit should reuse the persisted artist')
  assert.equal(result[0].trackCount, 2)
  assert.equal(result[1].id.startsWith('ar-album:'), true)
  assert.equal(result[1].artworkPath, 'cover-2.jpg')
})

test('track mode keeps only each track artist own credited tracks', () => {
  const result = buildDisplayedArtists([lead, guest], albums, 'track')
  const leadResult = result.find(item => item.id === lead.id)
  const guestResult = result.find(item => item.id === guest.id)

  assert.equal(leadResult.trackCount, 1)
  assert.equal(leadResult.albums[0].tracks.length, 1)
  assert.equal(guestResult.trackCount, 2)
  assert.deepEqual(guestResult.albums.map(item => item.id), ['a2', 'a1'])
})

test('combined mode merges album and track credits without duplicating tracks', () => {
  const result = buildDisplayedArtists([lead, guest], albums, 'both')
  const leadResult = result.find(item => item.id === lead.id)
  const guestResult = result.find(item => item.id === guest.id)

  assert.deepEqual(result.map(item => item.name), ['Álbum Lead', 'Guest', 'Compilation Curator'])
  assert.equal(leadResult.trackCount, 2, 'album credit expands the matching album to all its tracks')
  assert.equal(guestResult.trackCount, 2)
  assert.equal(guestResult.albums.length, 2)
})
