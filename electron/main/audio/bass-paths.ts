// Platform-aware resolution of the bundled BASS native libraries.
//
// BASS binaries are fetched into native/libs by scripts/fetch-bass.mjs and
// copied to the packaged app by electron-builder. Keep all OS-specific naming
// here so the core, FX, and plugin loaders cannot drift apart.

import { app } from 'electron'
import { join } from 'node:path'

export function bassLibFileName(base: string): string {
  switch (process.platform) {
    case 'win32':
      return `${base}.dll`
    case 'linux':
      return `lib${base}.so`
    default:
      return `lib${base}.dylib`
  }
}

export function bassLibExtension(): string {
  switch (process.platform) {
    case 'win32':
      return '.dll'
    case 'linux':
      return '.so'
    default:
      return '.dylib'
  }
}

export function nativeLibsDir(): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return join(base, 'native', 'libs')
}

export function bassLibPath(base: string): string {
  return join(nativeLibsDir(), bassLibFileName(base))
}
