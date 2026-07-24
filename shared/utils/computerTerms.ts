import type { DesktopPlatform } from '../types/library-locations'

export interface ComputerTerms {
  short: 'Mac' | 'PC'
  definite: 'la Mac' | 'la PC'
  destination: 'a la Mac' | 'a la PC'
  library: 'Biblioteca Mac' | 'Biblioteca PC'
}

export function desktopPlatform(value: string): DesktopPlatform {
  if (value === 'darwin' || value === 'macos') return 'macos'
  if (value === 'win32' || value === 'windows') return 'windows'
  return 'linux'
}

export function computerTerms(platform: DesktopPlatform): ComputerTerms {
  return platform === 'macos'
    ? { short: 'Mac', definite: 'la Mac', destination: 'a la Mac', library: 'Biblioteca Mac' }
    : { short: 'PC', definite: 'la PC', destination: 'a la PC', library: 'Biblioteca PC' }
}
