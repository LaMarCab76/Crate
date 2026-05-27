import { dialog, ipcMain } from 'electron'
import { readFileSync } from 'node:fs'
import { getLyricsService } from '../lyrics/LyricsService'
import { getLyricsSettings } from '../lyrics/LyricsSettings'
import { broadcast } from './events'
import { assertId, assertNonEmptyString, sanitizeIds } from './validation'
import { MAX_LYRICS_CHARS, clampLyricsOffsetMs, isLyricsSizeOk } from '@shared/lyrics/lrc'
import type { LyricsSettingsState, LyricsView } from '@shared/types/lyrics'

// Lyrics text can arrive from disk, the renderer, or a remote provider. Reject
// anything past the shared cap before it reaches the parser/DB.
function assertLyricsSize(text: string | null | undefined, label: string): void {
  if (!isLyricsSizeOk(text)) {
    throw new Error(`${label} exceeds the maximum size (${MAX_LYRICS_CHARS} chars)`)
  }
}

function assertOffsetMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid offsetMs: ${String(value)}`)
  }
  return clampLyricsOffsetMs(value)
}

export function registerLyricsChannel(): void {
  const svc = getLyricsService()

  ipcMain.handle('lyrics:get', (_, trackId: number) => svc.getForTrack(assertId(trackId, 'trackId')))

  ipcMain.handle('lyrics:fetch', async (_, p: { trackId: number; force?: boolean }) => {
    const trackId = assertId(p?.trackId, 'trackId')
    const view = await svc.fetchOnline(trackId, { force: p.force === true })
    broadcast('lyrics:changed', { trackId })
    return view
  })

  ipcMain.handle('lyrics:search', (_, trackId: number) => svc.searchOnline(assertId(trackId, 'trackId')))

  ipcMain.handle('lyrics:importCandidate', async (_, p: { trackId: number; lrclibId: string }) => {
    const trackId = assertId(p?.trackId, 'trackId')
    const lrclibId = assertNonEmptyString(p?.lrclibId, 'lrclibId')
    const view = await svc.importCandidate(trackId, lrclibId)
    broadcast('lyrics:changed', { trackId })
    return view
  })

  ipcMain.handle('lyrics:importFile', async (_, trackId: number): Promise<LyricsView | null> => {
    const id = assertId(trackId, 'trackId')
    const result = await dialog.showOpenDialog({
      title: 'Import lyrics (.lrc)',
      properties: ['openFile'],
      filters: [{ name: 'LRC / text', extensions: ['lrc', 'txt'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    let text: string
    try {
      text = readFileSync(result.filePaths[0], 'utf8')
    } catch {
      return null
    }
    assertLyricsSize(text, 'lyrics file')
    const view = svc.importLrcText(id, text)
    broadcast('lyrics:changed', { trackId: id })
    return view
  })

  ipcMain.handle('lyrics:import', (_, p: { trackId: number; lrcText: string }) => {
    const trackId = assertId(p?.trackId, 'trackId')
    assertLyricsSize(p?.lrcText, 'lrcText')
    const view = svc.importLrcText(trackId, p.lrcText)
    broadcast('lyrics:changed', { trackId })
    return view
  })

  ipcMain.handle('lyrics:save', (_, p: { trackId: number; plain: string | null; synced: string | null }) => {
    const trackId = assertId(p?.trackId, 'trackId')
    assertLyricsSize(p?.plain, 'plain lyrics')
    assertLyricsSize(p?.synced, 'synced lyrics')
    const view = svc.saveUserEdit(trackId, p.plain, p.synced)
    broadcast('lyrics:changed', { trackId })
    return view
  })

  ipcMain.handle('lyrics:setOffset', (_, p: { trackId: number; offsetMs: number }) => {
    const trackId = assertId(p?.trackId, 'trackId')
    const view = svc.setOffset(trackId, assertOffsetMs(p?.offsetMs))
    broadcast('lyrics:changed', { trackId })
    return view
  })

  ipcMain.handle('lyrics:export', (_, trackId: number) => svc.exportLrc(assertId(trackId, 'trackId')))

  ipcMain.handle('lyrics:remove', (_, p: { trackId: number }) => {
    const trackId = assertId(p?.trackId, 'trackId')
    svc.remove(trackId)
    broadcast('lyrics:changed', { trackId })
  })

  ipcMain.handle('lyrics:fetchForSelection', async (_, trackIds: number[]) => {
    const summary = await svc.fetchForSelection(sanitizeIds(trackIds))
    broadcast('library:changed', { reason: 'lyrics-bulk' })
    return summary
  })

  // Renderer-side preference push (mirrors settings:setLibraryBackup). Main reads
  // these to decide cache/fetch behavior. Sidecar writes are mandatory.
  ipcMain.handle('settings:setLyrics', (_, patch: Partial<LyricsSettingsState>) => {
    getLyricsSettings().set(patch)
  })
}
