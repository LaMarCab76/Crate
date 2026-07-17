import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const source = readFileSync(new URL('../views/DeviceLibraryView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`))
  assert.ok(match?.groups?.body, `Missing CSS block for ${selector}`)
  return match.groups.body
}

function cssBlockAfter(marker, selector) {
  const start = css.indexOf(marker)
  assert.ok(start >= 0, `Missing marker ${marker}`)
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.slice(start).match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`))
  assert.ok(match?.groups?.body, `Missing CSS block for ${selector} after ${marker}`)
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

test('rockbox themes use an internal overview and compact drop surface', () => {
  const rockboxSource = source.slice(source.indexOf('function RockboxThemeOverview'))

  assert.ok(rockboxSource.includes('className={`device-theme-overview ${state}`}'), 'Rockbox overview should expose stateful styling')
  assert.ok(rockboxSource.includes('device-theme-overview-actions'), 'Rockbox overview should own refresh/import actions')
  assert.ok(rockboxSource.includes('<RockboxThemeDropzone dragOver={dragOver} />'), 'Rockbox section should render the compact dropzone')
  assert.ok(rockboxSource.includes('<RockboxThemeEmptyState scan={rockboxThemeLibrary.scan} />'), 'Rockbox empty state should be themed')
  assert.ok(source.includes('{!isRockboxSection && ('), 'Rockbox should not duplicate the generic browser action row')
})

test('rockbox theme cards expose preview, status, metrics and file pills', () => {
  const cardSource = source.slice(source.indexOf('function RockboxThemeCard'), source.indexOf('function RockboxThemeDropzone'))

  assert.ok(cardSource.includes('<RockboxThemeMiniPreview'), 'Theme card should keep the SVG preview prominent')
  assert.ok(cardSource.includes('device-theme-card-controls'), 'Theme card should group status and delete action')
  assert.ok(cardSource.includes('device-theme-card-metrics'), 'Theme card should show comparable metadata')
  assert.ok(cardSource.includes('theme.preview.layers.length'), 'Theme card should surface parsed layer count')
  assert.ok(cardSource.includes('device-theme-file-grid'), 'Theme card should keep file pills visible')
  assert.ok(cardSource.includes('title={theme.configPath}'), 'Theme config path should have a tooltip when truncated')
})

test('rockbox theme layout keeps stable desktop dimensions', () => {
  const overview = cssBlock('.device-theme-overview')
  const stats = cssBlock('.device-theme-overview-stats')
  const grid = cssBlock('.device-theme-grid')
  const card = cssBlock('.device-theme-card')
  const screen = cssBlock('.device-theme-screen-frame')
  const metrics = cssBlock('.device-theme-card-metrics')
  const fileGrid = cssBlock('.device-theme-file-grid')

  assert.equal(declaration(overview, 'display'), 'grid')
  assert.equal(declaration(overview, 'min-height'), '86px')
  assert.equal(declaration(stats, 'grid-template-columns'), 'repeat(4, minmax(72px, 1fr))')
  assert.equal(declaration(grid, 'grid-template-columns'), 'repeat(auto-fill, minmax(min(360px, 100%), 1fr))')
  assert.equal(declaration(card, 'grid-template-rows'), 'auto minmax(0, 1fr)')
  assert.equal(declaration(card, 'border-radius'), '8px')
  assert.equal(declaration(screen, 'aspect-ratio'), '4 / 3')
  assert.equal(declaration(screen, 'padding'), '10px')
  assert.equal(declaration(metrics, 'grid-template-columns'), 'repeat(3, minmax(0, 1fr))')
  assert.equal(declaration(fileGrid, 'grid-template-columns'), 'repeat(3, minmax(0, 1fr))')
})

test('rockbox theme status badges keep light-mode contrast', () => {
  const ok = cssBlock('.theme-light .device-theme-card-head b.ok')
  const warning = cssBlock('.theme-light .device-theme-card-head b.warning')
  const scanWarning = cssBlock('.theme-light .device-theme-scan.warning,\n.theme-light .device-theme-missing-list code')

  assert.equal(declaration(ok, 'color'), '#147a3f')
  assert.equal(declaration(warning, 'color'), '#825f00')
  assert.equal(declaration(scanWarning, 'color'), '#825f00')
})

test('rockbox theme mobile fallback collapses without horizontal overflow', () => {
  const marker = '@media (max-width: 900px)'
  const overview = cssBlockAfter(marker, '.device-theme-overview')
  const stats = cssBlockAfter(marker, '.device-theme-overview-stats')
  const cardHead = cssBlockAfter(marker, '.device-theme-card-head')
  const fileGrid = cssBlockAfter(marker, '.device-theme-file-grid')
  const empty = cssBlockAfter(marker, '.device-theme-empty')

  assert.equal(declaration(overview, 'grid-template-columns'), '1fr')
  assert.equal(declaration(stats, 'grid-template-columns'), 'repeat(2, minmax(0, 1fr))')
  assert.equal(declaration(cardHead, 'grid-template-columns'), '1fr')
  assert.equal(declaration(fileGrid, 'grid-template-columns'), '1fr')
  assert.equal(declaration(empty, 'grid-template-columns'), '1fr')
})
