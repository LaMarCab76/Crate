import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDatabase, getDatabase } from './db/database'
import { registerLibraryChannel } from './ipc/library-channel'
import { registerAudioChannel } from './ipc/audio-channel'
import { registerProtocolHandlers, registerProtocolSchemes } from './protocol'
import { getFolderWatcher } from './library/FolderWatcher'
import { getAudioEngine } from './audio/AudioEngine'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const isDev = !app.isPackaged

// Privileged protocol schemes must be registered BEFORE app.whenReady.
registerProtocolSchemes()

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: '#0a0a0c',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
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
  getFolderWatcher().stopAll()
  try { getAudioEngine().dispose() } catch { /* engine may not have initialized */ }
  closeDatabase()
})
