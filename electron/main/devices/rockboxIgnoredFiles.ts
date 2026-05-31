export function isRockboxIgnoredEntryName(name: string): boolean {
  return name === '.DS_Store' || name === '__MACOSX' || name.startsWith('._')
}

export function isRockboxIgnoredRelativePath(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .some(part => isRockboxIgnoredEntryName(part))
}
