import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { closeDatabase, getDatabase } from './db/database'
import { registerLibraryChannel } from './ipc/library-channel'
import { disposeGapless, registerAudioChannel } from './ipc/audio-channel'
import { registerLyricsChannel } from './ipc/lyrics-channel'
import { registerDevicesChannel } from './ipc/devices-channel'
import { registerDownloadsChannel } from './ipc/downloads-channel'
import { registerCloudChannel } from './ipc/cloud-channel'
import { registerUpdatesChannel } from './ipc/updates-channel'
import { registerProtocolHandlers, registerProtocolSchemes } from './protocol'
import { getDeviceSyncService } from './devices/DeviceSyncService'
import { getFolderWatcher } from './library/FolderWatcher'
import { getLibraryReconciler } from './library/LibraryReconciler'
import { getOneDriveLibraryService } from './cloud/OneDriveLibraryService'
import { getLyricsBackfillService } from './lyrics/LyricsBackfillService'
import { getLyricsIndexService } from './lyrics/LyricsIndexService'
import { getLyricsSettings } from './lyrics/LyricsSettings'
import { getAudioEngine } from './audio/AudioEngine'
import { getExclusiveModeManager } from './audio/ExclusiveModeManager'
import { getLibraryBackup } from './services/LibraryBackup'
import { getLibraryWorkerClient } from './workers/LibraryWorkerClient'
import { getAppUpdateService } from './updates/AppUpdateService'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const isDev = !app.isPackaged

// Last-resort logging so a stray rejection or throw doesn't take the main process
// down silently (which would freeze the window with no diagnostics). We log rather
// than exit so a single failed IPC call can't kill the whole app.
process.on('unhandledRejection', reason => {
  console.error('[main] unhandledRejection:', reason)
})
process.on('uncaughtException', err => {
  console.error('[main] uncaughtException:', err)
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

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon: devIcon ?? undefined,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: '#0a0a0c',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // sandbox stays disabled: the preload is bundled as ESM (index.mjs) and
      // Electron's sandbox only supports CommonJS preloads — enabling it fails with
      // "Cannot use import statement outside a module". contextIsolation +
      // nodeIntegration:false still keep the renderer locked down. To turn sandbox
      // on, the preload must first be emitted as CommonJS.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.once('ready-to-show', () => win.show())
  // Safety net: if the renderer crashes before first paint, ready-to-show
  // never fires and the window stays hidden. In dev we force-show after a
  // short delay so the resulting blank/error page is at least visible.
  if (isDev) setTimeout(() => { if (!win.isVisible()) win.show() }, 1500)

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] did-fail-load code=${code} desc=${desc} url=${url}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] render-process-gone', details)
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
    try {
      if (new URL(url).origin !== new URL(win.webContents.getURL()).origin) {
        event.preventDefault()
      }
    } catch {
      event.preventDefault()
    }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    if (process.env['CRATE_OPEN_DEVTOOLS'] === '1') {
      win.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(async () => {
  // Dev-only dock branding (a packaged macOS app uses the bundle icon instead).
  if (devIcon && process.platform === 'darwin') app.dock?.setIcon(devIcon)

  // Initialize the SQLite database before the renderer can call any IPC handler.
  // Migrations are applied during the first getDatabase() call.
  getDatabase()
  registerProtocolHandlers()
  registerLibraryChannel()
  registerAudioChannel()
  registerLyricsChannel()
  registerDevicesChannel()
  registerDownloadsChannel()
  registerCloudChannel()
  registerUpdatesChannel()
  getDeviceSyncService().startVolumeMonitor()

  const reconciler = getLibraryReconciler()
  try {
    await reconciler.scanAll('startup')
  } catch (err) {
    console.error('[library-scan] startup reconciliation failed:', err)
  }

  // Start watching every already-registered folder so we pick up disk changes
  // without requiring a rescan.
  getFolderWatcher().startAll()
  reconciler.startBackgroundSweep()

  // Cloud folders aren't watched by chokidar; poll them incrementally via the
  // OneDrive delta API instead.
  getOneDriveLibraryService().startPolling()

  // Background lyrics backfill. The initial sweep runs AFTER scanAll so the DB
  // already reflects the real library (new tracks imported, gone tracks removed).
  // Both are no-ops unless the user enabled background fetch.
  const backfill = getLyricsBackfillService()
  backfill.start()
  if (getLyricsSettings().get().backgroundFetch) backfill.sweepExistingLibrary()

  createMainWindow()
  getAppUpdateService().startAutoCheck()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  // Flush any pending portable-library backup writes before we close the DB,
  // otherwise the JSON would miss the last few mutations of the session.
  try { getLibraryBackup().flushAll() } catch (err) { console.error('[backup] flush failed:', err) }
  try { getLyricsIndexService().flushAll() } catch (err) { console.error('[lyrics-index] flush failed:', err) }
  getFolderWatcher().stopAll()
  try { getOneDriveLibraryService().stopPolling() } catch { /* service may not have initialized */ }
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
  closeDatabase()
})
