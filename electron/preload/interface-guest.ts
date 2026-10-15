import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { CrateInterfaceSdk } from '../../shared/types/interfaces'

// Keep IPC and Electron objects inside this trusted preload. Imported scripts
// can only call the versioned broker; they cannot access the application's API.
const sdk: CrateInterfaceSdk = {
  request: (method, params) => ipcRenderer.invoke('interface-guest:request', { method, params }),
  onState: (handler) => {
    if (typeof handler !== 'function') throw new Error('State handler must be a function')
    const listener = (_event: IpcRendererEvent, snapshot: unknown) => handler(snapshot)
    ipcRenderer.on('interface-guest:state', listener)
    return () => ipcRenderer.removeListener('interface-guest:state', listener)
  },
}
contextBridge.exposeInMainWorld('crateInterface', sdk)
