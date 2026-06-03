import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const eqGraphSource = readFileSync(new URL('../components/EqGraph.tsx', import.meta.url), 'utf8')
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

test('equalizer slider thumbs stay visible without covering the spectrum with tracks', () => {
  const bands = cssBlock('.eq-unified-bands')
  const range = cssBlock('.eq-unified .eq-band input[type="range"]')
  const webkitTrack = cssBlock('.eq-unified .eq-band input[type="range"]::-webkit-slider-runnable-track')
  const webkitThumb = cssBlock('.eq-unified .eq-band input[type="range"]::-webkit-slider-thumb')
  const mozTrack = cssBlock('.eq-unified .eq-band input[type="range"]::-moz-range-track')
  const mozThumb = cssBlock('.eq-unified .eq-band input[type="range"]::-moz-range-thumb')

  assert.equal(declaration(bands, 'opacity'), '1')
  assert.equal(declaration(range, 'background'), 'transparent')
  assert.equal(declaration(range, 'appearance'), 'none')
  assert.equal(declaration(range, '-webkit-appearance'), 'none')
  assert.equal(declaration(webkitTrack, 'background'), 'transparent')
  assert.equal(declaration(mozTrack, 'background'), 'transparent')
  assert.equal(declaration(webkitThumb, 'border-radius'), '999px')
  assert.equal(declaration(mozThumb, 'border-radius'), '999px')
  assert.equal(declaration(webkitThumb, 'background'), 'var(--eq-slider-thumb)')
  assert.equal(declaration(mozThumb, 'background'), 'var(--eq-slider-thumb)')
})

test('equalizer spectrum darkens only during pointer drag', () => {
  const scrim = cssBlock('.eq-unified.interacting .eq-unified-scrim')
  const curve = cssBlock('.eq-unified.interacting .eq-unified-curve')

  assert.equal(declaration(scrim, 'opacity'), '1')
  assert.equal(declaration(curve, 'opacity'), '0.62')
  assert.ok(eqGraphSource.includes("interacting ? ' interacting' : ''"), 'EqGraph should expose the drag state class')
  assert.ok(eqGraphSource.includes('onPointerDown={() => setInteracting(true)}'), 'Drag state should start on pointer down')
  assert.ok(!/:hover\s+\.eq-unified-scrim/.test(css), 'Hovering the EQ should not darken the spectrum')
  assert.ok(!/:focus-within\s+\.eq-unified-scrim/.test(css), 'Keyboard focus should not darken the spectrum')
  assert.ok(!eqGraphSource.includes('slider-vertical'), 'Native slider-vertical appearance would repaint the track')
})

test('equalizer shows a live dB readout while dragging a band', () => {
  assert.ok(eqGraphSource.includes('setActive({ index: i, gain: value })'),
    'onChange should track the active band for the readout')
  assert.ok(eqGraphSource.includes('eq-unified-readout'),
    'EqGraph should render the live dB readout')
  assert.ok(/\.toFixed\(1\)\} dB/.test(eqGraphSource),
    'Readout should format the active gain in dB')
  const readout = cssBlock('.eq-unified-readout')
  assert.ok(/font-variant-numeric:\s*tabular-nums/.test(readout),
    'Readout digits should be tabular')
})

test('equalizer idle hint stays clear of the neutral slider row', () => {
  const hint = cssBlock('.eq-unified-hint')

  assert.match(hint, /align-items:\s*flex-start/, 'Idle hint should sit above the 0 dB thumb row')
  assert.match(hint, /padding:\s*34px 16px 0/, 'Idle hint should have explicit top spacing')
})
