import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const devicesSource = readFileSync(new URL('../views/DevicesView.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8')

test('standalone Devices route uses the shared top chrome dashboard tabs', () => {
  assert.ok(appSource.includes("case 'devices':"), 'App should keep a standalone Devices route')
  assert.ok(appSource.includes('<DevicesView\n            dashboardTab={dashboardTab}'), 'Devices route should receive the lifted dashboard tab')
  assert.ok(appSource.includes("|| view.kind === 'devices'"), 'Top chrome dashboard subtabs should also render for Devices')
  assert.ok(appSource.includes('tabs={DEVICE_DASHBOARD_SUBTABS}'), 'Devices should reuse the dashboard subtab definition')
})

test('DevicesView no longer renders old inline segmented tabs', () => {
  assert.ok(!devicesSource.includes('device-dashboard-tabs'), 'DevicesView should not render the old segmented tab row')
  assert.ok(!devicesSource.includes('onDashboardTabChange'), 'DevicesView should not own tab changes locally')
  assert.ok(!devicesSource.includes('setLocalTab'), 'DevicesView should not keep local tab fallback state')
  assert.ok(!/\.device-dashboard-tabs\b/.test(css), 'Old device dashboard tab CSS should be removed')
})
