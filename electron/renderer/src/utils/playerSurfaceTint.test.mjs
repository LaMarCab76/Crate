import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const bottomPlayerSource = readFileSync(new URL('../components/PlayerBottomBar.tsx', import.meta.url), 'utf8')
const sidePlayerSource = readFileSync(new URL('../components/PlayerPane.tsx', import.meta.url), 'utf8')

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`))
  assert.ok(match?.groups?.body, `Missing CSS block for ${selector}`)
  return match.groups.body
}

function declaration(block, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = block.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:\\s*(?<value>[^;]+);`))
  assert.ok(match?.groups?.value, `Missing ${property} declaration`)
  return match.groups.value.trim()
}

test('the global palette surface stays derived from the artwork palette', () => {
  const root = cssBlock(':root')
  const surface = declaration(root, '--np-player-surface-background')

  assert.match(surface, /--np-pal-0/)
  assert.doesNotMatch(surface, /--bg-panel/)
})

test('the bottom island is theme-aware glass tinted by the playing track', () => {
  const island = cssBlock('.pb-island')

  // The island glass mixes in --gl-nt (the playing track's tint, set by App)
  // instead of painting its own animated blob canvas.
  assert.match(css, /--gl-island-fill:[^;]*var\(--gl-nt\)/)
  assert.equal(declaration(island, 'background'), 'var(--gl-island-fill)')
  assert.equal(declaration(island, 'backdrop-filter'), 'var(--gl-island-filter)')
  assert.equal(declaration(island, 'box-shadow'), 'var(--gl-island-shadow)')
  assert.equal(declaration(island, 'color'), 'var(--gl-text)')
  assert.doesNotMatch(bottomPlayerSource, /np-bg-blob|pane-bg-canvas|pane-bg-scrim/)
})

test('the right dock is a transparent, click-through holder for glass cards', () => {
  const dock = cssBlock('.np-dock-lateral')
  const lyrics = cssBlock('.lyrics-side-pane')

  assert.equal(declaration(dock, 'position'), 'absolute')
  assert.equal(declaration(dock, 'pointer-events'), 'none')
  assert.doesNotMatch(dock, /(?:^|\n)\s*background\s*:/, 'The dock should not paint its own backdrop')
  assert.equal(declaration(lyrics, 'background'), 'var(--gl-panel-fill)')
  assert.equal(declaration(lyrics, 'border-radius'), 'var(--gl-r-panel) 0 0 var(--gl-r-panel)')
  assert.doesNotMatch(css, /\.lyrics-side-pane,\s*\.player-bottom-shell\s*\{/, 'The lyrics card follows the theme instead of forced light-on-dark text')
})

test('the player card is theme-aware panel glass', () => {
  const pane = cssBlock('.player-pane')

  assert.equal(declaration(pane, 'background'), 'var(--gl-panel-fill)')
  assert.equal(declaration(pane, 'backdrop-filter'), 'var(--gl-panel-filter)')
  assert.equal(declaration(pane, 'border-radius'), 'var(--gl-r-panel) 0 0 var(--gl-r-panel)')
  assert.equal(declaration(pane, 'color'), 'var(--gl-text)')
  assert.doesNotMatch(css, /\.player-pane,\s*\.player-bottom-shell\s*\{/, 'The player card follows the theme instead of forced light-on-dark text')
})

test('player variants inherit the single tint source managed by App', () => {
  for (const source of [bottomPlayerSource, sidePlayerSource]) {
    assert.doesNotMatch(source, /extractDominantColor/)
    assert.doesNotMatch(source, /style=\{\{\s*'--np-tint'/)
  }
})

test('the dock and the island are pinned to the window edges like the sidebar', () => {
  const dock = cssBlock('.np-dock-lateral')
  // Anchored at a line start: the first `.player-dock {` closes a selector list.
  const playerDock = css.match(/\n\.player-dock\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? ''
  const island = cssBlock('.pb-island')

  assert.match(dock, /top:\s*0;\s*right:\s*0;\s*bottom:\s*0;/)
  assert.equal(declaration(playerDock, 'bottom'), '0')
  assert.equal(declaration(island, 'border-radius'), 'var(--gl-r-panel) var(--gl-r-panel) 0 0')
})

test('edge panels never blur: a partial redraw would read back their own pixels', () => {
  assert.equal(css.match(/--gl-panel-filter:\s*(?<value>[^;]+);/)?.groups?.value, 'saturate(160%)')
  for (const selector of ['.sidebar', '.player-pane', '.lyrics-side-pane']) {
    assert.equal(declaration(cssBlock(selector), 'backdrop-filter'), 'var(--gl-panel-filter)', selector)
  }
})

test('with the lyrics card open the player card squares every inner corner', () => {
  // Rounded header/footer bands at the seam would read as a second card.
  const seam = css.match(/(?<selectors>[^{}]*)\{\s*border-radius:\s*0;\s*\}/g)?.find(rule => rule.includes('.window.gl-lyrics-open .player-pane')) ?? ''
  for (const selector of ['.player-pane,', '.player-pane .pp-header,', '.player-pane .pp-footer {']) {
    assert.ok(seam.includes(`.window.gl-lyrics-open ${selector}`), selector)
  }
})

test('the now-playing row is the banner glass box in every listing', () => {
  const row = cssBlock('.tbl tbody tr.playing')
  const banner = cssBlock('.metadata-import-banner')

  assert.equal(declaration(row, 'background-color'), 'var(--gl-current-fill)')
  assert.equal(declaration(row, 'box-shadow'), 'var(--gl-current-shadow)')
  assert.equal(css.match(/--gl-current-fill:\s*var\(--gl-panel-fill\);/g)?.length, 2, 'Both themes')
  assert.equal(css.match(/--gl-current-shadow:\s*var\(--gl-panel-shadow\);/g)?.length, 2, 'Both themes')
  assert.equal(declaration(banner, 'background'), 'var(--gl-panel-fill)')
  assert.equal(declaration(banner, 'box-shadow'), 'var(--gl-panel-shadow)')
  assert.doesNotMatch(css, /\.artist-album[^{]*tr\.playing[^{]*\{/, 'Album sections reuse the shared box')
})

test('the visualizer/lyrics divider fades out once the lyrics open', () => {
  assert.equal(declaration(cssBlock('.pp-acc + .pp-acc'), 'border-top'), '0.5px solid var(--gl-hairline)')
  assert.equal(declaration(cssBlock('.pp-acc + .pp-acc.open'), 'border-top-color'), 'transparent')
})

test('artist page albums are neutral glass cards, never tinted', () => {
  const artistSource = readFileSync(new URL('../views/ArtistView.tsx', import.meta.url), 'utf8')
  const section = cssBlock('.artist-album')

  assert.equal(declaration(section, 'background'), 'var(--gl-panel-fill)')
  assert.equal(declaration(section, 'box-shadow'), 'var(--gl-panel-shadow)')
  assert.equal(declaration(section, 'border-radius'), 'var(--gl-r-panel)')
  assert.doesNotMatch(cssBlock('.aa-head'), /(?:^|\n)\s*background\s*:/, 'No tinted album head')
  // Rows, the column header and the now-playing box come from the shared .tbl rules.
  assert.doesNotMatch(css, /\.artist-album[^{]*(?:thead|tbody)[^{]*\{/)
  assert.doesNotMatch(css, /--artist-album-tint|--gl-nw/)
  assert.doesNotMatch(artistSource, /--artist-album-tint|extractDominantColor/)
})

test('the artist view toggle is the glass segmented control', () => {
  // Anchored: `.artist-view-controls .view-toggle {` comes first in the file.
  const track = css.match(/\n\.view-toggle\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? ''
  const thumb = cssBlock('.view-toggle-thumb')

  assert.equal(declaration(track, 'background'), 'var(--gl-seg-track)')
  assert.equal(declaration(track, 'border-radius'), '999px')
  assert.equal(declaration(thumb, 'background'), 'var(--gl-seg-thumb)')
  assert.equal(declaration(cssBlock('.view-toggle.on-second .view-toggle-thumb'), 'transform'), 'translateX(100%)')
})
