import { createRequire } from 'node:module'
import { join } from 'node:path'

export const CHROMAPRINT_VERSION = '1.6.0'
export const CHROMAPRINT_DEFAULT_ALGORITHM = 1

export function chromaprintLibraryFileName(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'win32': return 'chromaprint.dll'
    case 'linux': return 'libchromaprint.so'
    case 'darwin': return 'libchromaprint.dylib'
    default: throw new Error(`Unsupported Chromaprint platform: ${platform}`)
  }
}

let injectedNativeDirectory: string | null = null

/** Required by an Electron utilityProcess, where the `app` module is absent. */
export function setChromaprintNativeDirectory(directory: string): void {
  injectedNativeDirectory = directory
}

export function chromaprintNativeDirectory(): string {
  if (injectedNativeDirectory) return injectedNativeDirectory
  try {
    const { app } = createRequire(import.meta.url)('electron') as typeof import('electron')
    const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
    return join(base, 'native', 'libs')
  } catch (error) {
    throw new Error(
      'Chromaprint native directory is not configured in this utility process. '
      + 'Call setChromaprintNativeDirectory() during worker initialization.',
      { cause: error },
    )
  }
}

export function chromaprintLibraryPath(): string {
  return join(chromaprintNativeDirectory(), chromaprintLibraryFileName())
}
