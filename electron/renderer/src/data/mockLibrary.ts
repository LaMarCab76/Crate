import type { Album, Artist, Library, Pattern, Playlist, Track } from '@shared/types/library'

// Sample library data for the UI shell. Replaced by SQLite-backed queries
// once the data layer is built. Port of /tmp/hifidelity-design/hifidelity/project/data.js.

type AlbumSeed = Omit<Album, 'tracks'> & { tracks: Array<Omit<Track, 'id' | 'albumId' | 'albumTitle' | 'artist' | 'artistId' | 'year' | 'genre' | 'no' | 'added' | 'loved'>> }

const albumSeeds: AlbumSeed[] = [
  {
    id: 'a1', title: 'Northern Drift', artist: 'Akari Solano', year: 2024,
    seed: 11, palette: ['#0e2540', '#3a6ea5', '#a3c4dc'], pattern: 'circles', genre: 'Electronic',
    tracks: [
      { t: 'Polar Halflight',     d: 224, fmt: 'FLAC', q: '24/96',  plays: 142 },
      { t: 'Cold Cartography',    d: 198, fmt: 'FLAC', q: '24/96',  plays: 88 },
      { t: 'Aurora Loop',         d: 312, fmt: 'FLAC', q: '24/96',  plays: 211 },
      { t: 'Glaciers, Slowly',    d: 247, fmt: 'FLAC', q: '24/96',  plays: 64 },
      { t: 'Solano, OR',          d: 188, fmt: 'FLAC', q: '24/96',  plays: 33 },
      { t: 'Drift (Reprise)',     d: 273, fmt: 'FLAC', q: '24/96',  plays: 19 },
    ],
  },
  {
    id: 'a2', title: 'Halcyon Days', artist: 'The Velour Sound', year: 2023,
    seed: 27, palette: ['#3b1f1a', '#8c4536', '#e0b994'], pattern: 'sun', genre: 'Indie Rock',
    tracks: [
      { t: 'Pacific Tide',        d: 215, fmt: 'M4A',  q: 'AAC 256', plays: 412 },
      { t: 'Halcyon Days',        d: 244, fmt: 'M4A',  q: 'AAC 256', plays: 1208 },
      { t: 'Cassette Heart',      d: 188, fmt: 'M4A',  q: 'AAC 256', plays: 67 },
      { t: 'Backroad Forever',    d: 263, fmt: 'M4A',  q: 'AAC 256', plays: 245 },
      { t: 'July, Slowly',        d: 199, fmt: 'M4A',  q: 'AAC 256', plays: 154 },
    ],
  },
  {
    id: 'a3', title: 'Slow Light', artist: 'Marisol Vance', year: 2025,
    seed: 41, palette: ['#1b1610', '#6e4f2e', '#d8b06a'], pattern: 'rays', genre: 'Singer-Songwriter',
    tracks: [
      { t: 'Slow Light',          d: 252, fmt: 'FLAC', q: '24/88',  plays: 31 },
      { t: 'A Long Vermont',      d: 281, fmt: 'FLAC', q: '24/88',  plays: 9 },
      { t: 'Witness',             d: 192, fmt: 'FLAC', q: '24/88',  plays: 17 },
      { t: 'Plain Lantern',       d: 304, fmt: 'FLAC', q: '24/88',  plays: 4 },
    ],
  },
  {
    id: 'a4', title: 'Plateau', artist: 'Glass Architecture', year: 2022,
    seed: 7, palette: ['#0c1014', '#293541', '#7c95ad'], pattern: 'grid', genre: 'Ambient',
    tracks: [
      { t: 'Mesa I',              d: 412, fmt: 'FLAC', q: '24/96',  plays: 78 },
      { t: 'Mesa II',             d: 388, fmt: 'FLAC', q: '24/96',  plays: 65 },
      { t: 'Pasajero',            d: 502, fmt: 'FLAC', q: '24/96',  plays: 41 },
      { t: 'Untitled (Plateau)',  d: 622, fmt: 'FLAC', q: '24/96',  plays: 22 },
    ],
  },
  {
    id: 'a5', title: 'Quiet Cartography', artist: 'Nora Engel', year: 2024,
    seed: 33, palette: ['#102a23', '#3b6e5c', '#bfdcc8'], pattern: 'wave', genre: 'Folk',
    tracks: [
      { t: 'Maps for Strangers',  d: 218, fmt: 'M4A',  q: 'ALAC',    plays: 91 },
      { t: 'Hotel Rooms',         d: 244, fmt: 'M4A',  q: 'ALAC',    plays: 58 },
      { t: 'A Field in October',  d: 271, fmt: 'M4A',  q: 'ALAC',    plays: 122 },
      { t: 'Engel & I',           d: 199, fmt: 'M4A',  q: 'ALAC',    plays: 38 },
    ],
  },
  {
    id: 'a6', title: 'Heatwave EP', artist: 'Tape Phantoms', year: 2025,
    seed: 19, palette: ['#3a0a13', '#a3253a', '#fbb5a3'], pattern: 'stripes', genre: 'Synthwave',
    tracks: [
      { t: 'Hood Ornament',       d: 188, fmt: 'MP3',  q: '320k',    plays: 533 },
      { t: 'Heatwave',            d: 244, fmt: 'MP3',  q: '320k',    plays: 812 },
      { t: 'Carlos & Pearl',      d: 211, fmt: 'MP3',  q: '320k',    plays: 145 },
    ],
  },
  {
    id: 'a7', title: 'Static Bloom', artist: 'Hannes & The Lakes', year: 2021,
    seed: 5, palette: ['#1f1733', '#5b3c8f', '#c8b3e8'], pattern: 'rings', genre: 'Dream Pop',
    tracks: [
      { t: 'Static Bloom',        d: 268, fmt: 'FLAC', q: '24/48',   plays: 322 },
      { t: 'Ohio, Almost Spring', d: 314, fmt: 'FLAC', q: '24/48',   plays: 188 },
      { t: 'The Lakes',           d: 245, fmt: 'FLAC', q: '24/48',   plays: 92 },
      { t: 'Pollen Light',        d: 277, fmt: 'FLAC', q: '24/48',   plays: 64 },
      { t: 'Hannes, A Confession',d: 198, fmt: 'FLAC', q: '24/48',   plays: 33 },
    ],
  },
  {
    id: 'a8', title: 'Folio', artist: 'Eduardo Pareja', year: 2023,
    seed: 47, palette: ['#241a0d', '#7d5524', '#e5c47a'], pattern: 'half', genre: 'Jazz',
    tracks: [
      { t: 'Reflejo en Re',       d: 388, fmt: 'FLAC', q: '24/96',   plays: 102 },
      { t: 'Pequeño Folio',       d: 257, fmt: 'FLAC', q: '24/96',   plays: 71 },
      { t: 'Carta a Pareja',      d: 422, fmt: 'FLAC', q: '24/96',   plays: 54 },
      { t: 'Septiembre',          d: 319, fmt: 'FLAC', q: '24/96',   plays: 38 },
    ],
  },
  {
    id: 'a9', title: 'Midnight Cargo', artist: 'Atrium Six', year: 2024,
    seed: 13, palette: ['#0a1a25', '#1f4a70', '#9bb8d4'], pattern: 'diag', genre: 'Post-Rock',
    tracks: [
      { t: 'Container 14',        d: 412, fmt: 'FLAC', q: '24/96',   plays: 211 },
      { t: 'Crane Light',         d: 277, fmt: 'FLAC', q: '24/96',   plays: 145 },
      { t: 'Pier Six, 4 AM',      d: 528, fmt: 'FLAC', q: '24/96',   plays: 88 },
    ],
  },
  {
    id: 'a10', title: 'Petrichor', artist: 'Lior Mendelsohn', year: 2025,
    seed: 23, palette: ['#142016', '#4b6f54', '#bcd1be'], pattern: 'circles', genre: 'Classical',
    tracks: [
      { t: 'Petrichor I',         d: 312, fmt: 'FLAC', q: '24/192',  plays: 19 },
      { t: 'Petrichor II',        d: 388, fmt: 'FLAC', q: '24/192',  plays: 14 },
      { t: 'For Mendelsohn',      d: 522, fmt: 'FLAC', q: '24/192',  plays: 8 },
      { t: 'Aria, in Rain',       d: 412, fmt: 'FLAC', q: '24/192',  plays: 22 },
    ],
  },
  {
    id: 'a11', title: 'Riverbend', artist: 'June Atlas', year: 2022,
    seed: 37, palette: ['#1c1a12', '#7a6a3a', '#dcd0a3'], pattern: 'sun', genre: 'Indie Folk',
    tracks: [
      { t: 'Riverbend',           d: 232, fmt: 'M4A',  q: 'ALAC',    plays: 444 },
      { t: 'Atlas Heart',         d: 254, fmt: 'M4A',  q: 'ALAC',    plays: 312 },
      { t: 'June, Or Maybe May',  d: 198, fmt: 'M4A',  q: 'ALAC',    plays: 188 },
    ],
  },
  {
    id: 'a12', title: 'Linework', artist: 'Sora Bell', year: 2024,
    seed: 9, palette: ['#1d1a1d', '#5e5560', '#cfc6d2'], pattern: 'lines', genre: 'Electronic',
    tracks: [
      { t: 'Linework I',          d: 244, fmt: 'FLAC', q: '24/96',   plays: 312 },
      { t: 'Linework II',         d: 278, fmt: 'FLAC', q: '24/96',   plays: 256 },
      { t: 'Bell, In Reverse',    d: 198, fmt: 'FLAC', q: '24/96',   plays: 144 },
      { t: 'Endsheet',            d: 322, fmt: 'FLAC', q: '24/96',   plays: 88 },
    ],
  },
]

let trackCounter = 1
const albums: Album[] = albumSeeds.map((al, ai) => {
  const filledTracks: Track[] = al.tracks.map((tr, ti) => ({
    ...tr,
    id: `t${trackCounter++}`,
    albumId: al.id,
    albumTitle: al.title,
    artist: al.artist,
    artistId: `ar${ai}`,
    year: al.year,
    genre: al.genre,
    no: ti + 1,
    added: `Apr ${10 + ((ti + ai) % 18)}, 2025`,
    loved: trackCounter % 5 === 0,
  }))
  return { ...al, tracks: filledTracks }
})

const tracks: Track[] = albums.flatMap(a => a.tracks)

const artistMap: Record<string, Artist> = {}
albums.forEach((a, ai) => {
  if (!artistMap[a.artist]) {
    artistMap[a.artist] = {
      id: `ar${Object.keys(artistMap).length}`,
      name: a.artist,
      albums: [],
      seed: a.seed,
      palette: a.palette,
      pattern: a.pattern,
      bio: `${a.artist} — ${a.genre.toLowerCase()} act. Files curated from your local library.`,
    }
  }
  artistMap[a.artist].albums.push(a)
})
const artists: Artist[] = Object.values(artistMap)

const playlists: Playlist[] = [
  { id: 'p1', name: 'Late Sessions',     count: 28, kind: 'manual', icon: 'moon',
    desc: 'Slow ambient & jazz for night writing.',
    tracks: [tracks[0], tracks[10], tracks[28], tracks[33], tracks[5], tracks[16], tracks[23], tracks[39]].filter(Boolean) },
  { id: 'p2', name: 'Driving / Coastal', count: 41, kind: 'manual', icon: 'car',
    tracks: [tracks[6], tracks[7], tracks[20], tracks[21], tracks[22]].filter(Boolean) },
  { id: 'p3', name: 'Recently Added',    count: 67, kind: 'smart',  icon: 'sparkle',
    tracks: tracks.slice(0, 12) },
  { id: 'p4', name: 'High-Res Only',     count: 89, kind: 'smart',  icon: 'wave',
    desc: 'Auto: format is FLAC and bit depth ≥ 24',
    tracks: tracks.filter(t => t.fmt === 'FLAC').slice(0, 12) },
  { id: 'p5', name: 'Weekly Rotation',   count: 22, kind: 'manual', icon: 'rotate',
    tracks: tracks.slice(8, 22) },
  { id: 'p6', name: 'Pareja & Friends',  count: 18, kind: 'manual', icon: 'note',
    tracks: tracks.filter(t => ['Jazz', 'Classical'].includes(t.genre)) },
  { id: 'p7', name: 'Loved Songs',       count: tracks.filter(t => t.loved).length, kind: 'smart', icon: 'heart',
    tracks: tracks.filter(t => t.loved) },
]

const nowPlayingTrack = tracks.find(t => t.t === 'Halcyon Days') ?? tracks[7]

export const mockLibrary: Library = {
  albums,
  tracks,
  artists,
  playlists,
  nowPlaying: {
    track: nowPlayingTrack,
    progress: 0.42,
    volume: 0.7,
    queue: [tracks[8], tracks[9], tracks[11], tracks[12], tracks[14], tracks[15]].filter(Boolean),
    history: [tracks[2], tracks[3], tracks[18]].filter(Boolean),
  },
  stats: {
    tracks: tracks.length,
    albums: albums.length,
    artists: artists.length,
    hours: Math.round(tracks.reduce((s, t) => s + t.d, 0) / 360) / 10,
  },
}

// Type alias kept for compatibility with the design's window.LIBRARY use.
export type MockLibrary = typeof mockLibrary

// Suppress unused-import warning for the Pattern type while shared types stabilise.
export type _Pattern = Pattern
