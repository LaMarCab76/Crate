import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const pickerSource = readFileSync(new URL('./ArtistArtworkPicker.tsx', import.meta.url), 'utf8')
const artistViewSource = readFileSync(new URL('../views/ArtistView.tsx', import.meta.url), 'utf8')
const adapterSource = readFileSync(new URL('../stores/adapters.ts', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('../../../preload/index.ts', import.meta.url), 'utf8')
const channelSource = readFileSync(new URL('../../../main/ipc/library-channel.ts', import.meta.url), 'utf8')

test('artist view exposes a modal artwork editor outside the primary metadata', () => {
  assert.match(artistViewSource, /className="artist-artwork-edit"/)
  assert.match(artistViewSource, /<ArtistArtworkPicker artist=\{ar\}/)
  assert.match(artistViewSource, /className="artist-view-controls"[\s\S]*?Discografía[\s\S]*?Álbumes/)
})

test('artwork picker supports album covers, custom uploads and automatic reset', () => {
  assert.match(pickerSource, /setArtistArtworkFromAlbum/)
  assert.match(pickerSource, /pickArtistArtwork/)
  assert.match(pickerSource, /resetArtistArtwork/)
  assert.match(pickerSource, /Portadas de álbumes/)
  assert.match(pickerSource, /Cargar una imagen/)
})

test('artist artwork is persisted through trusted IPC and preferred by the UI adapter', () => {
  assert.match(preloadSource, /artist:setArtworkFromAlbum/)
  assert.match(preloadSource, /artist:pickArtwork/)
  assert.match(preloadSource, /artist:resetArtwork/)
  assert.match(channelSource, /belongsToArtist/)
  assert.match(channelSource, /basename\(artworkPath\) !== artworkPath/)
  assert.match(adapterSource, /artworkPath: ar\.artwork_path \?\? latestArt/)
})
