import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

let cacheDir: string | null = null

// Inject the artwork directory explicitly. Used by the library worker
// (utilityProcess), where Electron's `app` module — and thus
// `app.getPath('userData')` — is unavailable. The main process keeps using the
// lazy `app.getPath` default in ensureCacheDir().
export function setArtworkDir(dir: string): void {
  cacheDir = dir
  mkdirSync(cacheDir, { recursive: true })
}

function ensureCacheDir(): string {
  if (cacheDir) return cacheDir
  // Lazy require keeps `electron` out of the worker bundle's eval path: the
  // worker always calls setArtworkDir() first, so it never reaches this branch.
  // createRequire is needed because the bundle is ESM (no global `require`).
  const { app } = createRequire(import.meta.url)('electron') as typeof import('electron')
  cacheDir = join(app.getPath('userData'), 'artwork')
  mkdirSync(cacheDir, { recursive: true })
  return cacheDir
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/png':  'png',
  'image/gif':  'gif',
  'image/webp': 'webp',
}

function extFromMime(mime: string | undefined): string {
  if (!mime) return 'jpg'
  return EXT_BY_MIME[mime.toLowerCase()] ?? 'jpg'
}

export interface ArtworkSaveResult {
  path: string // absolute file path on disk
  filename: string // just the hashed filename (e.g. "abc123.jpg")
  sha1: string
}

// Stores the picture buffer into userData/artwork/<sha1>.<ext>, returning the
// path. If a file with the same sha1 already exists we skip the write.
export function saveArtwork(picture: Buffer, mime?: string): ArtworkSaveResult {
  const dir = ensureCacheDir()
  const sha1 = createHash('sha1').update(picture).digest('hex')
  const ext = extFromMime(mime)
  const filename = `${sha1}.${ext}`
  const path = join(dir, filename)
  if (!existsSync(path)) {
    writeFileSync(path, picture)
  }
  return { path, filename, sha1 }
}

export function artworkAbsolutePath(filename: string): string {
  return join(ensureCacheDir(), filename)
}
