export function normalizeDeviceMusicRoot(value: string): string {
  const normalized = (value.trim() || '.').split('\\').join('/').replace(/^\/+/, '')
  return normalized || '.'
}

export function isValidDeviceMusicRoot(value: string): boolean {
  return !normalizeDeviceMusicRoot(value).split('/').some(part => part === '..')
}

export function basenameForPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
