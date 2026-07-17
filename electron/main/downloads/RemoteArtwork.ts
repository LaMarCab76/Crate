import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, net } from 'electron'

const MAX_ARTWORK_BYTES = 12 * 1024 * 1024
const ALLOWED_ARTWORK_HOSTS = ['qobuz.com', 'tidal.com']
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])

function sniffImageType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg'
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (bytes.subarray(4, 12).toString('ascii').includes('ftypavif')) return 'image/avif'
  return null
}

function allowedRemoteUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Remote artwork must use HTTPS')
  const host = url.hostname.toLowerCase()
  if (!ALLOWED_ARTWORK_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`))) {
    throw new Error('Remote artwork host is not allowed')
  }
  return url
}

function digest(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export function proxyArtworkUrl(raw: string | null): string | null {
  if (!raw) return null
  try {
    const url = allowedRemoteUrl(raw).href
    const encoded = Buffer.from(url, 'utf8').toString('base64url')
    return `crate://remote-artwork/${digest(url)}/${encoded}`
  } catch {
    return null
  }
}

export async function serveRemoteArtwork(url: URL): Promise<Response> {
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[0])) return new Response('Bad Request', { status: 400 })
  let remote: URL
  try {
    const raw = Buffer.from(parts[1], 'base64url').toString('utf8')
    remote = allowedRemoteUrl(raw)
    if (digest(remote.href) !== parts[0]) throw new Error('Artwork token mismatch')
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  const cacheDir = join(app.getPath('userData'), 'remote-artwork')
  const cachePath = join(cacheDir, parts[0])
  try {
    const cached = await stat(cachePath)
    if (cached.isFile() && cached.size > 0 && cached.size <= MAX_ARTWORK_BYTES) {
      const bytes = await readFile(cachePath)
      const contentType = sniffImageType(bytes)
      if (contentType) return new Response(bytes, { headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' } })
    }
  } catch { /* cache miss */ }

  const response = await net.fetch(remote.href, { redirect: 'follow' })
  if (!response.ok) return new Response('Artwork unavailable', { status: response.status })
  try { allowedRemoteUrl(response.url) } catch { return new Response('Blocked redirect', { status: 403 }) }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) return new Response('Unsupported artwork response', { status: 415 })
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARTWORK_BYTES) {
    return new Response('Artwork is too large', { status: 413 })
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > MAX_ARTWORK_BYTES) return new Response('Artwork is too large', { status: 413 })
  if (sniffImageType(bytes) !== contentType) return new Response('Artwork content does not match its type', { status: 415 })

  await mkdir(cacheDir, { recursive: true })
  const temp = `${cachePath}.tmp-${randomUUID()}`
  try {
    await writeFile(temp, bytes, { flag: 'wx' })
    await rename(temp, cachePath)
  } finally {
    await unlink(temp).catch(() => undefined)
  }
  return new Response(bytes, { headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' } })
}
