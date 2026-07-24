import type {
  DuplicateAcousticRelation,
  DuplicateAuditionSide,
  DuplicateEditorialRelation,
  DuplicateResolutionAction,
  DuplicateSegment,
  DuplicateSegmentKind,
  DuplicateTrackView,
} from '@shared/types/duplicates'

export type DuplicateSegmentFilter = 'all' | DuplicateSegmentKind

export const DUPLICATE_SEGMENT_FILTER_LABELS: Record<DuplicateSegmentFilter, string> = {
  all: 'Todo',
  match: 'Coincidencias',
  difference: 'Diferencias',
}

export const DUPLICATE_ACOUSTIC_LABELS: Record<DuplicateAcousticRelation, string> = {
  near_identical: 'Casi idénticas',
  possible_different_edition: 'Posible edición o master diferente',
  uncertain: 'Relación incierta',
}

export const DUPLICATE_EDITORIAL_LABELS: Record<DuplicateEditorialRelation, string> = {
  same_release: 'Mismo lanzamiento',
  album_vs_single_ep: 'Álbum frente a single o EP',
  album_vs_compilation: 'Álbum frente a recopilación',
  different_releases: 'Lanzamientos diferentes',
  unknown: 'Lanzamiento desconocido',
}

export function duplicateSimilarityPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  const normalized = value <= 1 ? value * 100 : value
  return Math.max(0, Math.min(100, Math.round(normalized)))
}

/**
 * List actions are phrased in terms of the file the user wants to keep, while
 * the resolution IPC is deliberately phrased in terms of the file to trash.
 * Keep this inversion in one tested helper so a renderer label can never drift
 * away from the destructive action it confirms.
 */
export function duplicateResolutionActionForKeptSide(
  keptSide: DuplicateAuditionSide,
): Extract<DuplicateResolutionAction, 'trash_left' | 'trash_right'> {
  return keptSide === 'left' ? 'trash_right' : 'trash_left'
}

export function filterDuplicateSegments(
  segments: DuplicateSegment[],
  filter: DuplicateSegmentFilter,
): Array<{ segment: DuplicateSegment; index: number }> {
  return segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => filter === 'all' || segment.kind === filter)
}

export function duplicateTimelineDuration(segments: DuplicateSegment[]): number {
  return segments.reduce((duration, segment) => Math.max(duration, segment.endSec), 0)
}

export function duplicateSegmentWidth(segment: DuplicateSegment, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return Math.max(0.75, ((segment.endSec - segment.startSec) / duration) * 100)
}

export function duplicateArtworkSrc(path: string | null): string | null {
  return path ? `crate://artwork/${encodeURIComponent(path)}` : null
}

export function duplicateTrackQuality(track: DuplicateTrackView): string {
  const values = [track.codec || track.format]
  if (track.bitrate) values.push(`${Math.round(track.bitrate / 1000)} kbps`)
  if (track.sampleRate) values.push(`${trimDecimal(track.sampleRate / 1000)} kHz`)
  if (track.bitDepth) values.push(`${track.bitDepth} bit`)
  if (track.channels) values.push(track.channels === 1 ? 'Mono' : track.channels === 2 ? 'Estéreo' : `${track.channels} canales`)
  return values.filter(Boolean).join(' · ') || 'Calidad no disponible'
}

export function duplicateTrackLocation(track: DuplicateTrackView): string {
  return `${track.libraryName} · ${track.provider === 'onedrive' ? 'OneDrive' : 'Local'}`
}

export function duplicateTrackEdition(track: DuplicateTrackView): string {
  const release = track.releaseType?.trim()
  if (track.isCompilation) return release ? `${release} · Recopilación` : 'Recopilación'
  return release || 'Tipo de lanzamiento desconocido'
}

function trimDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '')
}
