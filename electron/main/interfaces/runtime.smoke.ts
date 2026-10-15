/** Run with runtime.smoke.mjs. Always uses a temporary profile and a hidden app. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, protocol, webContents } from 'electron'
import { InterfaceRuntime } from './InterfaceRuntime'
import { InterfaceRepository } from './InterfaceRepository'
import type { InterfacePackage, InterfaceGuestRequest } from '../../../shared/types/interfaces'

const directory = process.env.CRATE_INTERFACE_SMOKE_DIR
const preloadPath = process.env.CRATE_INTERFACE_SMOKE_PRELOAD
if (!directory || !preloadPath || !directory.includes('crate-interface-smoke-')) throw new Error('Runtime smoke requires its isolated launcher')
app.setPath('userData', join(directory, 'userData'))
protocol.registerSchemesAsPrivileged([
  { scheme: 'crate-interface', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'crate', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])
const uncaughtErrors: Error[] = []
process.on('uncaughtException', error => { uncaughtErrors.push(error); console.error('Unexpected smoke exception:', error) })
app.on('window-all-closed', () => { /* Keep the harness alive until teardown assertions finish. */ })

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))
async function until(predicate: () => boolean, milliseconds = 15_000): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (!predicate() && Date.now() < deadline) await wait(50)
  assert.ok(predicate(), 'Timed out waiting for the interface runtime')
}

void app.whenReady().then(async () => {
  let runtime: InterfaceRuntime | null = null
  const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  try {
    await win.loadURL('data:text/html,<title>Crate interface smoke</title><h1>Trusted host</h1>')
    const hostProcess = win.webContents.getOSProcessId()
    const artwork = join(directory, 'artwork')
    mkdirSync(artwork)
    writeFileSync(join(artwork, 'cover.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSagAAAAASUVORK5CYII=', 'base64'))
    const failures: string[] = []
    runtime = new InterfaceRuntime(win, preloadPath, reason => failures.push(reason), artwork)
    const brokerRequests: InterfaceGuestRequest[] = []
    const originalSend = win.webContents.send.bind(win.webContents)
    Object.defineProperty(win.webContents, 'send', { value: (channel: string, ...args: unknown[]) => {
      if (channel === 'interfaces:request') {
        const request = args[0] as InterfaceGuestRequest
        brokerRequests.push(request)
        setTimeout(() => runtime?.respond({ requestId: request.requestId, result: [{ id: 7, title: 'Smoke track' }] }), 0)
      } else originalSend(channel, ...args)
    } })
    ipcMain.handle('interface-guest:request', (event, payload) => runtime!.request(event, payload))
    const pkg: InterfacePackage = {
      manifest: { schemaVersion: 1, id: 'smoke-programmed', name: 'Smoke programmed interface', version: '1.0.0', kind: 'code', base: 'glass', capabilities: ['library.read'], entry: 'index.html' },
      files: [{ path: 'index.html', encoding: 'utf8', content: '<!doctype html><meta charset="utf-8"><title>Guest smoke</title><h1>Programmable interface</h1><script>window.lastState = null; window.crateInterface.onState(value => { window.lastState = value })</script>' }],
    }
    await runtime.load(pkg)
    runtime.setVisible(true)
    const guest = webContents.getAllWebContents().find(contents => runtime!.owns(contents.id))
    assert.ok(guest, 'The programmable interface must have its own webContents')
    assert.notEqual(guest.getOSProcessId(), hostProcess, 'Guest must have a different OS process from the trusted host')
    const isolation = await guest.executeJavaScript('({api:typeof window.api, require:typeof require, process:typeof process, sdk:typeof window.crateInterface, crossFrame:window.top===window})')
    assert.deepEqual(isolation, { api: 'undefined', require: 'undefined', process: 'undefined', sdk: 'object', crossFrame: true })
    const earlyResult = guest.executeJavaScript('window.crateInterface.request("library.tracks",{limit:2})')
    await wait(100)
    assert.equal(brokerRequests.length, 0, 'Requests must wait for the trusted host bridge to subscribe')
    runtime.updateState({ playback: { status: 'stopped', currentTrack: null } })
    const result = await earlyResult
    assert.equal(result[0].id, 7)
    assert.equal(brokerRequests.length, 1)
    const denied = await guest.executeJavaScript('window.crateInterface.request("playback.play").then(()=>false,error=>error.message)')
    assert.match(denied, /not declared/)
    const unknown = await guest.executeJavaScript('window.crateInterface.request("library.folders").then(()=>false,error=>error.message)')
    assert.match(unknown, /unavailable/)
    const deniedUrls = await guest.executeJavaScript('Promise.all(["https://example.com/", "file:///etc/passwd", "crate://rockbox-theme/secret", "crate://artwork/../secret"].map(url=>fetch(url).then(()=>false,()=>true)))')
    assert.deepEqual(deniedUrls, [true, true, true, true])
    const assetStatus = await guest.executeJavaScript('new Promise(resolve=>{const image=new Image;image.onload=()=>resolve(true);image.onerror=()=>resolve(false);image.src="crate://artwork/cover.png"})')
    assert.equal(assetStatus, true, 'Only validated cached artwork should load')
    runtime.updateState({ playback: { status: 'paused', currentTrack: { id: 7 } } })
    await wait(100)
    assert.equal((await guest.executeJavaScript('window.lastState')).playback.currentTrack.id, 7)
    assert.throws(() => runtime!.request({ sender: win.webContents, senderFrame: win.webContents.mainFrame } as never, { method: 'library.tracks' }), /not the active top-level/)
    console.log('PASS: isolated process, trusted SDK, startup request buffering, capability gate, resource policy, artwork, host identity, state subscription')

    const repository = new InterfaceRepository(join(directory, 'interfaces'))
    const installed = repository.save(pkg)
    repository.activate('crate-classic')
    repository.activate(pkg.manifest.id, installed.revision)
    assert.equal(new InterfaceRepository(join(directory, 'interfaces')).getSelection().activeId, 'crate-classic')
    console.log('PASS: provisional activation rolls back after restart')

    guest.forcefullyCrashRenderer()
    await until(() => failures.length > 0)
    assert.equal(await win.webContents.executeJavaScript('1+1'), 2)
    assert.equal(win.webContents.getOSProcessId(), hostProcess)
    console.log('PASS: crashed guest leaves trusted host responsive in the same process')

    failures.length = 0
    await runtime.load({ ...pkg, manifest: { ...pkg.manifest, capabilities: [] } })
    const busyGuest = webContents.getAllWebContents().find(contents => runtime!.owns(contents.id))!
    runtime.updateState({ playback: { status: 'playing', positionSec: 12, currentTrack: { id: 7, title: 'Private metadata' } }, queue: { tracks: [{ id: 7, title: 'Private metadata' }], total: 1, currentIndex: 0 } })
    await wait(100)
    const filtered = await busyGuest.executeJavaScript('window.lastState')
    assert.equal(filtered.playback.currentTrack, null)
    assert.equal(filtered.playback.status, 'playing')
    assert.equal(filtered.playback.positionSec, 12)
    assert.deepEqual(filtered.queue.tracks, [])
    assert.equal(filtered.queue.total, 1)
    console.log('PASS: interfaces without library.read cannot observe current-track or queue metadata in state snapshots')
    void busyGuest.executeJavaScript('while(true){}').catch(() => {})
    assert.equal(await win.webContents.executeJavaScript('2+2'), 4)
    await until(() => failures.length > 0, 16_000)
    assert.match(failures[0], /responding/)
    assert.equal(await win.webContents.executeJavaScript('3+3'), 6)
    console.log('PASS: main-owned heartbeat detects a busy guest and removes it while preserving the trusted host')
    await runtime.load(pkg)
    const restoreGuest = webContents.getAllWebContents().find(contents => runtime!.owns(contents.id))!
    void restoreGuest.executeJavaScript('while(true){}').catch(() => {})
    await wait(100)
    runtime.destroy()
    await wait(750)
    assert.equal(await win.webContents.executeJavaScript('4+4'), 8)
    console.log('PASS: immediate native restore removes a busy guest before its heartbeat deadline')
    await runtime.load(pkg)
    win.destroy()
    await wait(750)
    assert.equal(win.isDestroyed(), true)
    assert.deepEqual(uncaughtErrors, [], 'Closing the real host window with an active guest must not access destroyed native getters')
    console.log('PASS: host-window close with an active guest completes without uncaught exceptions')
    app.exit(0)
  } catch (error) {
    console.error(error)
    runtime?.destroy()
    if (!win.isDestroyed()) win.destroy()
    app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
