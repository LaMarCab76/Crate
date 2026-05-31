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

test('device sync setup occupies one third beside the tabbed stage', () => {
  const dashboardPage = cssBlock('.device-dashboard-page,\n.device-sync-page')
  const syncShell = cssBlock('.device-sync-shell')
  const controlCard = cssBlock('.device-sync-control-card')

  assert.equal(declaration(dashboardPage, 'padding'), '0 24px 28px')
  assert.equal(declaration(syncShell, 'grid-template-columns'), 'minmax(300px, 0.5fr) minmax(0, 1fr)')
  assert.equal(declaration(syncShell, 'gap'), '22px')
  assert.equal(declaration(controlCard, 'grid-column'), 'auto')
  assert.equal(declaration(controlCard, 'padding'), '18px')
})

test('device sync direction modes and source libraries stay compact', () => {
  const modes = cssBlock('.device-flow-modes')
  const mode = cssBlock('.device-flow-mode')
  const libraries = cssBlock('.device-source-library-grid')
  const libraryRow = cssBlock('.device-source-library-grid .device-source-library-row')

  assert.equal(declaration(modes, 'min-width'), '0')
  assert.equal(declaration(modes, 'grid-template-columns'), 'repeat(3, minmax(0, 1fr))')
  assert.equal(declaration(mode, 'width'), '100%')
  assert.equal(declaration(mode, 'min-width'), '0')
  assert.equal(declaration(mode, 'min-height'), '46px')
  assert.equal(declaration(libraries, 'grid-template-columns'), 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))')
  assert.equal(declaration(libraries, 'gap'), '10px')
  assert.equal(declaration(libraryRow, 'min-height'), '52px')
  assert.equal(declaration(libraryRow, 'padding'), '8px 10px')
})

test('refactored sync controls (base selector, section tabs, destination) are styled', () => {
  const root = cssBlock(':root')
  const base = cssBlock('.device-plan-base-options')
  const sectionTabs = cssBlock('.device-section-tabs')
  const sectionSubtabs = cssBlock('.device-section-subtabs')
  const subtabs = cssBlock('.device-subtabs')
  const sectionTab = cssBlock('.device-section-tab')
  const select = cssBlock('.device-select')

  assert.equal(declaration(base, 'display'), 'inline-flex')
  // Primary device tabs and dashboard/sync navbar sub-tabs share height and the
  // same underlined .device-section-tab look.
  assert.equal(declaration(root, '--device-nav-row-height'), '38px')
  assert.equal(declaration(sectionTabs, 'display'), 'flex')
  assert.equal(declaration(sectionTabs, 'height'), 'var(--device-nav-row-height)')
  assert.equal(declaration(sectionSubtabs, 'height'), 'var(--device-nav-row-height)')
  // In-view Biblioteca/grouping sub-tabs keep their compact strip styling.
  assert.equal(declaration(subtabs, 'display'), 'flex')
  assert.equal(declaration(sectionTab, 'border-bottom'), '2px solid transparent')
  assert.equal(declaration(select, 'width'), '100%')

  // The removed setup chrome must not linger in the stylesheet.
  assert.ok(!/\.device-sync-animation\s*\{/.test(css), 'device-sync-animation CSS should be removed')
  assert.ok(!/\.device-sync-tabs\s*\{/.test(css), 'device-sync-tabs CSS should be removed')
  assert.ok(!/\.device-lib-view-switch\s*\{/.test(css), 'device-lib-view-switch CSS should be removed')
})

test('sync wizard stepper, two columns and per-track side toggle are styled', () => {
  const steps = cssBlock('.device-sync-steps')
  const step = cssBlock('.device-sync-step')
  const columns = cssBlock('.device-sync-columns')
  const toggle = cssBlock('.device-side-toggle')

  assert.equal(declaration(steps, 'display'), 'flex')
  // The active step underlines like the section tabs.
  assert.equal(declaration(step, 'border-bottom'), '2px solid transparent')
  // Vista 1 / Vista 2 are always two side-by-side columns (PC | MP3).
  assert.equal(declaration(columns, 'display'), 'grid')
  assert.equal(declaration(columns, 'grid-template-columns'), 'repeat(2, minmax(0, 1fr))')
  assert.equal(declaration(toggle, 'display'), 'inline-flex')
})
