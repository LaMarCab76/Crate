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

test('horizontal and side players share the global palette surface', () => {
  const root = cssBlock(':root')
  const bottom = cssBlock('.player-bottom-shell')
  const side = cssBlock('.np-dock-lateral')
  const surface = declaration(root, '--np-player-surface-background')

  assert.match(surface, /--np-pal-0/)
  assert.doesNotMatch(surface, /--bg-panel/)
  assert.equal(declaration(bottom, 'background'), 'var(--np-player-surface-background)')
  assert.equal(declaration(side, 'background'), 'var(--np-player-surface-background)')
  assert.match(css, /\.player-pane,\s*\.lyrics-side-pane,\s*\.player-bottom-shell\s*\{/)
  assert.equal((bottomPlayerSource.match(/np-bg-blob np-bg-blob-/g) ?? []).length, 4)
  assert.match(bottomPlayerSource, /className="pane-bg-scrim"/)
})

test('player variants inherit the single tint source managed by App', () => {
  for (const source of [bottomPlayerSource, sidePlayerSource]) {
    assert.doesNotMatch(source, /extractDominantColor/)
    assert.doesNotMatch(source, /style=\{\{\s*'--np-tint'/)
  }
})
