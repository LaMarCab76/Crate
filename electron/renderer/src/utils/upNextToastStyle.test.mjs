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

test('up-next toast surfaces use an explicit translucent glass background', () => {
  const root = cssBlock(':root')
  const background = declaration(root, '--up-next-toast-bg')
  const alpha = Number(background.match(/rgba\([^,]+,[^,]+,[^,]+,\s*(?<alpha>[0-9.]+)\)/)?.groups?.alpha)

  assert.equal(background, 'rgba(18, 18, 22, 0.24)')
  assert.ok(Number.isFinite(alpha), 'background alpha must be parseable')
  assert.ok(alpha <= 0.28, 'background must stay visibly translucent')
})

test('up-next toast panels share the translucent token instead of an elevated panel fill', () => {
  for (const selector of ['.up-next-inline-row']) {
    const block = cssBlock(selector)
    assert.equal(declaration(block, 'background'), 'var(--up-next-toast-bg)')
    assert.equal(declaration(block, 'border'), '0.5px solid var(--up-next-toast-border)')
    assert.doesNotMatch(block, /var\(--bg-elev\)/)
    assert.doesNotMatch(block, /color-mix\(in\s+oklab,\s*var\(--bg-elev\)/)
  }
})

test('bottom up-next toast floats over the island as the same translucent island glass', () => {
  const block = cssBlock('.up-next-toast')
  assert.equal(declaration(block, 'background'), 'var(--gl-island-fill)')
  assert.equal(declaration(block, 'backdrop-filter'), 'var(--gl-island-filter)')
  assert.equal(declaration(block, 'box-shadow'), 'var(--gl-island-shadow)')
  assert.doesNotMatch(block, /var\(--bg-elev\)/)
})
