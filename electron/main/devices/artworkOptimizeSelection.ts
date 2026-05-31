import { isAbsolute, relative, resolve } from 'node:path'
import type { DeviceArtworkOptimizationSelection } from '@shared/types/device-sync'

export function keyForArtworkRelativePath(relativePath: string): string {
  return relativePath
    .split('/')
    .filter(Boolean)
    .join('/')
    .normalize('NFC')
    .toLowerCase()
}

export function normalizeArtworkRelativePath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('Invalid artwork relative path')
  if (trimmed.includes('\0') || trimmed.includes('\\')) {
    throw new Error('Invalid artwork relative path')
  }
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) {
    throw new Error('Invalid artwork relative path')
  }

  const segments = trimmed.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('Invalid artwork relative path')
  }

  return segments.join('/').normalize('NFC')
}

export function selectedArtworkRelativePaths(
  selection: DeviceArtworkOptimizationSelection,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of selection.relativePaths) {
    const relativePath = normalizeArtworkRelativePath(raw)
    const key = keyForArtworkRelativePath(relativePath)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(relativePath)
  }
  return out
}

export function resolveArtworkOptimizationFiles(
  musicRoot: string,
  selection: DeviceArtworkOptimizationSelection,
): string[] {
  const root = resolve(musicRoot)
  return selectedArtworkRelativePaths(selection).map(relativePath => {
    const absolutePath = resolve(root, ...relativePath.split('/'))
    const rel = relative(root, absolutePath)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Refusing to optimize artwork outside ${root}`)
    }
    return absolutePath
  })
}
