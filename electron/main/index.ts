import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { closeDatabase, getDatabase } from './db/database'
import { registerLibraryChannel } from './ipc/library-channel'
import { disposeGapless, registerAudioChannel } from './ipc/audio-channel'
import { registerLyricsChannel } from './ipc/lyrics-channel'
import { registerDevicesChannel } from './ipc/devices-channel'
import { registerUpdatesChannel } from './ipc/updates-channel'
import { registerCloudChannel } from './ipc/cloud-channel'
import { disposeLibraryLocationsChannel, registerLibraryLocationsChannel } from './ipc/library-locations-channel'
import { disposeLibraryMigrationsChannel, registerLibraryMigrationsChannel } from './ipc/library-migrations-channel'
import { disposeDuplicateChannel, registerDuplicateChannel } from './ipc/duplicate-channel'
import { registerFolderCleanupChannel } from './ipc/folder-cleanup-channel'
import { registerProtocolHandlers, registerProtocolSchemes } from './protocol'
import { getDeviceSyncService } from './devices/DeviceSyncService'
import { getFolderWatcher } from './library/FolderWatcher'
import { getLibraryReconciler } from './library/LibraryReconciler'
import { getLyricsBackfillService } from './lyrics/LyricsBackfillService'
import { getLyricsIndexService } from './lyrics/LyricsIndexService'
import { getLyricsSettings } from './lyrics/LyricsSettings'
import { getAudioEngine } from './audio/AudioEngine'
import { getExclusiveModeManager } from './audio/ExclusiveModeManager'
import { getLibraryBackup } from './services/LibraryBackup'
import { getLibraryWorkerClient } from './workers/LibraryWorkerClient'
import { getAppUpdateService } from './updates/AppUpdateService'
import { trustIpcWindow } from './ipc/secureIpc'
import { getOneDriveLibraryService } from './cloud/OneDriveLibraryService'
import { getCloudManifestService } from './cloud/CloudManifestService'
import {
  getLibraryMirrorService,
  scheduleMirrorsForSource,
  stopLibraryMirrorRuntime,
} from './library-mirror/runtime'
import { getLibraryMigrationService, stopLibraryMigrationRuntime } from './library-migration/runtime'
import { setLibraryLocationLockDatabase } from './library-migration/locationLocks'
import { getDuplicateResolutionService } from './duplicates/DuplicateResolutionService'
import { getDuplicateDecisionPortableService } from './duplicates/DuplicateDecisionPortableService'
import { getDuplicateRuntime } from './duplicates/runtime'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const isDev = !app.isPackaged

// Enables repeatable smoke tests without touching a developer's real catalog,
// auth cache or device journals. Packaged builds intentionally ignore it.
const isolatedUserData = isDev ? process.env['CRATE_USER_DATA_DIR']?.trim() : ''
if (isolatedUserData) app.setPath('userData', resolve(isolatedUserData))

let shutdownStarted = false
let shutdownComplete = false
let unsubscribeCloudMirror: (() => void) | null = null

process.on('unhandledRejection', reason => {
  console.error('[main] unhandledRejection:', reason)
})
process.on('uncaughtException', err => {
  console.error('[main] uncaughtException:', err)
  void shutdownApplication(1)
})

// Only well-formed http(s) URLs may be handed to the OS browser — never file:,
// javascript: or custom schemes that page content could try to smuggle through.
function isSafeExternalUrl(raw: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(raw).protocol)
  } catch {
    return false
  }
}

// A packaged build gets its icon from the app bundle (.icns/.ico). In dev there
// is no bundle, so we point Electron at the source PNG to brand the dock/taskbar.
const devIconPath = join(__dirname, '../../electron-build/icon.png')
const devIcon = isDev && existsSync(devIconPath) ? nativeImage.createFromPath(devIconPath) : null

// Privileged protocol schemes must be registered BEFORE app.whenReady.
registerProtocolSchemes()

function rendererEntryUrl(): string {
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    return new URL(process.env['ELECTRON_RENDERER_URL']).href
  }
  return pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

async function loadRenderer(win: BrowserWindow): Promise<void> {
  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    await win.loadURL(rendererEntryUrl())
    return
  }
  await win.loadFile(join(__dirname, '../renderer/index.html'))
}

async function showRendererFailure(win: BrowserWindow): Promise<void> {
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Crate could not start</title><style>body{margin:0;background:#0a0a0c;color:#eee;font:16px system-ui;display:grid;place-items:center;min-height:100vh}.box{max-width:560px;padding:32px}h1{font-size:24px}p{color:#aaa;line-height:1.5}</style><main class="box"><h1>Crate could not restore its interface</h1><p>The renderer stopped repeatedly. Restart Crate; your library has not been modified by this recovery screen.</p></main>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  if (!win.isVisible()) win.show()
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon: devIcon ?? undefined,
    titleBarStyle: 'hiddenInset',
    // Lines up with the floating glass toolbar pill (top: 12px, 46px tall).
    trafficLightPosition: { x: 22, y: 27 },
    backgroundColor: '#0a0a0c',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  trustIpcWindow(win, rendererEntryUrl())

  win.once('ready-to-show', () => win.show())
  // Safety net: if the renderer crashes before first paint, ready-to-show
  // never fires and the window stays hidden. In dev we force-show after a
  // short delay so the resulting blank/error page is at least visible.
  if (isDev) setTimeout(() => { if (!win.isVisible()) win.show() }, 1500)

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] did-fail-load code=${code} desc=${desc} url=${url}`)
  })
  const rendererCrashes: number[] = []
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] render-process-gone', details)
    if (!win.isDestroyed() && BrowserWindow.getAllWindows().includes(win)) {
      const now = Date.now()
      rendererCrashes.push(now)
      while (rendererCrashes[0] != null && rendererCrashes[0] < now - 60_000) rendererCrashes.shift()
      const attempt = rendererCrashes.length
      const delayMs = Math.min(4_000, 500 * 2 ** Math.max(0, attempt - 1))
      setTimeout(() => {
        if (win.isDestroyed()) return
        if (attempt >= 3) {
          void showRendererFailure(win)
        } else {
          void loadRenderer(win).catch(err => console.error('[renderer] recovery load failed:', err))
        }
      }, delayMs)
    }
  })
  win.webContents.on('console-message', (_e, level, message, line, src) => {
    const tag = level === 3 ? 'ERROR' : level === 2 ? 'WARN' : 'LOG'
    console.log(`[renderer:${tag}] ${src}:${line} — ${message}`)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // The app is a single local document. Block any attempt to navigate the renderer
  // away from its own origin (a stray <a> click or injected link); genuine external
  // links still reach the system browser via the window-open handler above.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererEntryUrl()) event.preventDefault()
  })

  void loadRenderer(win).catch(err => console.error('[renderer] initial load failed:', err))
  if (isDev && process.env['CRATE_OPEN_DEVTOOLS'] === '1') {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  return win
}

app.whenReady().then(async () => {
  // Dev-only dock branding (a packaged macOS app uses the bundle icon instead).
  if (devIcon && process.platform === 'darwin') app.dock?.setIcon(devIcon)

  // Initialize the SQLite database before the renderer can call any IPC handler.
  // Migrations are applied during the first getDatabase() call.
  setLibraryLocationLockDatabase(getDatabase())
  registerProtocolHandlers()
  registerLibraryChannel()
  registerAudioChannel()
  registerLyricsChannel()
  registerDevicesChannel()
  registerCloudChannel()
  registerLibraryLocationsChannel()
  registerLibraryMigrationsChannel()
  registerDuplicateChannel()
  registerFolderCleanupChannel()
  registerUpdatesChannel()
  getDeviceSyncService().startVolumeMonitor()

  // The UI becomes available as soon as DB and IPC are ready. Potentially slow
  // reconciliation/backfill work is deliberately kept off the startup path.
  createMainWindow()
  await getLibraryMigrationService().recover()
  // Complete a confirmed physical duplicate deletion before reconciliation can
  // interpret the now-missing file as an unrelated external removal.
  await getDuplicateResolutionService().recover()
  getAppUpdateService().startAutoCheck()

  const cloud = getOneDriveLibraryService()
  unsubscribeCloudMirror = cloud.onSyncComplete(result => {
    scheduleMirrorsForSource(result.folderId, 'cloud_delta', 0)
  })
  cloud.startPolling()
  void getLibraryMirrorService().syncAll('startup').then(results => {
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('[library-mirror] startup sync failed:', result.reason)
      }
    }
  })

  const reconciler = getLibraryReconciler()
  void (async () => {
    try {
      await reconciler.scanAll('startup')
    } catch (err) {
      console.error('[library-scan] startup reconciliation failed:', err)
    }
    // The first backfill stays off the critical startup path. The duplicate
    // runtime imports portable pair decisions before evaluating candidates.
    getDuplicateRuntime().scheduleAll({ delayMs: 0, activityOrigin: 'startup' })
    getFolderWatcher().startAll()
    reconciler.startBackgroundSweep()
    const backfill = getLyricsBackfillService()
    backfill.start()
    if (getLyricsSettings().get().backgroundFetch) backfill.sweepExistingLibrary()
  })()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

async function shutdownApplication(exitCode: number): Promise<void> {
  if (shutdownStarted) return
  shutdownStarted = true
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.destroy()
  }
  try { await getOneDriveLibraryService().stopPolling() } catch { /* cloud service may not have initialized */ }
  try { unsubscribeCloudMirror?.() } catch { /* listener may not have initialized */ }
  unsubscribeCloudMirror = null
  disposeLibraryLocationsChannel()
  disposeLibraryMigrationsChannel()
  try { await disposeDuplicateChannel() } catch { /* no active duplicate review */ }
  getFolderWatcher().stopAll()
  try { await stopLibraryMigrationRuntime() } catch (err) { console.error('[library-migration] dispose failed:', err) }
  try { await getDuplicateRuntime().dispose() } catch (err) { console.error('[duplicates] runtime dispose failed:', err) }
  // Flush any pending portable-library backup writes before we close the DB,
  // otherwise the JSON would miss the last few mutations of the session.
  try { getLibraryBackup().flushAll() } catch (err) { console.error('[backup] flush failed:', err) }
  try { await getDuplicateDecisionPortableService().flushAll() } catch (err) { console.error('[duplicates] portable decisions flush failed:', err) }
  try { await getCloudManifestService().flushAll() } catch (err) { console.error('[cloud-manifest] flush failed:', err) }
  try { await stopLibraryMirrorRuntime() } catch (err) { console.error('[library-mirror] dispose failed:', err) }
  try { getLyricsIndexService().flushAll() } catch (err) { console.error('[lyrics-index] flush failed:', err) }
  try { getLibraryWorkerClient().dispose() } catch { /* worker may not have spawned */ }
  try { getLyricsBackfillService().stop() } catch { /* service may not have initialized */ }
  try { getLibraryReconciler().dispose() } catch { /* reconciler may not have initialized */ }
  try { getDeviceSyncService().stopVolumeMonitor() } catch { /* service may not have initialized */ }
  // Release CoreAudio hog BEFORE freeing BASS — if we leave the device
  // hog-locked the OS keeps it claimed for this process and no other app
  // can play sound until reboot.
  try { getExclusiveModeManager().dispose() } catch { /* manager may not have initialized */ }
  try { disposeGapless() } catch { /* gapless may not have initialized */ }
  try { getAudioEngine().dispose() } catch { /* engine may not have initialized */ }
  setLibraryLocationLockDatabase(null)
  closeDatabase()
  shutdownComplete = true
  app.exit(exitCode)
}

app.on('before-quit', event => {
  if (shutdownComplete) return
  event.preventDefault()
  void shutdownApplication(0)
})
