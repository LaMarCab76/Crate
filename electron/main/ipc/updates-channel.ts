import { ipcMain } from 'electron'
import { getAppUpdateService } from '../updates/AppUpdateService'

export function registerUpdatesChannel(): void {
  const updates = getAppUpdateService()

  ipcMain.handle('app:update:getState', () => updates.getState())
  ipcMain.handle('app:update:check', () => updates.checkForUpdates('manual'))
  ipcMain.handle('app:update:download', () => updates.downloadUpdate())
  ipcMain.handle('app:update:install', () => updates.installDownloadedUpdate())
}
