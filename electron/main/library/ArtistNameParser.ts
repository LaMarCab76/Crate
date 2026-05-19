// Splits compound artist strings such as
//   "Artist A feat. Artist B"
//   "Artist A ft. B"
//   "Artist A & B"
//   "Artist A with B"
//   "Artist A, B & C"
// into a primary artist plus zero or more featured artists. For Session 2 we
// only use `primary` to drive the normalized `artist_id` foreign key on tracks;
// featured artists are kept in `featured` for a later phase that introduces
// a `track_featured_artists` junction table.

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
  let featuredRaw = featSplit.slice(1).join(' ').trim()

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

  // Strip trailing parenthetical credits from primary, e.g. "Artist A (feat. B)".
  primary = primary.replace(/\s*\([^)]*\)\s*$/, '').trim()

  return { primary: primary || trimmed, featured }
}
