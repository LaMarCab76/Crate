import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const nowPlayingSource = readFileSync(new URL('../components/NowPlayingFull.tsx', import.meta.url), 'utf8')
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

test('fullscreen spectrum stays below the player volume area and fades at the top', () => {
  const root = cssBlock('.np-full')
  const spectrum = cssBlock('.np-spectrum')
  const spectrumHeight = declaration(root, '--np-spectrum-height')
  const maxPx = Number(spectrumHeight.match(/clamp\([^,]+,[^,]+,\s*(?<max>[0-9.]+)px\)/)?.groups?.max)

  assert.ok(Number.isFinite(maxPx), 'spectrum height clamp max should be parseable')
  assert.ok(maxPx <= 160, 'fullscreen visualizer should stay below the volume rail')
  assert.equal(declaration(spectrum, 'height'), 'var(--np-spectrum-height)')
  assert.doesNotMatch(declaration(spectrum, 'height'), /24vh|260px/)
  assert.match(declaration(spectrum, '-webkit-mask-image'), /transparent\s+100%\)/)
  assert.match(declaration(spectrum, 'mask-image'), /transparent\s+100%\)/)
})

test('fullscreen up-next toast lives in the upper zone', () => {
  const toast = cssBlock('.np-up-next-toast')

  assert.match(declaration(toast, 'top'), /^calc\(80px \+ clamp/)
  assert.equal(declaration(toast, 'bottom'), 'auto')
  assert.match(declaration(toast, 'transform'), /calc\(-100% - 20px\)/)
  assert.ok(nowPlayingSource.includes('<div className="label">A continuación</div>'))
})
