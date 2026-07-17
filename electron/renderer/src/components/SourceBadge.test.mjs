import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const componentSource = readFileSync(new URL('./SourceBadge.tsx', import.meta.url), 'utf8')
const albumViewSource = readFileSync(new URL('../views/AlbumView.tsx', import.meta.url), 'utf8')
const albumsViewSource = readFileSync(new URL('../views/AlbumsView.tsx', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8')

test('album detail keeps its source summary without badge chrome', () => {
  assert.match(albumViewSource, /appearance="plain"/)
  assert.match(
    stylesSource,
    /\.source-badge\.plain,[\s\S]*?padding:\s*0;[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;/,
  )
})

test('album covers use one fixed folder or cloud source icon', () => {
  assert.match(albumsViewSource, /appearance="icon"/)
  assert.match(componentSource, /provider === 'onedrive' \? 'cloud' : 'folder'/)
  assert.doesNotMatch(albumsViewSource, /appearance="icon"[\s\S]{0,80}\bcompact\b/)
})
