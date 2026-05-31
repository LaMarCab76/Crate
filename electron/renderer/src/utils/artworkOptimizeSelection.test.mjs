import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  filterArtworkItemsForSearch,
  groupArtworkItems,
  selectedArtworkItemsFromGroup,
  selectedArtworkItemsForSearch,
  shouldShowArtworkSearchResults,
} from './artworkOptimizeSelection.ts'

function item(patch) {
  return {
    key: patch.key,
    relativePath: patch.relativePath,
    title: patch.title,
    artist: patch.artist,
    album: patch.album ?? 'Album',
    format: 'jpeg',
    width: patch.width ?? 1200,
    height: patch.height ?? 1200,
    status: 'oversized',
  }
}

const items = [
  item({
    key: 'charly/clics modernos/nos siguen pegando abajo.mp3',
    relativePath: 'Charly Garcia/Clics modernos/Nos siguen pegando abajo.mp3',
    title: 'Nos siguen pegando abajo',
    artist: 'Charly García',
    album: 'Clics modernos',
  }),
  item({
    key: 'soda stereo/signos/persiana americana.mp3',
    relativePath: 'Soda Stereo/Signos/Persiana Americana.mp3',
    title: 'Persiana Americana',
    artist: 'Soda Stereo',
    album: 'Signos',
  }),
  item({
    key: 'virus/superficies de placer/pronta entrega.mp3',
    relativePath: 'Virus/Superficies de placer/Pronta entrega.mp3',
    title: 'Pronta entrega',
    artist: 'Virus',
    album: 'Superficies de placer',
  }),
  item({
    key: 'virus/locura/pronta entrega.mp3',
    relativePath: 'Virus/Locura/Pronta entrega.mp3',
    title: 'Pronta entrega',
    artist: 'Virus',
    album: 'Locura',
    width: 1600,
    height: 1200,
  }),
]

test('empty artwork search selects no items', () => {
  const selected = selectedArtworkItemsForSearch({
    items,
    query: '',
    scope: 'all',
    excludedKeys: new Set(),
  })

  assert.equal(selected.length, 0)
})

test('artist search selects only matching artists', () => {
  const selected = selectedArtworkItemsForSearch({
    items,
    query: 'soda',
    scope: 'artist',
    excludedKeys: new Set(),
  })

  assert.deepEqual(selected.map(item => item.key), ['soda stereo/signos/persiana americana.mp3'])
})

test('track search selects title album or path matches', () => {
  const selected = selectedArtworkItemsForSearch({
    items,
    query: 'signos',
    scope: 'tracks',
    excludedKeys: new Set(),
  })

  assert.deepEqual(selected.map(item => item.key), ['soda stereo/signos/persiana americana.mp3'])
})

test('manual exclusions remove an auto-selected artwork result', () => {
  const selected = selectedArtworkItemsForSearch({
    items,
    query: 's',
    scope: 'all',
    excludedKeys: new Set(['soda stereo/signos/persiana americana.mp3']),
  })

  assert.deepEqual(
    selected.map(item => item.key),
    [
      'charly/clics modernos/nos siguen pegando abajo.mp3',
      'virus/superficies de placer/pronta entrega.mp3',
      'virus/locura/pronta entrega.mp3',
    ],
  )
})

test('artwork search ignores case and accents', () => {
  const visible = filterArtworkItemsForSearch(items, 'garcia', 'all')

  assert.deepEqual(visible.map(item => item.key), ['charly/clics modernos/nos siguen pegando abajo.mp3'])
})

test('empty artwork search uses grouped artist view', () => {
  assert.equal(shouldShowArtworkSearchResults(''), false)
  const groups = groupArtworkItems(items, 'artist')
  const virus = groups.find(group => group.title === 'Virus')

  assert.equal(virus?.itemCount, 2)
  assert.equal(virus?.subtitle, '2 álbumes')
  assert.equal(virus?.maxWidth, 1600)
  assert.equal(virus?.maxHeight, 1200)
})

test('selected artwork group selects its tracks and honors exclusions', () => {
  const groups = groupArtworkItems(items, 'artist')
  const virus = groups.find(group => group.title === 'Virus')

  const selected = selectedArtworkItemsFromGroup(
    virus,
    new Set(['virus/locura/pronta entrega.mp3']),
  )

  assert.deepEqual(selected.map(item => item.key), [
    'virus/superficies de placer/pronta entrega.mp3',
  ])
  assert.deepEqual(selectedArtworkItemsFromGroup(null, new Set()), [])
})

test('album artwork view separates same album names by artist', () => {
  const albumItems = [
    item({
      key: 'artist one/greatest hits/one.mp3',
      relativePath: 'Artist One/Greatest Hits/One.mp3',
      title: 'One',
      artist: 'Artist One',
      album: 'Greatest Hits',
    }),
    item({
      key: 'artist two/greatest hits/two.mp3',
      relativePath: 'Artist Two/Greatest Hits/Two.mp3',
      title: 'Two',
      artist: 'Artist Two',
      album: 'Greatest Hits',
    }),
  ]

  const groups = groupArtworkItems(albumItems, 'album')

  assert.deepEqual(groups.map(group => `${group.title}:${group.subtitle}`), [
    'Greatest Hits:Artist One',
    'Greatest Hits:Artist Two',
  ])
})

test('active artwork search returns flat results instead of grouped view', () => {
  assert.equal(shouldShowArtworkSearchResults('pronta'), true)
  const visible = filterArtworkItemsForSearch(items, 'pronta', 'all')

  assert.deepEqual(visible.map(item => item.key), [
    'virus/superficies de placer/pronta entrega.mp3',
    'virus/locura/pronta entrega.mp3',
  ])
})
