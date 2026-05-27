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

// Targeted send for events that should not fan out to every window — pass
// a specific BrowserWindow or its webContents id.
export function broadcastTo(
  target: BrowserWindow | number,
  channel: string,
  payload?: unknown,
): void {
  const win =
    typeof target === 'number' ? BrowserWindow.fromId(target) : target
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, payload)
}
