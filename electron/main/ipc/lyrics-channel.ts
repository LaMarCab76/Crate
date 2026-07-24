import { BrowserWindow, dialog } from 'electron'
import { secureIpcMain as ipcMain } from './secureIpc'
import { readFileSync } from 'node:fs'
import { getLyricsBackfillService } from '../lyrics/LyricsBackfillService'
import { getLyricsService } from '../lyrics/LyricsService'
import { getLyricsSettings } from '../lyrics/LyricsSettings'
import { getRepos } from '../db/repositories'
import { getLocalFileAccessService } from '../security/localFileAccessRuntime'
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
  const repos = getRepos()

  const withTrackAccess = async <T>(
    event: Electron.IpcMainInvokeEvent,
    trackId: number,
    mode: 'read' | 'write',
    operation: () => Promise<T> | T,
  ): Promise<T> => {
    const track = repos.tracks.getById(trackId)
    const folder = track ? repos.folders.getById(track.folder_id) : null
    if (!track || track.provider !== 'local' || !folder || folder.provider !== 'local') {
      return operation()
    }
    return getLocalFileAccessService().runWithAccess(
      folder.path,
      mode,
      async () => operation(),
      { owner: BrowserWindow.fromWebContents(event.sender) ?? undefined },
    )
  }

  ipcMain.handle('lyrics:get', (event, trackId: number) => {
    const id = assertId(trackId, 'trackId')
    return withTrackAccess(event, id, 'read', () => svc.getForTrack(id))
  })

  ipcMain.handle('lyrics:libraryOverview', (_, force?: boolean) => svc.libraryOverview({ force: force === true }))

  ipcMain.handle('lyrics:fetch', async (event, p: { trackId: number; force?: boolean }) => {
    const trackId = assertId(p?.trackId, 'trackId')
    const view = await withTrackAccess(
      event,
      trackId,
      'write',
      () => svc.fetchOnline(trackId, { force: p.force === true }),
    )
    broadcast('lyrics:changed', { trackId })
    return view
  })

  ipcMain.handle('lyrics:search', (_, trackId: number) => svc.searchOnline(assertId(trackId, 'trackId')))

  ipcMain.handle('lyrics:importCandidate', async (event, p: { trackId: number; lrclibId: string }) => {
    const trackId = assertId(p?.trackId, 'trackId')
    const lrclibId = assertNonEmptyString(p?.lrclibId, 'lrclibId')
    const view = await withTrackAccess(event, trackId, 'write', () => svc.importCandidate(trackId, lrclibId))
    broadcast('lyrics:changed', { trackId })
    return view
  })

  ipcMain.handle('lyrics:importFile', async (event, trackId: number): Promise<LyricsView | null> => {
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
    const view = await withTrackAccess(event, id, 'write', () => svc.importLrcText(id, text))
    broadcast('lyrics:changed', { trackId: id })
    return view
  })

  ipcMain.handle('lyrics:import', async (event, p: { trackId: number; lrcText: string }) => {
    const trackId = assertId(p?.trackId, 'trackId')
    assertLyricsSize(p?.lrcText, 'lrcText')
    const view = await withTrackAccess(event, trackId, 'write', () => svc.importLrcText(trackId, p.lrcText))
    broadcast('lyrics:changed', { trackId })
    return view
  })

  ipcMain.handle('lyrics:save', async (event, p: { trackId: number; plain: string | null; synced: string | null }) => {
    const trackId = assertId(p?.trackId, 'trackId')
    assertLyricsSize(p?.plain, 'plain lyrics')
    assertLyricsSize(p?.synced, 'synced lyrics')
    const view = await withTrackAccess(event, trackId, 'write', () => svc.saveUserEdit(trackId, p.plain, p.synced))
    broadcast('lyrics:changed', { trackId })
    return view
  })

  ipcMain.handle('lyrics:setOffset', async (event, p: { trackId: number; offsetMs: number }) => {
    const trackId = assertId(p?.trackId, 'trackId')
    const offset = assertOffsetMs(p?.offsetMs)
    const view = await withTrackAccess(event, trackId, 'write', () => svc.setOffset(trackId, offset))
    broadcast('lyrics:changed', { trackId })
    return view
  })

  ipcMain.handle('lyrics:export', (event, trackId: number) => {
    const id = assertId(trackId, 'trackId')
    return withTrackAccess(event, id, 'read', () => svc.exportLrc(id))
  })

  ipcMain.handle('lyrics:remove', async (event, p: { trackId: number }) => {
    const trackId = assertId(p?.trackId, 'trackId')
    await withTrackAccess(event, trackId, 'write', () => svc.remove(trackId))
    broadcast('lyrics:changed', { trackId })
  })

  ipcMain.handle('lyrics:fetchForSelection', async (event, trackIds: number[]) => {
    const safeTrackIds = sanitizeIds(trackIds)
    const roots = new Set<string>()
    for (const trackId of safeTrackIds) {
      const track = repos.tracks.getById(trackId)
      const folder = track ? repos.folders.getById(track.folder_id) : null
      if (track?.provider === 'local' && folder?.provider === 'local') roots.add(folder.path)
    }
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
    for (const root of roots) {
      await getLocalFileAccessService().runWithAccess(root, 'write', async () => undefined, {
        owner,
        retryOnce: false,
      })
    }
    const summary = await svc.fetchForSelection(safeTrackIds)
    broadcast('library:changed', { reason: 'lyrics-bulk' })
    return summary
  })

  // Renderer-side preference push (mirrors settings:setLibraryBackup). Main reads
  // these to decide cache/fetch behavior. Sidecar writes are mandatory.
  ipcMain.handle('settings:setLyrics', (_, patch: Partial<LyricsSettingsState>) => {
    getLyricsSettings().set(patch)
    // Enabling background fetch at runtime kicks off the one-time library sweep
    // (idempotent per session).
    if (patch.backgroundFetch === true) {
      try { getLyricsBackfillService().sweepExistingLibrary() } catch { /* best-effort */ }
    }
  })
}
