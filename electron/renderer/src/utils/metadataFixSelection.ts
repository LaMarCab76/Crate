import type {
  MetadataCompletionCandidate,
  MetadataCompletionField,
  MetadataCompletionPreview,
  MetadataCompletionSelection,
} from '@shared/types/ipc-contract'

// Selection keys identify one editable field on one track: `${trackId}:${field}`.
// The `artwork` pseudo-field uses the same scheme so it can live in the same Set.
export function keyFor(trackId: number, field: MetadataCompletionField): string {
  return `${trackId}:${field}`
}

// Every toggleable key for a candidate: each proposed field plus artwork when present.
export function trackKeys(candidate: MetadataCompletionCandidate): string[] {
  const keys = candidate.fields.map(field => keyFor(candidate.trackId, field.field))
  if (candidate.artwork) keys.push(keyFor(candidate.trackId, 'artwork'))
  return keys
}

// The pre-checked keys the preview suggests (fields/artwork flagged `selected`).
export function initialSelection(preview: MetadataCompletionPreview): Set<string> {
  const next = new Set<string>()
  for (const candidate of preview.candidates) {
    for (const field of candidate.fields) {
      if (field.selected) next.add(keyFor(candidate.trackId, field.field))
    }
    if (candidate.artwork?.selected) next.add(keyFor(candidate.trackId, 'artwork'))
  }
  return next
}

// Map the flat key Set back into the per-track selection the apply IPC expects,
// dropping tracks with nothing checked.
export function selectionsFromState(
  preview: MetadataCompletionPreview,
  selected: Set<string>,
): MetadataCompletionSelection[] {
  return preview.candidates
    .map(candidate => {
      const fields: MetadataCompletionField[] = []
      for (const field of candidate.fields) {
        if (selected.has(keyFor(candidate.trackId, field.field))) fields.push(field.field)
      }
      if (candidate.artwork && selected.has(keyFor(candidate.trackId, 'artwork'))) fields.push('artwork')
      return { trackId: candidate.trackId, fields }
    })
    .filter(selection => selection.fields.length > 0)
}

export function isTrackFullySelected(
  candidate: MetadataCompletionCandidate,
  selected: Set<string>,
): boolean {
  const keys = trackKeys(candidate)
  return keys.length > 0 && keys.every(key => selected.has(key))
}

export function isTrackPartiallySelected(
  candidate: MetadataCompletionCandidate,
  selected: Set<string>,
): boolean {
  const keys = trackKeys(candidate)
  const chosen = keys.filter(key => selected.has(key)).length
  return chosen > 0 && chosen < keys.length
}

// Toggle every key of a candidate at once. Returns a new Set (never mutates the input).
export function toggleTrackInSelection(
  candidate: MetadataCompletionCandidate,
  selected: Set<string>,
  checked: boolean,
): Set<string> {
  const next = new Set(selected)
  for (const key of trackKeys(candidate)) {
    if (checked) next.add(key)
    else next.delete(key)
  }
  return next
}

export function countSelectedFields(selections: MetadataCompletionSelection[]): number {
  return selections.reduce((sum, selection) => sum + selection.fields.length, 0)
}
