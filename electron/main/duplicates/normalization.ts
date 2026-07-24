export interface NormalizedDuplicateTitle {
  original: string
  base: string
  tokens: string[]
  qualifiers: string[]
}

const UNKNOWN_ARTISTS = new Set([
  '',
  'unknown',
  'unknown artist',
  'artista desconocido',
  'artista desconocida',
  'sin artista',
])

const VERSION_MARKERS: Array<[RegExp, string]> = [
  [/\blive\b|\ben vivo\b/i, 'live'],
  [/\bacoustic\b|\bacustic[oa]\b/i, 'acoustic'],
  [/\binstrumental\b/i, 'instrumental'],
  [/\bdemo\b/i, 'demo'],
  [/\bremix(?:ed)?\b/i, 'remix'],
  [/\bremaster(?:ed)?\b|\bremasterizad[oa]\b/i, 'remastered'],
  [/\bradio\s+edit\b/i, 'radio_edit'],
  [/\bsingle\s+(?:edit|version)\b/i, 'single_version'],
  [/\balbum\s+(?:edit|version)\b/i, 'album_version'],
  [/\bextended\s+(?:edit|mix|version)\b/i, 'extended_version'],
  [/\b(?:mono|stereo)\s+(?:mix|version)\b/i, 'mix'],
  [/\b(?:original|alternate|alternative)\s+(?:mix|version)\b/i, 'mix'],
  [/\bedit\b|\bmix\b|\bversion\b|\bversi[oó]n\b/i, 'version'],
]

export function normalizeDuplicateText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function qualifierLabels(fragment: string): string[] {
  const labels: string[] = []
  for (const [pattern, label] of VERSION_MARKERS) {
    if (pattern.test(fragment) && !labels.includes(label)) labels.push(label)
  }
  return labels
}

/**
 * Removes only controlled version/edition suffixes. Parenthetical text that is
 * part of a real title (for example "Part 2") remains in the comparison base.
 */
export function normalizeDuplicateTitle(value: string): NormalizedDuplicateTitle {
  const qualifiers: string[] = []
  let base = value

  base = base.replace(/\s*(?:\(([^)]+)\)|\[([^\]]+)\])/g, (
    whole,
    roundFragment: string | undefined,
    squareFragment: string | undefined,
  ) => {
    const fragment = roundFragment ?? squareFragment ?? ''
    const labels = qualifierLabels(fragment)
    if (labels.length === 0) return whole
    for (const label of labels) if (!qualifiers.includes(label)) qualifiers.push(label)
    return ' '
  })

  const dashSuffix = /\s+(?:-|–|—|:)\s+(.+)$/
  const suffix = dashSuffix.exec(base)
  if (suffix) {
    const labels = qualifierLabels(suffix[1])
    if (labels.length > 0) {
      for (const label of labels) if (!qualifiers.includes(label)) qualifiers.push(label)
      base = base.slice(0, suffix.index)
    }
  }

  const normalizedBase = normalizeDuplicateText(base) || normalizeDuplicateText(value)
  return {
    original: value,
    base: normalizedBase,
    tokens: [...new Set(normalizedBase.split(' ').filter(Boolean))],
    qualifiers,
  }
}

export function normalizePrimaryArtist(value: string | null | undefined): string {
  const first = (value ?? '').split(/\s+(?:feat(?:uring)?\.?|ft\.?)\s+/i, 1)[0]
  return normalizeDuplicateText(first)
}

export function isUnknownArtist(value: string | null | undefined): boolean {
  return UNKNOWN_ARTISTS.has(normalizePrimaryArtist(value))
}

export function diceTokenSimilarity(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0
  const rightTokens = new Set(right)
  let intersection = 0
  for (const token of new Set(left)) if (rightTokens.has(token)) intersection += 1
  return (2 * intersection) / (new Set(left).size + rightTokens.size)
}
