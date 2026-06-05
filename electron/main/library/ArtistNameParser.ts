// The artist-name parser now lives in a shared module so the renderer can use
// the exact same logic to display the primary artist + featured guests. This
// file is kept as a thin re-export to avoid touching every main-process import.
export type { ParsedArtistName } from '@shared/utils/artistName'
export { parseArtistName } from '@shared/utils/artistName'
