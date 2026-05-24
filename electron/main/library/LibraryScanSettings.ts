import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SETTINGS_FILE = 'library-scan-settings.json'
export const DEFAULT_SCAN_LOG_RETENTION_DAYS = 30

interface PersistedLibraryScanSettings {
  retentionDays?: number | null
}

function normalizeRetentionDays(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SCAN_LOG_RETENTION_DAYS
  const days = Math.floor(value)
  return days > 0 ? days : DEFAULT_SCAN_LOG_RETENTION_DAYS
}

class LibraryScanSettings {
  private retentionDays: number | null = DEFAULT_SCAN_LOG_RETENTION_DAYS
  private loaded = false

  getRetentionDays(): number | null {
    this.load()
    return this.retentionDays
  }

  setRetentionDays(value: number | null): number | null {
    this.retentionDays = normalizeRetentionDays(value)
    this.loaded = true
    this.save()
    return this.retentionDays
  }

  private settingsPath(): string {
    return join(app.getPath('userData'), SETTINGS_FILE)
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    const target = this.settingsPath()
    if (!existsSync(target)) return
    try {
      const parsed = JSON.parse(readFileSync(target, 'utf8')) as PersistedLibraryScanSettings
      this.retentionDays = normalizeRetentionDays(parsed.retentionDays)
    } catch (err) {
      console.warn(`[library-scan] failed to read settings: ${(err as Error).message}`)
    }
  }

  private save(): void {
    const target = this.settingsPath()
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, JSON.stringify({ retentionDays: this.retentionDays }, null, 2))
    } catch (err) {
      console.warn(`[library-scan] failed to write settings: ${(err as Error).message}`)
    }
  }
}

let instance: LibraryScanSettings | null = null

export function getLibraryScanSettings(): LibraryScanSettings {
  if (!instance) instance = new LibraryScanSettings()
  return instance
}
