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
  assert.equal(declaration(lyrics, 'border-radius'), 'var(--gl-r-panel)')
  assert.doesNotMatch(css, /\.lyrics-side-pane,\s*\.player-bottom-shell\s*\{/, 'The lyrics card follows the theme instead of forced light-on-dark text')
})

test('the player card is theme-aware panel glass', () => {
  const pane = cssBlock('.player-pane')

  assert.equal(declaration(pane, 'background'), 'var(--gl-panel-fill)')
  assert.equal(declaration(pane, 'backdrop-filter'), 'var(--gl-panel-filter)')
  assert.equal(declaration(pane, 'border-radius'), 'var(--gl-r-panel)')
  assert.equal(declaration(pane, 'color'), 'var(--gl-text)')
  assert.doesNotMatch(css, /\.player-pane,\s*\.player-bottom-shell\s*\{/, 'The player card follows the theme instead of forced light-on-dark text')
})

test('player variants inherit the single tint source managed by App', () => {
  for (const source of [bottomPlayerSource, sidePlayerSource]) {
    assert.doesNotMatch(source, /extractDominantColor/)
    assert.doesNotMatch(source, /style=\{\{\s*'--np-tint'/)
  }
})
