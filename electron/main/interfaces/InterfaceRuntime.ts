import { WebContentsView, session, type BrowserWindow, type IpcMainInvokeEvent, type Session, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { InterfaceGuestRequest, InterfaceGuestResponse, InterfacePackage } from '../../../shared/types/interfaces'
import { assertInterfaceAssetPath } from '../../../shared/interfaces/validation'
import { boundedJson, validateGuestRequest } from './guestPolicy'

const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: crate://artwork; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'"
const MIME_TYPES: Record<string, string> = { html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', woff: 'font/woff', woff2: 'font/woff2' }

/** A separate, ephemeral session owns only the package assets and restricted SDK. */
export class InterfaceRuntime {
  private view: WebContentsView | null = null
  private guestSession: Session | null = null
  private guestUrl: string | null = null
  private capabilities: string[] = []
  private visible = false
  private pending = new Map<string, { request: InterfaceGuestRequest; delivered: boolean; resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private requestTimes: number[] = []
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatDeadline: ReturnType<typeof setTimeout> | null = null
  private state: unknown = null
  private hostReady = false
  private hostProcessId = 0
  private readonly resize = () => this.updateBounds()
  private readonly hostReload = () => {
    this.hostReady = false
    // A mutation may already have executed before a host crash. Cancel it;
    // automatically replaying it could skip a second track or edit the queue twice.
    this.cancelPending('Crate is restoring its interface host. Try the action again.')
  }
  private readonly hostLoaded = () => {
    if (!this.win.isDestroyed()) this.hostProcessId = this.win.webContents.getOSProcessId()
    if (this.view && this.hostProcessId > 0 && this.view.webContents.getOSProcessId() === this.hostProcessId) {
      this.fail('Crate could not isolate the custom interface from its application process.')
    }
  }

  constructor(private readonly win: BrowserWindow, private readonly preloadPath: string, private readonly failed: (reason: string) => void, private readonly artworkDirectory: string) {
    const hostContents = win.webContents
    win.on('resize', this.resize)
    hostContents.on('did-start-loading', this.hostReload)
    hostContents.on('did-finish-load', this.hostLoaded)
    this.hostLoaded()
    win.once('closed', () => {
      this.destroy()
      win.removeListener('resize', this.resize)
      hostContents.removeListener('did-start-loading', this.hostReload)
      hostContents.removeListener('did-finish-load', this.hostLoaded)
    })
  }

  async load(pkg: InterfacePackage): Promise<void> {
    this.destroy()
    if (pkg.manifest.kind !== 'code') return
    const partition = `crate-interface-${randomUUID()}`
    const guestSession = session.fromPartition(partition, { cache: false })
    const origin = `crate-interface://${randomUUID()}`
    this.guestUrl = `${origin}/${pkg.manifest.entry}`
    this.capabilities = [...pkg.manifest.capabilities]
    this.guestSession = guestSession
    const assets = new Map((pkg.files ?? []).map(file => [file.path, Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8')]))
    guestSession.setPermissionCheckHandler(() => false)
    guestSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    guestSession.setDevicePermissionHandler(() => false)
    guestSession.on('will-download', event => event.preventDefault())
    guestSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith(`${origin}/`) && !details.url.startsWith('crate://artwork/') && !details.url.startsWith('data:') && !details.url.startsWith('blob:') })
    })
    guestSession.protocol.handle('crate', request => {
      try {
        const url = new URL(request.url)
        const filename = decodeURIComponent(url.pathname.slice(1))
        if (url.hostname !== 'artwork' || !/^[a-zA-Z0-9_. -]+$/.test(filename) || filename.includes('..') || !/\.(?:png|jpe?g|webp|gif)$/i.test(filename)) return new Response('Forbidden', { status: 403 })
        const path = join(this.artworkDirectory, filename)
        if (statSync(path).size > 8 * 1024 * 1024) return new Response('Too large', { status: 413 })
        return new Response(new Uint8Array(readFileSync(path)), { headers: { 'Content-Type': MIME_TYPES[filename.split('.').pop()?.toLowerCase() ?? ''] ?? 'image/jpeg', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } })
      } catch { return new Response('Not found', { status: 404 }) }
    })
    guestSession.protocol.handle('crate-interface', request => {
      try {
        const url = new URL(request.url)
        if (`${url.protocol}//${url.host}` !== origin || request.method !== 'GET') return new Response('Forbidden', { status: 403 })
        const path = assertInterfaceAssetPath(decodeURIComponent(url.pathname.slice(1)))
        const body = assets.get(path)
        if (!body) return new Response('Not found', { status: 404 })
        return new Response(new Uint8Array(body), { headers: {
          'Content-Type': MIME_TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream',
          'Content-Security-Policy': CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'Cache-Control': 'no-store',
        } })
      } catch { return new Response('Bad request', { status: 400 }) }
    })
    const view = new WebContentsView({ webPreferences: {
      session: guestSession, preload: this.preloadPath, sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false,
      spellcheck: false, disableDialogs: true, backgroundThrottling: true,
    } })
    this.view = view
    view.setBackgroundColor('#101116')
    this.win.contentView.addChildView(view)
    this.updateBounds()
    view.setVisible(this.visible)
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', event => event.preventDefault())
    view.webContents.on('will-frame-navigate', event => event.preventDefault())
    view.webContents.on('will-attach-webview', event => event.preventDefault())
    view.webContents.on('render-process-gone', () => { if (this.view === view) this.fail('The custom interface stopped. Crate restored the included interface.') })
    view.webContents.on('unresponsive', () => { if (this.view === view) this.fail('The custom interface stopped responding. Crate restored the included interface.') })
    view.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (this.view === view && isMainFrame && code !== -3) this.fail('The custom interface could not load.')
    })
    view.webContents.on('did-finish-load', () => {
      if (this.view === view && this.state !== null) view.webContents.send('interface-guest:state', this.guestState())
    })
    // Electron's native unresponsive event is useful, but does not fire for
    // every background-page stall. A timed execution also detects a busy loop
    // without depending on timers or callbacks supplied by imported code.
    this.heartbeatTimer = setInterval(() => {
      if (this.view !== view || this.heartbeatDeadline || view.webContents.isDestroyed()) return
      this.heartbeatDeadline = setTimeout(() => {
        this.heartbeatDeadline = null
        if (this.view === view) this.fail('The custom interface stopped responding. Crate restored the included interface.')
      }, 5000)
      void view.webContents.executeJavaScript('true').then(() => {
        if (this.view !== view) return
        if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline)
        this.heartbeatDeadline = null
      }).catch(() => { if (this.view === view) this.fail('The custom interface stopped responding.') })
    }, 5000)
    try {
      await view.webContents.loadURL(this.guestUrl)
      if (this.view === view) this.hostLoaded()
    } catch (error) {
      if (this.view === view) this.fail('The custom interface could not start.')
      throw error
    }
  }

  private updateBounds(): void {
    if (!this.view || this.win.isDestroyed()) return
    const [width, height] = this.win.getContentSize()
    this.view.setBounds({ x: 0, y: 48, width, height: Math.max(0, height - 48) })
  }

  owns(webContentsId: number): boolean { return this.view?.webContents.id === webContentsId }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.view?.setVisible(visible)
  }

  updateState(snapshot: unknown): void {
    this.state = boundedJson(snapshot, 1024 * 1024)
    // The host publishes only after subscribing to onRequest. Guest scripts may
    // start before React during application startup, so retain their requests.
    this.hostReady = true
    for (const pending of this.pending.values()) {
      if (pending.delivered) continue
      pending.delivered = true
      this.win.webContents.send('interfaces:request', pending.request)
    }
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.send('interface-guest:state', this.guestState())
  }

  private guestState(): unknown {
    if (this.capabilities.includes('library.read') || !this.state || typeof this.state !== 'object') return this.state
    const snapshot = this.state as Record<string, unknown>
    const playback = (snapshot.playback && typeof snapshot.playback === 'object' ? snapshot.playback : {}) as Record<string, unknown>
    const queue = (snapshot.queue && typeof snapshot.queue === 'object' ? snapshot.queue : {}) as Record<string, unknown>
    const primitive = (value: unknown) => ['string', 'number', 'boolean'].includes(typeof value) ? value : null
    return {
      playback: { status: primitive(playback.status), currentTrack: null, positionSec: primitive(playback.positionSec), durationSec: primitive(playback.durationSec), volume: primitive(playback.volume) },
      queue: { tracks: [], total: primitive(queue.total), currentIndex: primitive(queue.currentIndex), shuffle: primitive(queue.shuffle), repeat: primitive(queue.repeat) },
      route: primitive(snapshot.route),
    }
  }

  private authorize(event: IpcMainInvokeEvent): void {
    if (!this.view || event.sender.id !== this.view.webContents.id || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame || !this.guestUrl || event.senderFrame.url.split('#')[0] !== this.guestUrl) {
      throw new Error('Interface SDK caller is not the active top-level interface')
    }
  }

  request(event: IpcMainInvokeEvent, payload: unknown): Promise<unknown> {
    this.authorize(event)
    const now = Date.now()
    this.requestTimes = this.requestTimes.filter(time => time > now - 1000)
    if (this.requestTimes.length >= 60 || this.pending.size >= 32) throw new Error('Interface SDK request rate exceeded')
    this.requestTimes.push(now)
    const request = validateGuestRequest(payload, this.capabilities)
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('Crate did not answer the interface request in time'))
      }, 8000)
      const message: InterfaceGuestRequest = { requestId, ...request }
      this.pending.set(requestId, { request: message, delivered: this.hostReady, resolve, reject, timer })
      if (this.hostReady) this.win.webContents.send('interfaces:request', message)
    })
  }

  respond(response: InterfaceGuestResponse): void {
    if (!response || typeof response !== 'object' || typeof response.requestId !== 'string') throw new Error('Invalid interface SDK response')
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    try {
      if (response.error != null) pending.reject(new Error(String(response.error).slice(0, 1000)))
      else pending.resolve(boundedJson(response.result, 1024 * 1024))
    } catch (error) { pending.reject(error instanceof Error ? error : new Error('Invalid SDK response')) }
  }

  private fail(reason: string): void {
    if (!this.view) return
    this.destroy(true)
    this.failed(reason)
  }

  private cancelPending(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pending.clear()
  }

  private terminateIsolatedGuest(contents: WebContents): void {
    if (contents.isDestroyed()) return
    const guestProcessId = contents.getOSProcessId()
    if (!this.win.isDestroyed()) this.hostProcessId = this.win.webContents.getOSProcessId()
    // A renderer crash is process-wide. Never terminate a process that could
    // contain the trusted host, even when reacting to imported code hanging.
    if (guestProcessId > 0 && this.hostProcessId > 0 && guestProcessId !== this.hostProcessId) {
      contents.forcefullyCrashRenderer()
    }
  }

  destroy(forceTerminate = false): void {
    const view = this.view
    this.view = null
    this.cancelPending('Interface was deactivated')
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline)
    this.heartbeatTimer = null
    this.heartbeatDeadline = null
    this.requestTimes = []
    this.guestUrl = null
    this.capabilities = []
    if (view) {
      if (!this.win.isDestroyed()) this.win.contentView.removeChildView(view)
      const contents = view.webContents
      if (!contents.isDestroyed()) {
        if (forceTerminate) {
          this.terminateIsolatedGuest(contents)
          if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
        } else {
          // Probe before closing: Chromium may mark webContents destroyed while
          // its JavaScript loop is still running, after which forcefullyCrashRenderer
          // is no longer available. Keep a handle until a responsive probe or
          // the deadline establishes whether graceful shutdown is possible.
          let finished = false
          const close = () => {
            if (finished) return
            finished = true
            clearTimeout(deadline)
            if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
          }
          const deadline = setTimeout(() => {
            this.terminateIsolatedGuest(contents)
            close()
          }, 250)
          void contents.executeJavaScript('true').then(close, () => {
            this.terminateIsolatedGuest(contents)
            close()
          })
        }
      }
    }
    if (this.guestSession) {
      this.guestSession.protocol.unhandle('crate-interface')
      this.guestSession.protocol.unhandle('crate')
      void this.guestSession.clearStorageData().catch(() => {})
      this.guestSession = null
    }
  }
}
