import { useEffect, useMemo, useState } from 'react'
import type {
  MetadataCompletionApplyResult,
  MetadataCompletionCandidate,
  MetadataCompletionField,
  MetadataCompletionFieldDiff,
  MetadataCompletionPreview,
} from '@shared/types/ipc-contract'
import { applyMetadataCompletions, previewMetadataCompletion } from '@renderer/stores/libraryStore'
import { Icon } from './Icon'
import { ModalShell } from './ModalShell'

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

function keyFor(trackId: number, field: MetadataCompletionField): string {
  return `${trackId}:${field}`
}

function confidenceLabel(value: number): string {
  return `${Math.round(value * 100)}%`
}

function fieldSummary(field: MetadataCompletionFieldDiff) {
  return (
    <div className="meta-complete-values">
      <span>{field.current || '-'}</span>
      <Icon name="fwd" size={12} />
      <strong>{field.proposed || '-'}</strong>
    </div>
  )
}

function CandidateCard({
  candidate,
  selected,
  onToggle,
}: {
  candidate: MetadataCompletionCandidate
  selected: Set<string>
  onToggle: (trackId: number, field: MetadataCompletionField, checked: boolean) => void
}) {
  const rows = candidate.fields
  const artworkKey = keyFor(candidate.trackId, 'artwork')
  return (
    <div className="meta-complete-card">
      <div className="meta-complete-card-head">
        <div className="meta-complete-track">
          <strong>{candidate.title}</strong>
          <span>{candidate.artist} · {candidate.album}</span>
          <em title={candidate.path}>{candidate.path}</em>
        </div>
        <div className="meta-complete-score">{confidenceLabel(candidate.confidence)}</div>
      </div>

      {candidate.warnings.length > 0 && (
        <div className="meta-complete-warning">
          {candidate.warnings.map(warning => <div key={warning}>{warning}</div>)}
        </div>
      )}

      {rows.length > 0 && (
        <div className="meta-complete-fields">
          {rows.map(field => {
            const itemKey = keyFor(candidate.trackId, field.field)
            return (
              <label key={itemKey} className="meta-complete-row">
                <input
                  type="checkbox"
                  checked={selected.has(itemKey)}
                  onChange={event => onToggle(candidate.trackId, field.field, event.target.checked)}
                />
                <span className="meta-complete-field">{FIELD_LABELS[field.field]}</span>
                {fieldSummary(field)}
                <span className="meta-complete-source">{SOURCE_LABELS[field.source]}</span>
                <span className="meta-complete-confidence">{confidenceLabel(field.confidence)}</span>
              </label>
            )
          })}
        </div>
      )}

      {candidate.artwork && (
        <label className="meta-complete-artwork">
          <input
            type="checkbox"
            checked={selected.has(artworkKey)}
            onChange={event => onToggle(candidate.trackId, 'artwork', event.target.checked)}
          />
          <img src={candidate.artwork.proposedDataUrl} alt="" />
          <div>
            <strong>{FIELD_LABELS.artwork}</strong>
            <span>{SOURCE_LABELS[candidate.artwork.source]} · {confidenceLabel(candidate.artwork.confidence)}</span>
          </div>
        </label>
      )}
    </div>
  )
}

function initialSelection(preview: MetadataCompletionPreview): Set<string> {
  const next = new Set<string>()
  for (const candidate of preview.candidates) {
    for (const field of candidate.fields) {
      if (field.selected) next.add(keyFor(candidate.trackId, field.field))
    }
    if (candidate.artwork?.selected) next.add(keyFor(candidate.trackId, 'artwork'))
  }
  return next
}

function selectionsFromState(preview: MetadataCompletionPreview, selected: Set<string>) {
  return preview.candidates.map(candidate => {
    const fields: MetadataCompletionField[] = []
    for (const field of candidate.fields) {
      if (selected.has(keyFor(candidate.trackId, field.field))) fields.push(field.field)
    }
    if (candidate.artwork && selected.has(keyFor(candidate.trackId, 'artwork'))) fields.push('artwork')
    return { trackId: candidate.trackId, fields }
  }).filter(selection => selection.fields.length > 0)
}

export function MetadataCompletionModal({
  trackIds,
  onClose,
}: {
  trackIds: number[]
  onClose: () => void
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
  const selectedCount = chosen.reduce((sum, item) => sum + item.fields.length, 0)

  const onToggle = (trackId: number, field: MetadataCompletionField, checked: boolean) => {
    const itemKey = keyFor(trackId, field)
    setSelected(current => {
      const next = new Set(current)
      if (checked) next.add(itemKey)
      else next.delete(itemKey)
      return next
    })
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
      if (next.failed === 0) onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const failed = result?.results.filter(item => !item.ok) ?? []

  return (
    <ModalShell
      title="Completar metadatos"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancelar</button>
          {!loading && (
            <button
              type="button"
              className="btn primary"
              disabled={saving || !preview || preview.candidates.length === 0 || selectedCount === 0}
              onClick={() => { void apply() }}
            >
              {saving ? 'Aplicando...' : `Aplicar ${selectedCount || ''}`}
            </button>
          )}
        </>
      )}
    >
      <div className="meta-complete-modal">
        {loading && (
          <div className="meta-complete-empty">
            <Icon name="rotate" size={18} />
            <span>Buscando metadatos faltantes...</span>
          </div>
        )}

        {!loading && preview && preview.candidates.length === 0 && (
          <div className="meta-complete-empty">
            <Icon name="check" size={18} />
            <span>No se encontraron campos confiables para completar.</span>
          </div>
        )}

        {!loading && preview && preview.candidates.length > 0 && (
          <>
            <p className="modal-copy">
              Revisá los campos propuestos antes de escribirlos en los archivos. Solo se aplican las casillas marcadas.
            </p>
            <div className="meta-complete-list">
              {preview.candidates.map(candidate => (
                <CandidateCard
                  key={candidate.trackId}
                  candidate={candidate}
                  selected={selected}
                  onToggle={onToggle}
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
    </ModalShell>
  )
}
