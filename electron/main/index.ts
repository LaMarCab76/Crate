import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { closeDatabase, getDatabase } from './db/database'
import { registerLibraryChannel } from './ipc/library-channel'
import { registerAudioChannel } from './ipc/audio-channel'
import { registerProtocolHandlers, registerProtocolSchemes } from './protocol'
import { getFolderWatcher } from './library/FolderWatcher'
import { getAudioEngine } from './audio/AudioEngine'
import { getExclusiveModeManager } from './audio/ExclusiveModeManager'
import { getLibraryBackup } from './services/LibraryBackup'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const isDev = !app.isPackaged

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
    shell.openExternal(url)
    return { action: 'deny' }
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

app.whenReady().then(() => {
  // Dev-only dock branding (a packaged macOS app uses the bundle icon instead).
  if (devIcon && process.platform === 'darwin') app.dock?.setIcon(devIcon)

  // Initialize the SQLite database before the renderer can call any IPC handler.
  // Migrations are applied during the first getDatabase() call.
  getDatabase()
  registerProtocolHandlers()
  registerLibraryChannel()
  registerAudioChannel()

  // Start watching every already-registered folder so we pick up disk changes
  // without requiring a rescan.
  getFolderWatcher().startAll()

  createMainWindow()

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
  getFolderWatcher().stopAll()
  // Release CoreAudio hog BEFORE freeing BASS — if we leave the device
  // hog-locked the OS keeps it claimed for this process and no other app
  // can play sound until reboot.
  try { getExclusiveModeManager().dispose() } catch { /* manager may not have initialized */ }
  try { getAudioEngine().dispose() } catch { /* engine may not have initialized */ }
  closeDatabase()
})
