import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const syncSource = readFileSync(new URL('../views/DeviceSyncView.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

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
  const stage = cssBlock('.device-sync-stage.device-sync-activity-tab')
  const wizard = cssBlock('.device-sync-wizard')
  const diff = cssBlock('.device-sync-diff,\n.device-sync-result')
  const columns = cssBlock('.device-sync-columns')
  const side = cssBlock('.device-sync-side')
  const groups = cssBlock('.device-sync-side-groups')
  const global = cssBlock('.device-side-global')
  const toggle = cssBlock('.device-side-toggle')

  assert.equal(declaration(steps, 'display'), 'flex')
  // The active step underlines like the section tabs.
  assert.equal(declaration(step, 'border-bottom'), '2px solid transparent')
  assert.equal(declaration(stage, 'width'), '100%')
  assert.equal(declaration(stage, 'max-width'), 'none')
  assert.equal(declaration(wizard, 'grid-template-rows'), 'auto minmax(0, 1fr) auto')
  assert.equal(declaration(wizard, 'min-height'), '460px')
  assert.equal(declaration(diff, 'min-height'), '0')
  // Vista 1 / Vista 2 fill the available width as two side-by-side columns (PC | MP3).
  assert.equal(declaration(columns, 'display'), 'grid')
  assert.equal(declaration(columns, 'grid-template-columns'), 'repeat(2, minmax(0, 1fr))')
  assert.equal(declaration(columns, 'align-items'), 'stretch')
  assert.equal(declaration(side, 'min-height'), '0')
  assert.equal(declaration(groups, 'max-height'), 'none')
  assert.equal(declaration(global, 'display'), 'inline-flex')
  assert.equal(declaration(toggle, 'display'), 'inline-flex')
})

test('sync diff exposes visible global side controls without artwork optimization locking them', () => {
  assert.ok(syncSource.includes('Tomar todo de {COMPUTER.short}'), 'Diff should expose a platform-aware computer winner control')
  assert.ok(syncSource.includes('Tomar todo de MP3'), 'Diff should expose a global MP3 winner control')
  assert.ok(syncSource.includes("const planEditingLocked = applying || (syncRunning && activeProgress?.phase !== 'optimizing_artwork')"), 'Artwork-only optimization should not lock diff controls')
  assert.ok(syncSource.includes('loading={planEditingLocked}'), 'Diff controls should use the plan editing lock')
})

test('discarding a pending sync resolves the activity center item for its plan', () => {
  const start = syncSource.indexOf('const discardPendingJournal = useCallback')
  const end = syncSource.indexOf('const isSyncRun', start)
  const discardBlock = syncSource.slice(start, end)

  assert.ok(start >= 0 && end > start, 'discardPendingJournal block should be discoverable')
  assert.ok(
    syncSource.includes('const resolveDeviceSyncDiscarded = useActivityCenterStore(s => s.resolveDeviceSyncDiscarded)'),
    'DeviceSyncView should subscribe to the activity resolution action',
  )
  assert.ok(
    discardBlock.includes('const journal = pendingJournals.find(item => item.id === journalId) ?? null'),
    'Discard should capture the journal before the store removes it',
  )
  assert.ok(
    discardBlock.includes('await discardJournal(journalId)'),
    'Discard should wait until the journal is actually discarded',
  )
  assert.ok(
    discardBlock.includes('if (journal) resolveDeviceSyncDiscarded(journal.planId)'),
    'Discard should close the activity center item for the discarded plan',
  )
  assert.ok(
    syncSource.includes('onDiscard={journalId => void discardPendingJournal(journalId)}'),
    'PendingJournalList should use the discard wrapper',
  )
})

test('artwork optimization verifies refreshed oversized results and returns to the optimize menu', () => {
  const start = syncSource.indexOf('const runOptimization = useCallback')
  const end = syncSource.indexOf('const artworkProgressActive', start)
  const runOptimizationBlock = syncSource.slice(start, end)

  assert.ok(start >= 0 && end > start, 'runOptimization block should be discoverable')
  assert.ok(
    runOptimizationBlock.includes('const optimizedRelativePaths = selectedArtworkItems.map(item => item.relativePath)'),
    'Optimization should capture the selected paths before the async run',
  )
  assert.ok(
    runOptimizationBlock.includes('const refreshedAnalysis = await analyzeArtwork(deviceId)'),
    'Optimization should await a fresh artwork analysis after writing files',
  )
  assert.ok(
    !runOptimizationBlock.includes('analyzeArtwork(deviceId).catch(() => undefined)'),
    'Fresh analysis errors must not be hidden after optimization',
  )
  assert.ok(
    runOptimizationBlock.includes('const optimizedPathSet = new Set(optimizedRelativePaths)'),
    'Verification should compare refreshed oversized items against optimized paths',
  )
  assert.ok(
    runOptimizationBlock.includes('refreshedAnalysis.items.filter(item => optimizedPathSet.has(item.relativePath)).length'),
    'Verification should count optimized tracks that still exceed the artwork limit',
  )
  assert.ok(runOptimizationBlock.includes("setArtworkQuery('')"), 'Optimization should clear active search')
  assert.ok(runOptimizationBlock.includes('setFocusedArtworkGroupKey(null)'), 'Optimization should leave the artist/album detail view')
  assert.ok(runOptimizationBlock.includes('setExcludedArtworkKeys(new Set())'), 'Optimization should clear stale manual exclusions')
  assert.ok(
    syncSource.includes('formatArtworkVerificationMessage(optimizeResult, optimizedStillOversized)'),
    'The post-optimize message should report the verification result',
  )
})

test('artwork optimization progress is owned by the optimize panel to avoid a duplicate header bar', () => {
  assert.ok(
    syncSource.includes("import { artworkOptimizationOwnsSyncProgress } from '@renderer/utils/artworkProgressOwnership'"),
    'DeviceSyncView should use the artwork progress ownership helper',
  )
  assert.ok(
    syncSource.includes('const [artworkProgressOwnedByPanel, setArtworkProgressOwnedByPanel] = useState(false)'),
    'DeviceSyncView should track when the optimize panel owns the artwork progress',
  )
  assert.ok(
    syncSource.includes('const ownsHeaderProgress = artworkOptimizationOwnsSyncProgress({'),
    'ArtworkOptimizePanel should derive progress ownership from the active sync progress',
  )
  assert.ok(
    syncSource.includes('onProgressOwnedChange(ownsHeaderProgress)'),
    'ArtworkOptimizePanel should notify the parent while it renders the same progress',
  )
  assert.ok(
    syncSource.includes("const headerProgress = artworkProgressOwnedByPanel || activeProgress?.phase === 'complete'"),
    'The page header should hide progress already rendered by the optimize panel or already complete',
  )
})

test('device sync keeps repeat calculations available after applying a plan', () => {
  assert.ok(syncSource.includes('const [appliedPlan, setAppliedPlan] = useState<DeviceSyncPlan | null>(null)'), 'Applied plans should remain locally available for their result screen')
  assert.ok(syncSource.includes('setAppliedPlan(visiblePlan)'), 'Apply should preserve the reviewed plan before the store clears it')
  assert.ok(syncSource.includes('Calcular cambios otra vez'), 'Completed sync results should expose a direct recalculation action')
  assert.ok(syncSource.includes("activeProgress.phase !== 'complete'"), 'Completed progress must not leave sync controls locked')
})

test('automatic plan debounce cannot cancel or overwrite a newer configuration', () => {
  assert.ok(syncSource.includes('const autoPlanGenerationRef = useRef(0)'), 'Automatic calculations should carry a generation')
  assert.ok(syncSource.includes('if (autoPlanGenerationRef.current !== generation) return'), 'An obsolete autosave callback should stop before planning')
  assert.ok(syncSource.includes('await buildPlan(false, false)'), 'An automatic build should not cancel a newer scheduled timer')
})

test('device sync shows last-sync mode indicators and isolates full sync in Advanced', () => {
  const advancedStart = syncSource.indexOf("{syncTab === 'advanced' && (")
  const syncStart = syncSource.indexOf("{syncTab === 'sync' && (", advancedStart)
  const advancedBlock = syncSource.slice(advancedStart, syncStart)
  const syncBlock = syncSource.slice(syncStart)

  assert.ok(syncSource.includes("activeSyncModeLabel = selectedDevice?.lastSyncAt && !planRequestedFullSync"), 'DeviceSyncView should model incremental/full mode for labels')
  assert.ok(syncSource.includes("Última sync:"), 'DeviceSyncView should display last sync label in header')
  assert.ok(advancedStart >= 0 && syncStart > advancedStart, 'Advanced and normal sync sections should be discoverable')
  assert.ok(advancedBlock.includes('Resincronización completa'), 'Advanced should explain the exhaustive operation')
  assert.ok(advancedBlock.includes('Calcular resync completo'), 'Advanced should expose the full-sync action')
  assert.ok(!syncBlock.includes('Calcular resync completo'), 'Normal synchronization should not expose the full-sync action')
  assert.ok(syncSource.includes('buildPlan(true)'), 'Resync button should pass fullSync=true to plan generation')
  assert.ok(syncSource.includes('buildPlan(false)'), 'Recalcular should pass fullSync=false path')
  assert.ok(syncSource.includes('if (!calculatedPlan) return'), 'A stale full plan should not navigate away from Advanced')
  assert.ok(syncSource.includes("'[data-device-subtab=\"sync\"]'"), 'Successful full planning should move focus to the selected Sync tab')
  assert.ok(syncSource.includes('role="tabpanel"'), 'Device Sync content should expose tabpanel semantics')
  assert.ok(syncSource.includes('aria-labelledby={`device-sync-tab-${syncTab}`}'), 'The active panel should reference its selected tab')
})
