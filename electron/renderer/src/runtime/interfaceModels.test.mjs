import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interfaceTrack, interfacePage, interfaceNumber, interfaceParams } from './interfaceModels.ts'
import { resolveRoute, viewRoute } from './navigation.ts'

test('interface models omit private file paths and provider data', () => {
  const dto = interfaceTrack({ id: 't1', dbId: 1, t: 'Song', d: 60, artist: 'Artist', albumTitle: 'Album', albumId: 'a1', fmt: 'FLAC', q: '24/96', loved: false, path: '/private/music/file', token: 'private-token', artworkPath: 'cover.jpg' })
  assert.equal(dto.title, 'Song')
  assert.equal(dto.id, 1)
  assert.equal(dto.artworkUrl, 'crate://artwork/cover.jpg')
  assert.ok(!JSON.stringify(dto).includes('/private'))
  assert.ok(!JSON.stringify(dto).includes('private-token'))
})

test('SDK pages are bounded and reject malformed arguments', () => {
  assert.deepEqual(interfacePage([1, 2, 3, 4], { offset: 1, limit: 2 }), { items: [2, 3], total: 4, offset: 1, limit: 2 })
  for (const params of [{ limit: 501 }, { limit: 0 }, { offset: -1 }, { offset: 0.5 }, { limit: '10' }]) assert.throws(() => interfacePage([], params))
  assert.throws(() => interfaceParams([]))
  assert.throws(() => interfaceNumber(NaN, 'volume', 0, 1))
})

test('canonical routes resolve current entities and reject removed entities', () => {
  const album = { id: 'a1' }
  const library = { albums: [album], artists: [], playlists: [] }
  assert.equal(resolveRoute('album:1', library).album, album)
  assert.equal(viewRoute({ kind: 'album', album }), 'album:a1')
  assert.throws(() => resolveRoute('album:removed', library))
  assert.throws(() => resolveRoute('device:123:unknown', library))
  assert.throws(() => resolveRoute('javascript:evil', library))
})
