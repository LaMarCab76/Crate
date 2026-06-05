import type { DeviceSyncPhase } from '@shared/types/device-sync'

export interface SanitizableSyncJournalStep {
  kind?: string
  status?: string
}

export interface SanitizableSyncJournal {
  phase?: DeviceSyncPhase | 'fetching_lyrics' | null
  actions?: SanitizableSyncJournalStep[]
  lyrics?: SanitizableSyncJournalStep[]
  artwork?: SanitizableSyncJournalStep[]
}

function withoutLegacyLyricsSteps(steps: SanitizableSyncJournalStep[] | undefined): {
  steps: SanitizableSyncJournalStep[]
  changed: boolean
} {
  const normalized = Array.isArray(steps) ? steps : []
  const filtered = normalized.filter(step => step.kind !== 'sync_lyrics')
  return {
    steps: filtered,
    changed: filtered.length !== normalized.length,
  }
}

export function sanitizeLegacyDeviceSyncJournal(journal: SanitizableSyncJournal): boolean {
  let changed = false

  if (journal.phase === 'fetching_lyrics') {
    journal.phase = null
    changed = true
  }

  const actions = withoutLegacyLyricsSteps(journal.actions)
  if (actions.changed || journal.actions !== actions.steps) {
    journal.actions = actions.steps
    changed = changed || actions.changed
  }

  const artwork = withoutLegacyLyricsSteps(journal.artwork)
  if (artwork.changed || journal.artwork !== artwork.steps) {
    journal.artwork = artwork.steps
    changed = changed || artwork.changed
  }

  if (Array.isArray(journal.lyrics) && journal.lyrics.length > 0) {
    changed = true
  }
  if (journal.lyrics !== undefined) {
    journal.lyrics = []
  }

  return changed
}
