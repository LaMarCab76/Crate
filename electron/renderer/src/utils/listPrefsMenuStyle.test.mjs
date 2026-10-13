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

  // The wrap must not create a stacking context (the "Filtro" button scrolls
  // under the floating toolbar); only the open popover is lifted.
  assert.equal(declaration(wrap, 'z-index'), 'auto')
  assert.equal(declaration(menu, 'z-index'), '46')
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
  // Standalone it is the full-width "Orden" row; next to a <select> it
  // collapses back to a centered pill.
  assert.equal(declaration(sortDirectionButton, 'min-width'), '112px')
  assert.equal(declaration(sortDirectionButton, 'justify-content'), 'space-between')
  assert.equal(declaration(inlineSortDirectionButton, 'flex-basis'), '112px')
  assert.equal(declaration(inlineSortDirectionButton, 'justify-content'), 'center')
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

test('list filter popover uses the shared glass surfaces', () => {
  const button = cssBlock('.list-prefs-btn')
  const menu = cssBlock('.list-prefs-menu')
  const toggle = cssBlock('.list-toggle input[type="checkbox"]')

  assert.equal(declaration(button, 'background'), 'var(--gl-tinted-fill)')
  assert.equal(declaration(button, 'backdrop-filter'), 'var(--gl-tinted-filter)')
  assert.equal(declaration(menu, 'background'), 'var(--gl-pop-fill)')
  assert.equal(declaration(menu, 'backdrop-filter'), 'var(--gl-pop-filter)')
  assert.equal(declaration(menu, 'width'), '268px')
  assert.equal(declaration(toggle, 'background'), 'var(--gl-switch-off)')
})

test('list views pick their sort from checked option rows', () => {
  for (const filename of ['LibraryView.tsx', 'AlbumsView.tsx', 'ArtistsView.tsx']) {
    const source = readFileSync(new URL(`../views/${filename}`, import.meta.url), 'utf8')
    assert.match(source, /<ListPrefsOptions\b/, `${filename} should list its sort options in the popover`)
    assert.match(source, /className="list-toggle"/, `${filename} should keep its filter switch`)
  }
})

test('sort option rows behave as one radio group with arrow-key navigation', () => {
  const source = readFileSync(new URL('../components/ListPrefsMenu.tsx', import.meta.url), 'utf8')
  // A popover of mixed form controls is a dialog, not an ARIA menu.
  assert.match(source, /aria-haspopup="dialog"/)
  assert.match(source, /role="dialog"/)
  assert.doesNotMatch(source, /role="menu(itemradio)?"/)
  assert.match(source, /role="radiogroup"/)
  assert.match(source, /role="radio"/)
  // Roving tab stop on the checked row, arrows / Home / End move and select.
  assert.match(source, /tabIndex=\{index === tabStopIndex \? 0 : -1\}/)
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
    assert.match(source, new RegExp(`case '${key}'`))
  }
})

test('playlists use the Songs list header and keep the filter reachable when nothing matches', () => {
  const source = readFileSync(new URL('../views/PlaylistView.tsx', import.meta.url), 'utf8')
  assert.match(source, /className="lib-head"/)
  assert.doesNotMatch(source, /album-hero/)
  assert.match(source, /<ListPrefsOptions\b/)
  assert.match(source, /className="list-empty"/)
  // No early return that drops the header (title + Filtro pill) on an empty filter.
  assert.doesNotMatch(source, /if \(filteredTracks\.length === 0\) \{\s*return/)
})

test('one-line list subtitles only truncate where a tooltip holds the full text', () => {
  assert.doesNotMatch(cssBlock('.lib-head .sub'), /white-space:\s*nowrap/)
  assert.equal(declaration(cssBlock('.lib-head .sub[title]'), 'text-overflow'), 'ellipsis')
})
