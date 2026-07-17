import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`))
  assert.ok(match?.groups?.body, `Missing CSS block for ${selector}`)
  return match.groups.body
}

function declaration(block, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = block.match(new RegExp(`${escaped}\\s*:\\s*(?<value>[^;]+);`))
  assert.ok(match?.groups?.value, `Missing ${property} declaration`)
  return match.groups.value.trim()
}

test('list prefs menus keep filter controls inside the popover', () => {
  const wrap = cssBlock('.list-prefs-wrap')
  const menu = cssBlock('.list-prefs-menu')
  const content = cssBlock('.list-prefs-content')
  const row = cssBlock('.list-prefs-row')
  const inline = cssBlock('.list-prefs-row-inline')
  const inlineInputs = cssBlock('.list-prefs-menu .list-prefs-row-inline > .list-input,\n.list-prefs-menu .list-prefs-row-inline > .list-select')
  const smallInput = cssBlock('.list-prefs-menu .list-prefs-row-inline > .list-input--small')
  const button = cssBlock('.list-prefs-menu .list-prefs-row-inline > .btn')
  const sortDirectionButton = cssBlock('.list-sort-dir-btn')
  const inlineSortDirectionButton = cssBlock('.list-prefs-menu .list-prefs-row-inline > .list-sort-dir-btn')
  const toggle = cssBlock('.list-prefs-menu .list-prefs-row-inline > .list-toggle')

  assert.equal(declaration(wrap, 'z-index'), '30')
  assert.equal(declaration(menu, 'overflow'), 'hidden')
  assert.equal(declaration(content, 'min-width'), '0')
  assert.equal(declaration(row, 'min-width'), '0')
  assert.equal(declaration(inline, 'width'), '100%')
  assert.equal(declaration(inline, 'min-width'), '0')
  assert.equal(declaration(inline, 'flex-wrap'), 'wrap')
  assert.equal(declaration(inlineInputs, 'flex'), '1 1 140px')
  assert.equal(declaration(inlineInputs, 'width'), 'auto')
  assert.equal(declaration(inlineInputs, 'min-width'), '0')
  assert.equal(declaration(smallInput, 'flex-basis'), 'calc(50% - 4px)')
  assert.equal(declaration(button, 'flex'), '0 0 auto')
  assert.equal(declaration(sortDirectionButton, 'min-width'), '112px')
  assert.equal(declaration(sortDirectionButton, 'justify-content'), 'center')
  assert.equal(declaration(inlineSortDirectionButton, 'flex-basis'), '112px')
  assert.equal(declaration(toggle, 'max-width'), '100%')
})

test('artist detail filter popover can escape the hero stack', () => {
  const artistHero = cssBlock('.artist-hero')

  assert.equal(declaration(artistHero, 'z-index'), '2')
  assert.equal(declaration(artistHero, 'overflow'), 'visible')
})

test('sortable filter views render the shared direction button', () => {
  const expectedUses = new Map([
    ['AlbumsView.tsx', 1],
    ['ArtistsView.tsx', 1],
    ['GenresView.tsx', 2],
    ['LibraryView.tsx', 1],
    ['PlaylistView.tsx', 1],
    ['ArtistView.tsx', 2],
  ])

  for (const [filename, expectedCount] of expectedUses) {
    const source = readFileSync(new URL(`../views/${filename}`, import.meta.url), 'utf8')
    const count = source.match(/<SortDirectionButton\b/g)?.length ?? 0
    assert.equal(count, expectedCount, `${filename} should render ${expectedCount} SortDirectionButton control(s)`)
  }
})
