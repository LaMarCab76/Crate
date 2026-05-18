import { contextBridge } from 'electron'

const api = {
  version: '2.0.0-alpha.1',
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
