import { BrowserWindow } from 'electron'

// Tiny broadcast helper for main → renderer push events. Every BrowserWindow
// in the app receives the message; we currently only have one but the API is
// future-proof for the mini-player popout in a later session.
export function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}
