import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const devicesSource = readFileSync(new URL('../views/DevicesView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('standalone Devices route uses the shared top chrome dashboard tabs', () => {
  assert.ok(appSource.includes("case 'devices':"), 'App should keep a standalone Devices route')
  assert.ok(appSource.includes('<DevicesView\n            dashboardTab={dashboardTab}'), 'Devices route should receive the lifted dashboard tab')
  assert.ok(appSource.includes("|| view.kind === 'devices'"), 'Top chrome dashboard subtabs should also render for Devices')
  assert.ok(appSource.includes('tabs={DEVICE_DASHBOARD_SUBTABS}'), 'Devices should reuse the dashboard subtab definition')
})

test('device Sync keeps the primary device navbar above its subtabs', () => {
  const primaryDeviceTabsIndex = appSource.indexOf("{view.kind === 'device' && (\n              <DeviceSectionTabs")
  const syncSubtabsIndex = appSource.indexOf("{view.kind === 'device' && view.section === 'sync' && (")
  const syncSubtabsBlock = appSource.slice(syncSubtabsIndex, appSource.indexOf('            )}', syncSubtabsIndex) + 15)

  assert.ok(primaryDeviceTabsIndex >= 0, 'DeviceSectionTabs should render for every device section, including Sync')
  assert.ok(!appSource.includes("view.kind === 'device' && view.section !== 'sync'"), 'Sync must not be excluded from primary device tabs')
  assert.ok(syncSubtabsIndex > primaryDeviceTabsIndex, 'Sync subtabs should render after the primary device navbar')
  assert.ok(syncSubtabsBlock.includes('tabs={DEVICE_SYNC_SUBTABS}'), 'Sync should keep its own subtab definition')
  assert.ok(!syncSubtabsBlock.includes('variant="primary"'), 'Sync subtabs should use the secondary navbar row styling')
})

test('device Sync exposes full resync in a final Advanced subtab', () => {
  const syncTabsStart = appSource.indexOf('const DEVICE_SYNC_SUBTABS')
  const syncTabsEnd = appSource.indexOf('const SETTINGS_TABS', syncTabsStart)
  const syncTabs = appSource.slice(syncTabsStart, syncTabsEnd)
  const configIndex = syncTabs.indexOf("{ key: 'config', label: 'Configuración'")
  const advancedIndex = syncTabs.indexOf("{ key: 'advanced', label: 'Avanzado'")

  assert.ok(syncTabsStart >= 0 && syncTabsEnd > syncTabsStart, 'Sync subtab definition should be discoverable')
  assert.ok(configIndex >= 0, 'Sync should keep its configuration subtab')
  assert.ok(advancedIndex > configIndex, 'Advanced should be the final sync subtab after Configuration')
})

test('shared device subtabs support roving keyboard focus', () => {
  assert.ok(appSource.includes('tabIndex={active === tab.key ? 0 : -1}'), 'Only the active tab should stay in the tab order')
  assert.ok(appSource.includes("event.key === 'ArrowRight'"), 'Right arrow should advance through tabs')
  assert.ok(appSource.includes("event.key === 'ArrowLeft'"), 'Left arrow should move back through tabs')
  assert.ok(appSource.includes("event.key === 'Home'"), 'Home should focus the first tab')
  assert.ok(appSource.includes("event.key === 'End'"), 'End should focus the last tab')
  assert.ok(appSource.includes('data-device-subtab={tab.key}'), 'Programmatic tab changes should have a stable focus target')
  assert.ok(appSource.includes('aria-controls={idPrefix ? `${idPrefix}-panel` : undefined}'), 'Associated tab sets should identify their controlled panel')
  assert.ok(appSource.includes('idPrefix="device-sync"'), 'Device Sync should opt into the tab-to-panel association')
})

test('DevicesView no longer renders old inline segmented tabs', () => {
  assert.ok(!devicesSource.includes('device-dashboard-tabs'), 'DevicesView should not render the old segmented tab row')
  assert.ok(!devicesSource.includes('onDashboardTabChange'), 'DevicesView should not own tab changes locally')
  assert.ok(!devicesSource.includes('setLocalTab'), 'DevicesView should not keep local tab fallback state')
  assert.ok(!/\.device-dashboard-tabs\b/.test(css), 'Old device dashboard tab CSS should be removed')
})

test('Devices activity tab discard resolves the activity center sync entry', () => {
  assert.ok(
    devicesSource.includes('const resolveDeviceSyncDiscarded = useActivityCenterStore(s => s.resolveDeviceSyncDiscarded)'),
    'DevicesView should subscribe to the activity resolution action',
  )
  assert.ok(
    devicesSource.includes('const journal = pendingJournals.find(item => item.id === journalId) ?? null'),
    'DevicesView should capture the journal before discarding it',
  )
  assert.ok(
    devicesSource.includes('if (journal) resolveDeviceSyncDiscarded(journal.planId)'),
    'DevicesView should close the activity center item for the discarded plan',
  )
  assert.ok(
    devicesSource.includes('onDiscard={journalId => void discardPendingJournal(journalId)}'),
    'DevicesView should route pending journal discards through the wrapper',
  )
  assert.ok(
    !devicesSource.includes('onDiscard={journalId => void discardJournal(journalId)}'),
    'DevicesView should not call discardJournal directly from the pending journal list',
  )
})
