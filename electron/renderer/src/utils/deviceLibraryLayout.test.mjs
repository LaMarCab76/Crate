import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8')
const source = readFileSync(new URL('../views/DeviceLibraryView.tsx', import.meta.url), 'utf8')

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

test('device library page removes the duplicate identity header', () => {
  const pageMarkup = source.slice(source.indexOf('<div className="device-browser-page">'))

  assert.ok(pageMarkup.includes('className={`device-browser-controls'), 'device library should render compact controls')
  assert.ok(!pageMarkup.includes('className="lib-head"'), 'device library should not render the generic title header')
  assert.ok(!pageMarkup.includes('device?.rootPath ?? deviceId'), 'device library should not repeat the device path')
})

test('device library controls keep subtabs and actions in one compact row', () => {
  const controls = cssBlock('.device-browser-controls')
  const nestedSubtabs = cssBlock('.device-browser-controls .device-subtabs')
  const actions = cssBlock('.device-browser-actions')
  const onlyActions = cssBlock('.device-browser-controls.only-actions')

  assert.equal(declaration(controls, 'display'), 'flex')
  assert.equal(declaration(controls, 'min-height'), '34px')
  assert.equal(declaration(controls, 'border-bottom'), '0.5px solid var(--divider)')
  assert.equal(declaration(nestedSubtabs, 'margin-bottom'), '0')
  assert.equal(declaration(nestedSubtabs, 'border-bottom'), 'none')
  assert.equal(declaration(actions, 'display'), 'flex')
  assert.equal(declaration(actions, 'align-items'), 'center')
  assert.equal(declaration(onlyActions, 'justify-content'), 'flex-end')
})
