import { app, BrowserWindow, dialog, ipcMain as guestIpcMain, Menu, MenuItem } from 'electron'
import { readFileSync, statSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { InterfaceGuestResponse, InterfaceSelection } from '../../../shared/types/interfaces'
import { MAX_INTERFACE_BYTES } from '../../../shared/interfaces/validation'
import { InterfaceRepository } from '../interfaces/InterfaceRepository'
import { InterfaceRuntime } from '../interfaces/InterfaceRuntime'
import { secureIpcMain } from './secureIpc'

let repository: InterfaceRepository | null = null
let guestPreloadPath = ''
let trialTimer: ReturnType<typeof setTimeout> | null = null
let generation = 0
const windows = new Map<number, { win: BrowserWindow; runtime: InterfaceRuntime }>()

function store(): InterfaceRepository {
  if (!repository) throw new Error('Interface manager is not ready')
  return repository
}

function broadcast(selection: InterfaceSelection): void {
  for (const { win } of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send('interfaces:selection-changed', selection)
  }
}

async function synchronize(selection: InterfaceSelection): Promise<void> {
  const ticket = ++generation
  if (trialTimer) clearTimeout(trialTimer)
  trialTimer = null
  if (selection.trial) trialTimer = setTimeout(() => {
    void synchronize(store().revert('The interface was not confirmed within 60 seconds.'))
  }, 60_000)
  broadcast(selection)
  const pkg = store().read(selection.activeId, selection.activeRevision)
  const loads = [...windows.values()].map(async ({ win, runtime }) => {
    try { await runtime.load(pkg) } catch {
      if (!win.isDestroyed() && ticket === generation) await synchronize(store().restoreIncluded('The selected interface could not start.'))
    }
  })
  await Promise.all(loads)
}

function restoreIncluded(): void {
  void synchronize(store().restoreIncluded('The included interface was restored from the application menu.'))
}

export function attachInterfaceWindow(win: BrowserWindow): void {
  const runtime = new InterfaceRuntime(win, guestPreloadPath, reason => {
    if (!win.isDestroyed()) void synchronize(store().restoreIncluded(reason))
  }, join(app.getPath('userData'), 'artwork'))
  const senderId = win.webContents.id
  windows.set(senderId, { win, runtime })
  win.once('closed', () => windows.delete(senderId))
  const selection = store().getSelection()
  const ticket = generation
  try {
    const pkg = store().read(selection.activeId, selection.activeRevision)
    void runtime.load(pkg).catch(() => {
      if (!win.isDestroyed() && ticket === generation) restoreIncluded()
    })
  } catch {
    if (!win.isDestroyed() && ticket === generation) restoreIncluded()
  }
}

function senderRuntime(senderId: number): InterfaceRuntime {
  const entry = windows.get(senderId)
  if (!entry) throw new Error('Interface host is unavailable')
  return entry.runtime
}

export function registerInterfacesChannel(preloadPath: string): void {
  guestPreloadPath = preloadPath
  repository = new InterfaceRepository(join(app.getPath('userData'), 'interfaces'))

  secureIpcMain.handle('interfaces:list', () => store().list())
  secureIpcMain.handle('interfaces:read', (_event, id: string, revision?: string) => {
    try { return store().read(id, revision) } catch (error) {
      const selection = store().getSelection()
      if (selection.activeId === id && (revision == null || revision === selection.activeRevision)) {
        void synchronize(store().restoreIncluded('The active interface package was missing or damaged.'))
      }
      throw error
    }
  })
  secureIpcMain.handle('interfaces:save', (_event, pkg: unknown) => store().save(pkg))
  secureIpcMain.handle('interfaces:remove', (_event, id: string) => store().remove(id))
  secureIpcMain.handle('interfaces:selection', () => store().getSelection())
  secureIpcMain.handle('interfaces:activate', async (_event, id: string, revision?: string) => {
    await synchronize(store().activate(id, revision))
    return store().getSelection()
  })
  secureIpcMain.handle('interfaces:confirm', () => {
    const selection = store().confirm()
    if (trialTimer) clearTimeout(trialTimer)
    trialTimer = null
    broadcast(selection)
    return selection
  })
  secureIpcMain.handle('interfaces:revert', async () => {
    await synchronize(store().revert())
    return store().getSelection()
  })
  secureIpcMain.handle('interfaces:import', async event => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (!parent) throw new Error('Interface host is unavailable')
    const result = await dialog.showOpenDialog(parent, { title: 'Import Crate interface', properties: ['openFile'], filters: [{ name: 'Crate interface', extensions: ['crate-interface', 'json'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    if (statSync(path).size > MAX_INTERFACE_BYTES) throw new Error('Interface package exceeds the 16 MiB limit')
    let pkg: unknown
    try { pkg = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('The selected file is not a valid JSON interface package') }
    return store().save(pkg)
  })
  secureIpcMain.handle('interfaces:export', async (event, id: string, revision?: string) => {
    const pkg = store().read(id, revision)
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (!parent) throw new Error('Interface host is unavailable')
    const result = await dialog.showSaveDialog(parent, { title: 'Export Crate interface', defaultPath: `${pkg.manifest.id}.crate-interface`, filters: [{ name: 'Crate interface', extensions: ['crate-interface'] }] })
    if (result.canceled || !result.filePath) return false
    const temporary = `${result.filePath}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(pkg, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      renameSync(temporary, result.filePath)
    } finally { rmSync(temporary, { force: true }) }
    return true
  })
  secureIpcMain.handle('interfaces:guest-visible', (event, visible: unknown) => {
    if (typeof visible !== 'boolean') throw new Error('Visibility must be a boolean')
    senderRuntime(event.sender.id).setVisible(visible)
  })
  secureIpcMain.handle('interfaces:chrome', (event, base: unknown) => {
    if (base !== 'classic' && base !== 'glass') throw new Error('Unknown window chrome')
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && process.platform === 'darwin') win.setWindowButtonPosition(base === 'classic' ? { x: 14, y: 16 } : { x: 22, y: 27 })
  })
  secureIpcMain.handle('interfaces:respond', (event, response: InterfaceGuestResponse) => senderRuntime(event.sender.id).respond(response))
  secureIpcMain.handle('interfaces:guest-state', (event, snapshot: unknown) => senderRuntime(event.sender.id).updateState(snapshot))
  // These channels intentionally do NOT use secureIpcMain: imported content is
  // authenticated against its own exact webContents, frame and package URL.
  guestIpcMain.handle('interface-guest:request', (event, payload: unknown) => {
    for (const { runtime } of windows.values()) {
      if (runtime.owns(event.sender.id)) return runtime.request(event, payload)
    }
    throw new Error('Interface SDK caller is not active')
  })

  const recovery = new Menu()
  recovery.append(new MenuItem({ label: 'Restore Included Interface', accelerator: 'CmdOrCtrl+Alt+Shift+R', click: restoreIncluded }))
  const existing = Menu.getApplicationMenu()
  if (existing) {
    existing.append(new MenuItem({ label: 'Interface', submenu: recovery }))
    Menu.setApplicationMenu(existing)
  } else {
    const menu = Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
      { label: 'Interface', submenu: recovery },
    ])
    Menu.setApplicationMenu(menu)
  }
}

export function disposeInterfacesChannel(): void {
  if (trialTimer) clearTimeout(trialTimer)
  trialTimer = null
  for (const { runtime } of windows.values()) runtime.destroy()
  windows.clear()
}

/** A host crash can originate from a malformed declarative composition too. */
export function recoverInterfaceHost(): void {
  const selection = store().getSelection()
  if (selection.activeId !== 'crate-glass' && selection.activeId !== 'crate-classic') {
    void synchronize(store().restoreIncluded('Crate restored its included interface after the application interface stopped.'))
  }
}
