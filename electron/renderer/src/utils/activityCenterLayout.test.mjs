import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const toolbarSource = readFileSync(new URL('../components/Toolbar.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8')

test('App renders the activity center from the top chrome', () => {
  assert.ok(appSource.includes("import { ActivityCenter }"), 'App should import ActivityCenter')
  assert.ok(appSource.includes('<ActivityCenter'), 'App should render ActivityCenter')
  assert.ok(appSource.includes('activityOpen={activityOpen}'), 'Toolbar should receive open state')
  assert.ok(appSource.includes('onToggleActivityCenter={toggleActivityPanel}'), 'Toolbar should toggle activity center')
  assert.ok(toolbarSource.includes('onToggleActivityCenter'), 'Toolbar should expose the activity toggle handler')
})

test('Toolbar exposes an activity button with active and unread badges', () => {
  assert.ok(toolbarSource.includes('tb-activity-btn'), 'Toolbar should include the activity button')
  assert.ok(toolbarSource.includes('activityActiveCount'), 'Toolbar should receive active activity count')
  assert.ok(toolbarSource.includes('activityUnreadCount'), 'Toolbar should receive unread activity count')
  assert.ok(toolbarSource.includes('tb-activity-badge'), 'Toolbar should render the activity badge')
  assert.ok(toolbarSource.includes("'loader' : 'activity'"), 'Toolbar should swap to an animated loader while activity runs')
  assert.ok(!toolbarSource.includes('name="bell"'), 'Toolbar activity icon should not use a notification bell')
})

test('global bottom device notifications were removed', () => {
  assert.ok(!appSource.includes('DeviceSyncStatusBar'), 'App should not render the old sync status bar')
  assert.ok(!appSource.includes('DeviceVolumePrompt'), 'App should not render the old volume prompt')
  assert.ok(!css.includes('.device-sync-status-bar'), 'Old sync status bar CSS should be removed')
  assert.ok(!css.includes('.device-volume-prompt'), 'Old volume prompt CSS should be removed')
  assert.ok(!css.includes('with-device-sync'), 'Old bottom sync padding class should be removed')
})

test('activity center supports pinned and fullscreen states', () => {
  assert.match(css, /\.activity-center\s*\{[^}]*position:\s*fixed/s, 'Activity center should float above the app chrome')
  const centerSource = readFileSync(new URL('../components/ActivityCenter.tsx', import.meta.url), 'utf8')
  assert.ok(centerSource.includes('createPortal'), 'Activity center should render as a document-level overlay')
  assert.ok(centerSource.includes('activity-center-loader'), 'Running activity rows should expose a loading icon')
  assert.ok(css.includes('@keyframes activity-spin'), 'Loading icons should be animated')
  assert.ok(css.includes('.activity-center.fullscreen'), 'Activity center should have fullscreen CSS')
  assert.ok(appSource.includes('setActivityPinned'), 'App should wire pinned state')
  assert.ok(appSource.includes('setActivityFullscreen'), 'App should wire fullscreen state')
})

test('activity rows navigate through a primary action without duplicating button clicks', () => {
  const centerSource = readFileSync(new URL('../components/ActivityCenter.tsx', import.meta.url), 'utf8')
  assert.ok(centerSource.includes('primaryActivityActionIdFor'), 'Rows should derive a primary navigation action')
  assert.ok(centerSource.includes('onClick={openPrimaryAction}'), 'Clicking an activity row should open its destination')
  assert.ok(centerSource.includes('event.stopPropagation()'), 'Nested action buttons should not also trigger the row action')
  assert.ok(centerSource.includes('onKeyDown={onRowKeyDown}'), 'Rows should support keyboard navigation')
  assert.ok(css.includes('.activity-center-row.actionable'), 'Clickable rows should expose a visual affordance')
})

test('completed activities become green confirmations without a progress bar', () => {
  const centerSource = readFileSync(new URL('../components/ActivityCenter.tsx', import.meta.url), 'utf8')
  assert.match(
    centerSource,
    /progress && item\.status !== 'success'/,
    'Completed activities should not keep rendering their progress bar',
  )
  assert.match(
    centerSource,
    /item\.status === 'success' && <Icon name="check"/,
    'Completed activities should show a check beside their status',
  )
  assert.match(
    css,
    /\.activity-center-row\.done[\s\S]*?background:\s*var\(--activity-success-bg\)/,
    'Completed activity rows should use the semantic green background',
  )
  assert.match(
    css,
    /\.activity-center-status\.done\s*\{[\s\S]*?color:\s*var\(--activity-success\)/,
    'The completed status and check should use the semantic green color',
  )
})
