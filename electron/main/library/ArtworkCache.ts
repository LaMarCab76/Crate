import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let cacheDir: string | null = null

function ensureCacheDir(): string {
  if (cacheDir) return cacheDir
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
