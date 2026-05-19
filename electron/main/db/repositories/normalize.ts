// Shared text-normalization helpers used by getOrCreate methods across all
// normalized-entity repositories (artists, albums, genres).

export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

const SORT_PREFIXES = /^(the|a|an|el|la|los|las|le|les|der|die|das)\s+/i

export function sortKey(name: string): string {
  return name.replace(SORT_PREFIXES, '').trim()
}
