import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const componentSource = readFileSync(new URL('./SourceBadge.tsx', import.meta.url), 'utf8')
const albumViewSource = readFileSync(new URL('../views/AlbumView.tsx', import.meta.url), 'utf8')
const artistViewSource = readFileSync(new URL('../views/ArtistView.tsx', import.meta.url), 'utf8')
const albumsViewSource = readFileSync(new URL('../views/AlbumsView.tsx', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8')

test('album detail keeps its source inline with the credits and without badge chrome', () => {
  assert.match(albumViewSource, /appearance="plain"/)
  assert.match(albumViewSource, /className="credits"[\s\S]*?album-credit-separator[\s\S]*?SourceBadge/)
  assert.doesNotMatch(albumViewSource, /album-source-summary/)
  assert.match(
    stylesSource,
    /\.source-badge\.plain,[\s\S]*?padding:\s*0;[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;/,
  )
})

test('artist detail does not expose library locations', () => {
  assert.doesNotMatch(artistViewSource, /SourceBadge/)
  assert.match(artistViewSource, /showSource=\{false\}/)
})

test('album covers use one fixed folder or cloud source icon', () => {
  assert.match(albumsViewSource, /appearance="icon"/)
  assert.match(componentSource, /provider === 'onedrive' \? 'cloud' : 'folder'/)
  assert.doesNotMatch(albumsViewSource, /appearance="icon"[\s\S]{0,80}\bcompact\b/)
})
