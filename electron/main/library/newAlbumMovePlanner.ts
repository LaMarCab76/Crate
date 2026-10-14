import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { sanitizePathPart } from './pathParts.ts'
import { albumMoveFilename, type AlbumMoveDestinationPlan } from './trackAlbumMovePlanner.ts'

// Destination planning for moving a track into an album that does NOT exist in
// the library yet (e.g. the original album of a song downloaded from a
// compilation). Follows the user's own layout when the album artist already has
// albums in this library root, otherwise `<root>/<Album Artist>/<Album>`. Pure:
// loaded directly by node --test.

export type AlbumFolderStyle =
  | 'plain'
  | 'year-dash-title'
  | 'bracket-year-title'
  | 'paren-year-title'
  | 'title-paren-year'
  | 'title-bracket-year'

const STYLE_PATTERNS: Array<[Exclude<AlbumFolderStyle, 'plain'>, RegExp]> = [
  ['year-dash-title', /^\d{4}\s*-\s*\S/],
  ['bracket-year-title', /^\[\d{4}\]\s*\S/],
  ['paren-year-title', /^\(\d{4}\)\s*\S/],
  ['title-paren-year', /\S\s*\(\d{4}\)$/],
  ['title-bracket-year', /\S\s*\[\d{4}\]$/],
]

const DISC_FOLDER = /^(?:cd|disc|disk|disco|d)\s*[-_.]?\s*\d{1,2}$/i

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, { value: string; count: number }>()
  for (const value of values) {
    const key = value.normalize('NFC').toLowerCase()
    const existing = counts.get(key)
    counts.set(key, { value: existing?.value ?? value, count: (existing?.count ?? 0) + 1 })
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))[0]?.value ?? null
}

// The folder that holds an album, given its tracks' paths. Climbs out of
// "CD1"/"Disc 2" subfolders so the album folder (not the disc) is returned.
export function albumDirectoryFromTrackPaths(paths: string[]): string | null {
  const directory = mostCommon(paths.map(path => dirname(path)))
  if (!directory) return null
  return DISC_FOLDER.test(basename(directory)) ? dirname(directory) : directory
}

// The naming convention most of the artist's album folders follow, so a new
// folder looks like its siblings. Needs a strict majority to leave 'plain'.
export function detectAlbumFolderStyle(folderNames: string[]): AlbumFolderStyle {
  if (folderNames.length === 0) return 'plain'
  const counts = new Map<AlbumFolderStyle, number>()
  for (const name of folderNames) {
    const style = STYLE_PATTERNS.find(([, pattern]) => pattern.test(name.trim()))?.[0] ?? 'plain'
    counts.set(style, (counts.get(style) ?? 0) + 1)
  }
  const [style, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return count * 2 > folderNames.length ? style : 'plain'
}

export function newAlbumFolderName(args: { title: string; year: string | null; style: AlbumFolderStyle }): string {
  const title = args.title.trim() || 'Untitled Album'
  const year = /^\d{4}$/.test(args.year ?? '') ? args.year as string : null
  let name = title
  if (year) {
    switch (args.style) {
      case 'year-dash-title': name = `${year} - ${title}`; break
      case 'bracket-year-title': name = `[${year}] ${title}`; break
      case 'paren-year-title': name = `(${year}) ${title}`; break
      case 'title-paren-year': name = `${title} (${year})`; break
      case 'title-bracket-year': name = `${title} [${year}]`; break
      default: break
    }
  }
  return sanitizePathPart(name, 'Untitled Album')
}

export interface NewAlbumDirectoryPlan {
  directory: string
  strategy: 'artist-siblings' | 'artist-folder'
  style: AlbumFolderStyle
}

// Picks the folder for a brand-new album inside `rootPath`. When the album
// artist already has album folders in this root, the new one goes next to them
// (same parent, same naming style); otherwise `<root>/<Album Artist>/<Album>`.
export function chooseNewAlbumDirectory(args: {
  rootPath: string
  albumArtist: string | null
  albumTitle: string
  year: string | null
  artistAlbumDirectories: string[]
}): NewAlbumDirectoryPlan {
  const root = resolve(args.rootPath)
  const siblings = args.artistAlbumDirectories
    .map(directory => resolve(directory))
    .filter(directory => directory !== root && isInside(root, directory))
  const parent = mostCommon(siblings.map(directory => dirname(directory)))
  if (parent && isInside(root, parent)) {
    const siblingNames = siblings.filter(directory => dirname(directory) === parent).map(directory => basename(directory))
    const style = detectAlbumFolderStyle(siblingNames)
    return {
      directory: join(parent, newAlbumFolderName({ title: args.albumTitle, year: args.year, style })),
      strategy: 'artist-siblings',
      style,
    }
  }
  const artistFolder = sanitizePathPart(args.albumArtist ?? '', 'Unknown Artist')
  return {
    directory: join(root, artistFolder, newAlbumFolderName({ title: args.albumTitle, year: args.year, style: 'plain' })),
    strategy: 'artist-folder',
    style: 'plain',
  }
}

export function planNewAlbumDestination(args: {
  directory: string
  sourcePath: string
  title: string
  trackNumber: number
  totalTracks: number | null
  discNumber: number | null
  totalDiscs: number | null
}): AlbumMoveDestinationPlan {
  // A new album is created as a single folder; multi-disc albums get the
  // D<n>- prefix, matching how existing single-folder albums are handled.
  const singleDirectoryMultiDisc = (args.totalDiscs ?? 0) > 1
  const filename = albumMoveFilename({
    title: args.title,
    sourcePath: args.sourcePath,
    trackNumber: args.trackNumber,
    totalTracks: args.totalTracks,
    discNumber: args.discNumber,
    totalDiscs: args.totalDiscs,
    singleDirectoryMultiDisc,
  })
  return {
    directory: args.directory,
    filename,
    destinationPath: join(args.directory, filename),
    usesDiscPrefix: singleDirectoryMultiDisc,
  }
}
