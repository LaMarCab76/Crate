import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  MetadataCompletionApplyResult,
  MetadataCompletionCandidate,
  MetadataCompletionField,
  MetadataCompletionFieldDiff,
  MetadataCompletionPreview,
} from '@shared/types/ipc-contract'
import { applyMetadataCompletions, previewMetadataCompletion } from '@renderer/stores/libraryStore'
import {
  countSelectedFields,
  initialSelection,
  isTrackFullySelected,
  isTrackPartiallySelected,
  keyFor,
  selectionsFromState,
  toggleTrackInSelection,
} from '@renderer/utils/metadataFixSelection'
import { Icon } from '@renderer/components/Icon'

const FIELD_LABELS: Record<MetadataCompletionField, string> = {
  title: 'Título',
  artist: 'Artista',
  album: 'Álbum',
  albumArtist: 'Album artist',
  composer: 'Compositor',
  genre: 'Género',
  year: 'Año',
  trackNumber: 'Track',
  totalTracks: 'Total tracks',
  discNumber: 'Disco',
  totalDiscs: 'Total discos',
  artwork: 'Carátula',
}

const SOURCE_LABELS: Record<string, string> = {
  filename: 'Archivo',
  folder: 'Carpeta',
  musicbrainz: 'MusicBrainz',
  'cover-art-archive': 'Cover Art',
}

function confidenceLabel(value: number): string {
  return `${Math.round(value * 100)}%`
}

function artworkSrc(path: string): string {
  return `crate://artwork/${encodeURIComponent(path)}`
}

// Native checkbox with an indeterminate state (JSX has no `indeterminate` prop).
function TriCheckbox({
  checked,
  indeterminate,
  onChange,
  ariaLabel,
}: {
  checked: boolean
  indeterminate?: boolean
  onChange: (checked: boolean) => void
  ariaLabel?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate) && !checked
  }, [indeterminate, checked])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-label={ariaLabel}
      onChange={event => onChange(event.target.checked)}
    />
  )
}

function TrackCard({
  candidate,
  selected,
  onToggleField,
  onToggleTrack,
}: {
  candidate: MetadataCompletionCandidate
  selected: Set<string>
  onToggleField: (trackId: number, field: MetadataCompletionField, checked: boolean) => void
  onToggleTrack: (candidate: MetadataCompletionCandidate, checked: boolean) => void
}) {
  const fields = candidate.fields
  const artworkKey = keyFor(candidate.trackId, 'artwork')
  const fullySelected = isTrackFullySelected(candidate, selected)
  const partiallySelected = isTrackPartiallySelected(candidate, selected)

  return (
    <div className="metadata-fix-track">
      <div className="metadata-fix-track-head">
        <TriCheckbox
          checked={fullySelected}
          indeterminate={partiallySelected}
          onChange={checked => onToggleTrack(candidate, checked)}
          ariaLabel={`Seleccionar ${candidate.title}`}
        />
        <div className="metadata-fix-track-id">
          <strong>{candidate.title}</strong>
          <span>{candidate.artist} · {candidate.album}</span>
          <em title={candidate.path}>{candidate.path}</em>
        </div>
        <div className="metadata-fix-score">{confidenceLabel(candidate.confidence)}</div>
      </div>

      {candidate.warnings.length > 0 && (
        <div className="metadata-fix-warning">
          {candidate.warnings.map(warning => <div key={warning}>{warning}</div>)}
        </div>
      )}

      <div className="metadata-fix-track-body">
        <div className="metadata-fix-actual">
          {fields.map(field => (
            <div key={field.field} className="metadata-fix-field-row">
              <span className="metadata-fix-field">{FIELD_LABELS[field.field]}</span>
              <span className="metadata-fix-current">{field.current || '—'}</span>
            </div>
          ))}
          {candidate.artwork && (
            <div className="metadata-fix-art-row">
              <span className="metadata-fix-field">{FIELD_LABELS.artwork}</span>
              {candidate.artwork.currentArtworkPath ? (
                <img src={artworkSrc(candidate.artwork.currentArtworkPath)} alt="" />
              ) : (
                <span className="metadata-fix-current">—</span>
              )}
            </div>
          )}
        </div>

        <div className="metadata-fix-proposed">
          {fields.map((field: MetadataCompletionFieldDiff) => {
            const itemKey = keyFor(candidate.trackId, field.field)
            const changed = (field.current ?? '') !== (field.proposed ?? '')
            return (
              <label key={field.field} className={`metadata-fix-field-row${changed ? ' changed' : ''}`}>
                <input
                  type="checkbox"
                  checked={selected.has(itemKey)}
                  onChange={event => onToggleField(candidate.trackId, field.field, event.target.checked)}
                />
                <strong className="metadata-fix-proposed-value">{field.proposed || '—'}</strong>
                <span className="metadata-fix-source">{SOURCE_LABELS[field.source] ?? field.source}</span>
                <span className="metadata-fix-confidence">{confidenceLabel(field.confidence)}</span>
              </label>
            )
          })}
          {candidate.artwork && (
            <label className="metadata-fix-art-row changed">
              <input
                type="checkbox"
                checked={selected.has(artworkKey)}
                onChange={event => onToggleField(candidate.trackId, 'artwork', event.target.checked)}
              />
              <img src={candidate.artwork.proposedDataUrl} alt="" />
              <span className="metadata-fix-source">
                {SOURCE_LABELS[candidate.artwork.source] ?? candidate.artwork.source} · {confidenceLabel(candidate.artwork.confidence)}
              </span>
            </label>
          )}
        </div>
      </div>
    </div>
  )
}

export function MetadataFixView({
  trackIds,
  onDone,
  missingCount,
}: {
  trackIds: number[]
  onDone: () => void
  missingCount?: number
}) {
  const [preview, setPreview] = useState<MetadataCompletionPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<MetadataCompletionApplyResult | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void previewMetadataCompletion(trackIds)
      .then(next => {
        if (cancelled) return
        setPreview(next)
        setSelected(initialSelection(next))
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [trackIds])

  const chosen = useMemo(() => preview ? selectionsFromState(preview, selected) : [], [preview, selected])
  const selectedCount = countSelectedFields(chosen)

  const onToggleField = (trackId: number, field: MetadataCompletionField, checked: boolean) => {
    const itemKey = keyFor(trackId, field)
    setSelected(current => {
      const next = new Set(current)
      if (checked) next.add(itemKey)
      else next.delete(itemKey)
      return next
    })
  }

  const onToggleTrack = (candidate: MetadataCompletionCandidate, checked: boolean) => {
    setSelected(current => toggleTrackInSelection(candidate, current, checked))
  }

  const apply = async () => {
    if (!preview) return
    setSaving(true)
    setError(null)
    setResult(null)
    try {
      const next = await applyMetadataCompletions({
        previewId: preview.previewId,
        selections: chosen,
      })
      setResult(next)
      if (next.failed === 0) onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const candidates = preview?.candidates ?? []
  const failed = result?.results.filter(item => !item.ok) ?? []
  const hasCandidates = candidates.length > 0
  // The banners know how many tracks are missing data (targets); the preview only
  // proposes for some of them. Surface both so "20 faltantes / 1 propuesta" reads honestly.
  const manualCount = missingCount != null ? Math.max(0, missingCount - candidates.length) : 0
  const subtitle = loading
    ? 'Buscando metadatos faltantes…'
    : missingCount != null && missingCount > candidates.length
      ? `${missingCount} con datos faltantes · ${candidates.length} con propuesta automática`
      : `${candidates.length} ${candidates.length === 1 ? 'tema' : 'temas'} con propuesta automática`

  return (
    <div className="metadata-fix">
      <div className="lib-head">
        <div>
          <h1>Completar metadatos</h1>
          <div className="sub">{subtitle}</div>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={onDone} disabled={saving}>Volver</button>
          {!loading && hasCandidates && (
            <button
              type="button"
              className="btn primary"
              disabled={saving || selectedCount === 0}
              onClick={() => { void apply() }}
            >
              {saving ? 'Aplicando…' : `Aplicar ${selectedCount || ''}`}
            </button>
          )}
        </div>
      </div>

      {loading && (
        <div className="metadata-fix-empty">
          <Icon name="rotate" size={18} />
          <span>Buscando metadatos faltantes…</span>
        </div>
      )}

      {!loading && !hasCandidates && (
        <div className="metadata-fix-empty">
          <Icon name="check" size={18} />
          <span>
            {missingCount != null && missingCount > 0
              ? `Ninguno de los ${missingCount} temas con datos faltantes tiene una propuesta automática confiable. Completá los datos a mano desde clic derecho › Editar metadatos…`
              : 'No se encontraron campos confiables para completar.'}
          </span>
        </div>
      )}

      {!loading && hasCandidates && manualCount > 0 && (
        <div className="metadata-fix-note">
          <Icon name="info" size={13} />
          <span>
            {manualCount === 1
              ? '1 tema con datos faltantes no tiene propuesta automática; completalo a mano desde clic derecho › Editar metadatos…'
              : `${manualCount} temas con datos faltantes no tienen propuesta automática; completalos a mano desde clic derecho › Editar metadatos…`}
          </span>
        </div>
      )}

      {!loading && hasCandidates && (
        <>
          <div className="metadata-fix-columns">
            <div className="metadata-fix-col-label">Actual</div>
            <div className="metadata-fix-col-label">Con cambios</div>
          </div>
          <div className="metadata-fix-list">
            {candidates.map(candidate => (
              <TrackCard
                key={candidate.trackId}
                candidate={candidate}
                selected={selected}
                onToggleField={onToggleField}
                onToggleTrack={onToggleTrack}
              />
            ))}
          </div>
        </>
      )}

      {failed.length > 0 && (
        <pre className="modal-error">
          {failed.map(item => `${item.title}: ${item.error}`).join('\n')}
        </pre>
      )}
      {error && <div className="modal-error">{error}</div>}
    </div>
  )
}
