import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8')

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

test('search fields inherit the app background instead of fixed elevated panels', () => {
  const root = cssBlock(':root')
  const artworkSearch = cssBlock('.device-artwork-search')
  const artworkSearchActive = cssBlock('.device-artwork-search.is-active')

  assert.match(declaration(root, '--search-field-bg'), /var\(--bg-tint\)/)
  assert.match(declaration(root, '--search-field-bg-active'), /var\(--bg-tint\)/)
  assert.equal(declaration(artworkSearch, 'background'), 'var(--search-field-bg)')
  assert.equal(declaration(artworkSearchActive, 'background'), 'var(--search-field-bg-active)')
})

test('toolbar search is a recessed glass well inside the floating pill', () => {
  const toolbarSearch = cssBlock('.tb-search')

  assert.equal(declaration(toolbarSearch, 'background'), 'var(--gl-well)')
  assert.equal(declaration(toolbarSearch, 'box-shadow'), 'var(--gl-well-shadow)')
  assert.equal(declaration(toolbarSearch, 'border-radius'), '999px')
})
