import { BrowserWindow } from 'electron'

// Tiny broadcast helper for main → renderer push events. Every BrowserWindow
// in the app receives the message; this is currently used by the main UI window.
export function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}
