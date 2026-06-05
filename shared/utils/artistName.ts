// Splits compound artist strings such as
//   "Artist A feat. Artist B"
//   "Artist A ft. B"
//   "Artist A & B"
//   "Artist A with B"
//   "Artist A, B & C"
// into a primary artist plus zero or more featured artists.
//
// Single source of truth shared by the main process (artist grouping, the
// normalized `artist_id` foreign key on tracks) and the renderer (display of
// the primary artist plus a "ft. …" line for guests). Keeping one parser here
// guarantees the displayed primary matches the artist the track is grouped by.

export interface ParsedArtistName {
  primary: string
  featured: string[]
}

// Match `feat.`, `ft.`, `featuring`, `with` (preceded by whitespace,
// allow trailing dot, case insensitive).
const FEAT_RE = /\s+(?:feat\.?|ft\.?|featuring|with)\s+/i

// Splits the post-feat tail on common separators: ", ", " & ", " and ".
const TAIL_RE = /\s*(?:,| &amp; | & | and )\s*/i

export function parseArtistName(raw: string): ParsedArtistName {
  const trimmed = raw.trim()
  if (!trimmed) return { primary: '', featured: [] }

  const featSplit = trimmed.split(FEAT_RE)
  let primary = featSplit[0].trim()
  const featuredRaw = featSplit.slice(1).join(' ').trim()

  // If there's no explicit feat marker, check for a leading "&"/", " collaborator
  // we should keep as primary. We prefer to *not* split on plain commas in the
  // primary name to avoid breaking names like "Crosby, Stills & Nash".
  const featured: string[] = []
  if (featuredRaw.length > 0) {
    featuredRaw
      .split(TAIL_RE)
      .map(s => s.trim())
      .filter(Boolean)
      .forEach(name => featured.push(name))
  }

  // Handle a trailing parenthetical on the primary, e.g. "Artist A (feat. B)".
  // If it is itself a feat credit, capture its guests; then strip it either way
  // (also removes non-credit parentheticals like "(Remastered)").
  const parenMatch = primary.match(/\s*\(([^)]*)\)\s*$/)
  if (parenMatch) {
    const innerFeat = parenMatch[1].trim().match(/^(?:feat\.?|ft\.?|featuring|with)\s+(.+)$/i)
    if (innerFeat) {
      innerFeat[1]
        .split(TAIL_RE)
        .map(s => s.trim())
        .filter(Boolean)
        .forEach(name => featured.push(name))
    }
    primary = primary.replace(/\s*\([^)]*\)\s*$/, '').trim()
  }

  return { primary: primary || trimmed, featured }
}

// Prefix for the guest line / title suffix. Change here to swap 'ft.'/'feat.'/'con'.
export const FEATURED_PREFIX = 'ft.'

// "ft. A, B" — empty string when there are no guests.
export function formatFeatured(featured: string[]): string {
  return featured?.length ? `${FEATURED_PREFIX} ${featured.join(', ')}` : ''
}

// Horizontal player: appends "(ft. A, B)" to the track title.
export function titleWithFeatured(title: string, featured: string[]): string {
  const f = formatFeatured(featured)
  return f ? `${title} (${f})` : title
}
