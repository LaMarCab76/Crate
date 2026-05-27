import { LYRICS_SETTINGS_DEFAULTS, type LyricsSettingsState } from '@shared/types/lyrics'

// In-memory holder for the lyrics preferences. Mirrors the LibraryBackup model:
// the renderer owns persistence (localStorage) and pushes values here via the
// settings:setLyrics IPC handler (plus a boot-time push). Main reads these to
// decide cache/fetch behavior. Sidecar writes are mandatory.
class LyricsSettings {
  private state: LyricsSettingsState = { ...LYRICS_SETTINGS_DEFAULTS }

  get(): LyricsSettingsState {
    return this.state
  }

  set(patch: Partial<LyricsSettingsState>): void {
    this.state = { ...this.state, ...patch }
  }
}

let instance: LyricsSettings | null = null

export function getLyricsSettings(): LyricsSettings {
  if (!instance) instance = new LyricsSettings()
  return instance
}
