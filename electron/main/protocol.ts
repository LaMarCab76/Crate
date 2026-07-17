import { app, net, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getDeviceSyncService } from './devices/DeviceSyncService'
import { serveRemoteArtwork } from './downloads/RemoteArtwork'

// Lets the renderer load cached artwork files via `crate://artwork/<filename>`
// without disabling webSecurity or opening up arbitrary file:// access.
export function registerProtocolSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'crate',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: false,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}

export function registerProtocolHandlers(): void {
  const artworkDir = join(app.getPath('userData'), 'artwork')

  protocol.handle('crate', async request => {
    const url = new URL(request.url)
    // host is the first path segment after crate:// e.g. "artwork".
    if (url.hostname === 'artwork') {
      const filename = decodeURIComponent(url.pathname.replace(/^\//, ''))
      // Prevent path traversal — only allow plain filenames (no slashes, no ..)
      if (filename.includes('/') || filename.includes('..') || filename.length === 0) {
        return new Response('Bad Request', { status: 400 })
      }
      const filePath = join(artworkDir, filename)
      if (!existsSync(filePath)) {
        return new Response('Not Found', { status: 404 })
      }
      return net.fetch(pathToFileURL(filePath).toString())
    }
    if (url.hostname === 'remote-artwork') {
      return serveRemoteArtwork(url)
    }
    if (url.hostname === 'rockbox-theme') {
      let parts: string[]
      try {
        parts = url.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part))
      } catch {
        return new Response('Bad Request', { status: 400 })
      }
      const deviceId = parts.shift()
      const relativePath = parts.join('/')
      if (!deviceId || !relativePath) {
        return new Response('Bad Request', { status: 400 })
      }
      try {
        const filePath = await getDeviceSyncService().rockboxThemeAssetPath(deviceId, relativePath)
        return net.fetch(pathToFileURL(filePath).toString())
      } catch {
        return new Response('Not Found', { status: 404 })
      }
    }
    return new Response('Not Found', { status: 404 })
  })
}
