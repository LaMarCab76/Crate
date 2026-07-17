import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'

const trustedSenders = new Map<number, string>()

export function trustIpcWindow(win: BrowserWindow, exactUrl: string): void {
  const senderId = win.webContents.id
  trustedSenders.set(senderId, exactUrl)
  win.webContents.once('destroyed', () => trustedSenders.delete(senderId))
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const sender = event.sender
  const expectedUrl = trustedSenders.get(sender.id)
  if (!expectedUrl || sender.isDestroyed()) throw new Error('IPC sender is not an authorized Crate window')
  if (!event.senderFrame || event.senderFrame !== sender.mainFrame) {
    throw new Error('IPC is only available to the top-level Crate frame')
  }
  if (event.senderFrame.url !== expectedUrl) {
    throw new Error('IPC sender URL does not match the Crate application URL')
  }
  const win = BrowserWindow.fromWebContents(sender)
  if (!win || win.isDestroyed()) throw new Error('IPC sender window is unavailable')
}

type InvokeHandler = Parameters<typeof ipcMain.handle>[1]

export const secureIpcMain = {
  handle(channel: string, listener: InvokeHandler): void {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event)
      return listener(event, ...args)
    })
  },
}
