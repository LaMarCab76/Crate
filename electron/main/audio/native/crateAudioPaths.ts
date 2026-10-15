// Location of libcrate_audio (the FFmpeg + miniaudio engine). Mirrors
// chromaprint-paths.ts so the library can also be loaded from processes that
// have no Electron `app` module.

import { createRequire } from 'node:module'
import { join } from 'node:path'

export function crateAudioLibraryFileName(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'win32': return 'crate_audio.dll'
    case 'linux': return 'libcrate_audio.so'
    case 'darwin': return 'libcrate_audio.dylib'
    default: throw new Error(`Unsupported crate-audio platform: ${platform}`)
  }
}

let injectedNativeDirectory: string | null = null

/** For utility processes and tests, where the `app` module is absent. */
export function setCrateAudioNativeDirectory(directory: string | null): void {
  injectedNativeDirectory = directory
}

export function crateAudioNativeDirectory(): string {
  if (injectedNativeDirectory) return injectedNativeDirectory
  const fromEnv = process.env.CRATE_AUDIO_NATIVE_DIR
  if (fromEnv) return fromEnv
  try {
    const { app } = createRequire(import.meta.url)('electron') as typeof import('electron')
    const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
    return join(base, 'native', 'libs')
  } catch (error) {
    throw new Error(
      'crate-audio native directory is not configured in this process. '
      + 'Call setCrateAudioNativeDirectory() or set CRATE_AUDIO_NATIVE_DIR.',
      { cause: error },
    )
  }
}

export function crateAudioLibraryPath(): string {
  return join(crateAudioNativeDirectory(), crateAudioLibraryFileName())
}
