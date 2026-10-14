import { BrowserWindow } from 'electron'
import { secureIpcMain as ipcMain } from './secureIpc'
import { getDeviceSyncService } from '../devices/DeviceSyncService'
import { getFolderCleanupService } from '../folder-cleanup/FolderCleanupService'
import { assertNonEmptyString } from './validation'

export function registerFolderCleanupChannel(): void {
  const service = getFolderCleanupService()

  ipcMain.handle('folder-cleanup:pending', () => service.pending())

  ipcMain.handle('folder-cleanup:confirm', async (event, proposalId: unknown) => {
    const id = assertNonEmptyString(proposalId, 'proposal id')
    const proposal = await service.requirePending(id)
    const executor = proposal.scope === 'device'
      ? (pending: typeof proposal) => getDeviceSyncService().confirmFolderCleanup(pending)
      : service.localExecutor(BrowserWindow.fromWebContents(event.sender) ?? undefined)
    return service.confirm(id, executor)
  })

  ipcMain.handle('folder-cleanup:dismiss', (_, proposalId: unknown) =>
    service.dismiss(assertNonEmptyString(proposalId, 'proposal id')),
  )
}
