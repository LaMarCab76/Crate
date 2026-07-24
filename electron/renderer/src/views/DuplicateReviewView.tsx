import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  DuplicateAuditionSide,
  DuplicateAuditionState,
  DuplicateCandidateDetail,
  DuplicateCandidateSummary,
  DuplicateKeepBothReason,
  DuplicateSegment,
  DuplicateTrackView,
} from '@shared/types/duplicates'
import { Icon } from '@renderer/components/Icon'
import { ModalShell } from '@renderer/components/ModalShell'
import { useDuplicateStore } from '@renderer/stores/duplicateStore'
import { fmtFileSize, fmtTime } from '@renderer/utils/format'
import {
  DUPLICATE_ACOUSTIC_LABELS,
  DUPLICATE_EDITORIAL_LABELS,
  DUPLICATE_SEGMENT_FILTER_LABELS,
  duplicateArtworkSrc,
  duplicateSegmentWidth,
  duplicateSimilarityPercent,
  duplicateTimelineDuration,
  duplicateTrackEdition,
  duplicateTrackLocation,
  duplicateTrackQuality,
  filterDuplicateSegments,
  type DuplicateSegmentFilter,
} from '@renderer/utils/duplicateReview'

type TrackFieldKey = 'album' | 'albumArtist' | 'edition' | 'year' | 'duration' | 'track' | 'quality' | 'size' | 'location' | 'path'

interface TrackField {
  key: TrackFieldKey
  label: string
  value: string
}

interface TrashDecision {
  candidate: DuplicateCandidateSummary
  trashSide: DuplicateAuditionSide
  source: 'list' | 'detail'
  listIndex: number | null
}

function trackFields(track: DuplicateTrackView): TrackField[] {
  const discTrack = [
    track.discNumber ? `Disco ${track.discNumber}` : null,
    track.trackNumber ? `Pista ${track.trackNumber}` : null,
  ].filter(Boolean).join(' · ') || '—'
  return [
    { key: 'album', label: 'Álbum', value: track.album || '—' },
    { key: 'albumArtist', label: 'Artista del álbum', value: track.albumArtist || '—' },
    { key: 'edition', label: 'Edición', value: duplicateTrackEdition(track) },
    { key: 'year', label: 'Año', value: track.year || '—' },
    { key: 'duration', label: 'Duración', value: fmtTime(track.duration) },
    { key: 'track', label: 'Ubicación en álbum', value: discTrack },
    { key: 'quality', label: 'Calidad', value: duplicateTrackQuality(track) },
    { key: 'size', label: 'Tamaño', value: fmtFileSize(track.fileSize) },
    { key: 'location', label: 'Biblioteca', value: duplicateTrackLocation(track) },
    { key: 'path', label: 'Archivo', value: track.path },
  ]
}

function changedFieldKeys(left: DuplicateTrackView, right: DuplicateTrackView): Set<TrackFieldKey> {
  const leftFields = new Map(trackFields(left).map(field => [field.key, field.value]))
  return new Set(
    trackFields(right)
      .filter(field => leftFields.get(field.key) !== field.value)
      .map(field => field.key),
  )
}

function scoreText(score: number): string {
  return `${duplicateSimilarityPercent(score)}%`
}

function TrackArtwork({ track }: { track: DuplicateTrackView }) {
  const src = duplicateArtworkSrc(track.artworkPath)
  return src ? (
    <img className="duplicate-track-art" src={src} alt={`Carátula de ${track.album}`} />
  ) : (
    <div className="duplicate-track-art duplicate-track-art-placeholder" aria-hidden="true">
      <Icon name="album" size={34} />
    </div>
  )
}

function DuplicateListArtwork({ track }: { track: DuplicateTrackView }) {
  const src = duplicateArtworkSrc(track.artworkPath)
  return src ? (
    <img className="duplicate-list-art" src={src} alt="" />
  ) : (
    <span className="duplicate-list-art duplicate-list-art-placeholder" aria-hidden="true">
      <Icon name="album" size={20} />
    </span>
  )
}

function DuplicateCandidateList({
  candidates,
  selectedIndex,
  opening,
  resolvingCandidateId,
  selectedChoice,
  listRef,
  onOpen,
  onKeep,
}: {
  candidates: DuplicateCandidateSummary[]
  selectedIndex: number
  opening: boolean
  resolvingCandidateId: string | null
  selectedChoice: { candidateId: string; side: DuplicateAuditionSide } | null
  listRef: RefObject<HTMLElement>
  onOpen: (candidateId: string) => void
  onKeep: (candidateId: string, side: DuplicateAuditionSide) => void
}) {
  const openingId = opening ? candidates[selectedIndex]?.id : null
  const locked = opening || Boolean(resolvingCandidateId)

  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLOListElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLLIElement>('.duplicate-candidate-row'),
    )
    if (rows.length === 0) return
    const currentRow = (event.target as HTMLElement).closest<HTMLLIElement>('.duplicate-candidate-row')
    const current = currentRow ? rows.indexOf(currentRow) : -1
    if (current < 0) return
    const listAction = (event.target as HTMLElement)
      .closest<HTMLButtonElement>('button[data-list-action]')
      ?.dataset.listAction
    if (!listAction) return
    event.preventDefault()
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rows.length - 1
        : event.key === 'ArrowDown'
          ? Math.min(rows.length - 1, current + 1)
          : Math.max(0, current - 1)
    rows[next]
      ?.querySelector<HTMLButtonElement>(`button[data-list-action="${listAction}"]:not(:disabled)`)
      ?.focus()
  }

  return (
    <section ref={listRef} className="duplicate-candidate-list-panel" aria-labelledby="duplicate-list-title" aria-busy={locked}>
      <header className="duplicate-list-head">
        <div>
          <h2 id="duplicate-list-title">Pendientes de revisión</h2>
          <p>Elegí qué tema conservar directamente o abrí la comparación para escuchar ambos archivos.</p>
        </div>
        <span aria-label={`${candidates.length} comparaciones pendientes`}>
          <strong>{candidates.length.toLocaleString()}</strong>
          {candidates.length === 1 ? ' caso' : ' casos'}
        </span>
      </header>
      <div className="duplicate-list-columns" aria-hidden="true">
        <span />
        <span>Posible copia</span>
        <span>Comparación</span>
        <span>Recomendado conservar</span>
        <span />
      </div>
      <ol className="duplicate-candidate-list" onKeyDown={handleListKeyDown}>
        {candidates.map((candidate, index) => {
          const isOpening = candidate.id === openingId
          const isResolving = candidate.id === resolvingCandidateId
          const selectedSide = selectedChoice?.candidateId === candidate.id
            ? selectedChoice.side
            : null
          return (
            <li
              key={candidate.id}
              className={`duplicate-candidate-row ${isOpening ? 'is-opening' : ''} ${isResolving ? 'is-resolving' : ''}`}
              aria-busy={isOpening || isResolving}
              onClick={event => {
                if (locked || (event.target as HTMLElement).closest('button')) return
                onOpen(candidate.id)
              }}
            >
              <span className="duplicate-list-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <div className="duplicate-list-track-cell">
                <button
                  type="button"
                  className={`duplicate-list-track-choice ${selectedSide === 'left' ? 'is-selected' : ''}`}
                  data-list-action="keep-left"
                  onClick={() => onKeep(candidate.id, 'left')}
                  disabled={locked}
                  aria-pressed={selectedSide === 'left'}
                  aria-haspopup="dialog"
                  aria-label={`Conservar ${candidate.left.title}, de ${candidate.left.album || 'álbum desconocido'}, y enviar ${candidate.right.title}, de ${candidate.right.album || 'álbum desconocido'}, a la Papelera`}
                >
                  <span className="duplicate-list-artwork">
                    <DuplicateListArtwork track={candidate.left} />
                    {selectedSide === 'left' && (
                      <span className="duplicate-list-selection-mark" aria-hidden="true">
                        <Icon name="check" size={11} />
                      </span>
                    )}
                  </span>
                  <span className="duplicate-list-track-copy">
                    <strong>{candidate.left.title}</strong>
                    <span>{candidate.left.artist}</span>
                    <small>{candidate.left.album || 'Álbum desconocido'} · {fmtTime(candidate.left.duration)}</small>
                  </span>
                </button>
              </div>
              <span className="duplicate-list-relation">
                <strong>{scoreText(candidate.similarity)}</strong>
                <span>{DUPLICATE_ACOUSTIC_LABELS[candidate.acousticRelation]}</span>
                <small>{DUPLICATE_EDITORIAL_LABELS[candidate.editorialRelation]}</small>
              </span>
              <div className="duplicate-list-track-cell recommended">
                <button
                  type="button"
                  className={`duplicate-list-track-choice recommended ${selectedSide === 'right' ? 'is-selected' : ''}`}
                  data-list-action="keep-right"
                  onClick={() => onKeep(candidate.id, 'right')}
                  disabled={locked}
                  aria-pressed={selectedSide === 'right'}
                  aria-haspopup="dialog"
                  aria-label={`Conservar ${candidate.right.title}, de ${candidate.right.album || 'álbum desconocido'}, la opción recomendada, y enviar ${candidate.left.title}, de ${candidate.left.album || 'álbum desconocido'}, a la Papelera`}
                >
                  <span className="duplicate-list-artwork">
                    <DuplicateListArtwork track={candidate.right} />
                    {selectedSide === 'right' && (
                      <span className="duplicate-list-selection-mark" aria-hidden="true">
                        <Icon name="check" size={11} />
                      </span>
                    )}
                  </span>
                  <span className="duplicate-list-track-copy">
                    <span className="duplicate-list-keeper">Recomendado</span>
                    <strong>{candidate.right.title}</strong>
                    <span>{candidate.right.artist}</span>
                    <small>{candidate.right.album || 'Álbum desconocido'} · {fmtTime(candidate.right.duration)}</small>
                  </span>
                </button>
              </div>
              <button
                type="button"
                className="duplicate-list-open-action"
                data-candidate-id={candidate.id}
                data-list-action="open"
                onClick={() => onOpen(candidate.id)}
                disabled={locked}
                aria-label={`Abrir comparación de ${candidate.left.title} y ${candidate.right.title}, ${scoreText(candidate.similarity)} de similitud`}
              >
                {isOpening || isResolving
                  ? <Icon name="loader" size={14} className="duplicate-spin" />
                  : <Icon name="chevR" size={14} />}
              </button>
            </li>
          )
        })}
      </ol>
      <p className="duplicate-list-keyboard-hint">Usá ↑ y ↓ para recorrer la misma acción entre filas; cada elección requiere confirmación.</p>
    </section>
  )
}

function DuplicateTrackCard({
  side,
  track,
  audition,
  changed,
  recommended,
  recommendationReasons,
  resolving,
  onTogglePlay,
  onSeek,
  onTrash,
}: {
  side: DuplicateAuditionSide
  track: DuplicateTrackView
  audition: DuplicateAuditionState
  changed: Set<TrackFieldKey>
  recommended: boolean
  recommendationReasons: string[]
  resolving: boolean
  onTogglePlay: (side: DuplicateAuditionSide) => void
  onSeek: (side: DuplicateAuditionSide, position: number) => void
  onTrash: (side: DuplicateAuditionSide) => void
}) {
  const active = audition.activeSide === side
  const playing = active && audition.status === 'playing'
  const position = side === 'left' ? audition.leftPositionSec : audition.rightPositionSec
  const auditionDuration = side === 'left' ? audition.leftDurationSec : audition.rightDurationSec
  const duration = auditionDuration || track.duration
  const fields = trackFields(track)
  const headingId = `duplicate-track-${side}-${track.id}`

  return (
    <article className={`duplicate-track-card ${recommended ? 'keeper' : 'candidate'} ${active ? 'is-audible' : ''}`} aria-labelledby={headingId}>
      <header className="duplicate-track-card-head">
        <span className={`duplicate-side-label ${recommended ? 'keeper' : ''}`}>
          <Icon name={recommended ? 'check' : 'duplicate'} size={12} />
          {recommended ? 'Recomendado conservar' : 'Posible copia'}
        </span>
        {active && <span className="duplicate-audible-chip" aria-live="polite">En escucha</span>}
      </header>

      <div className="duplicate-track-identity">
        <TrackArtwork track={track} />
        <div>
          <h2 id={headingId}>{track.title}</h2>
          <strong>{track.artist}</strong>
          <span>{track.album || 'Álbum desconocido'}{track.year ? ` · ${track.year}` : ''}</span>
        </div>
      </div>

      {recommended && recommendationReasons.length > 0 && (
        <div className="duplicate-keeper-reasons" aria-label="Motivos de la recomendación">
          {recommendationReasons.map(reason => (
            <span key={reason}><Icon name="sparkle" size={10} />{reason}</span>
          ))}
        </div>
      )}

      <div className="duplicate-audition-controls">
        <button
          type="button"
          className={`duplicate-play ${playing ? 'playing' : ''}`}
          onClick={() => onTogglePlay(side)}
          disabled={audition.status === 'loading' || resolving}
          aria-label={playing ? `Pausar ${track.title}` : `Escuchar ${track.title}`}
        >
          <Icon name={playing ? 'pause' : 'play'} size={13} />
        </button>
        <span className="duplicate-time">{fmtTime(position)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(duration, 0.1)}
          step={0.1}
          value={Math.min(position, Math.max(duration, 0.1))}
          onChange={event => onSeek(side, Number(event.target.value))}
          aria-label={`Posición de ${track.title}`}
          aria-valuetext={`${fmtTime(position)} de ${fmtTime(duration)}`}
          disabled={audition.status === 'loading' || resolving}
        />
        <span className="duplicate-time">{fmtTime(duration)}</span>
      </div>

      <dl className="duplicate-track-facts">
        {fields.map(field => (
          <div key={field.key} className={changed.has(field.key) ? 'different' : ''}>
            <dt>{field.label}</dt>
            <dd title={field.key === 'path' ? field.value : undefined}>{field.value}</dd>
          </div>
        ))}
      </dl>

      <footer className="duplicate-track-card-foot">
        <button type="button" className="btn ghost duplicate-trash-action" onClick={() => onTrash(side)} disabled={resolving}>
          <Icon name="trash" size={12} />
          Enviar a la Papelera
        </button>
      </footer>
    </article>
  )
}

function DuplicateTimeline({
  detail,
  audition,
  disabled,
  onCompare,
}: {
  detail: DuplicateCandidateDetail
  audition: DuplicateAuditionState
  disabled: boolean
  onCompare: (index: number) => void
}) {
  const [filter, setFilter] = useState<DuplicateSegmentFilter>('all')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const timelineDuration = duplicateTimelineDuration(detail.segments)
  const visibleSegments = useMemo(
    () => filterDuplicateSegments(detail.segments, filter),
    [detail.segments, filter],
  )
  const selected = detail.segments[selectedIndex] ?? visibleSegments[0]?.segment ?? null
  const selectedBackendIndex = detail.segments.indexOf(selected as DuplicateSegment)

  useEffect(() => {
    setFilter('all')
    setSelectedIndex(0)
  }, [detail.id])

  useEffect(() => {
    if (filter === 'all' || detail.segments[selectedIndex]?.kind === filter) return
    setSelectedIndex(visibleSegments[0]?.index ?? 0)
  }, [detail.segments, filter, selectedIndex, visibleSegments])

  return (
    <section className="duplicate-timeline-panel" aria-labelledby="duplicate-timeline-title">
      <div className="duplicate-section-head">
        <div>
          <h2 id="duplicate-timeline-title">Mapa de la grabación</h2>
          <p>Elegí un tramo para escuchar primero la izquierda y luego la derecha.</p>
        </div>
        <div className="duplicate-segment-filters" role="group" aria-label="Filtrar tramos">
          {(Object.keys(DUPLICATE_SEGMENT_FILTER_LABELS) as DuplicateSegmentFilter[]).map(option => (
            <button
              key={option}
              type="button"
              className={filter === option ? 'active' : ''}
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
            >
              {DUPLICATE_SEGMENT_FILTER_LABELS[option]}
            </button>
          ))}
        </div>
      </div>

      {detail.segments.length === 0 ? (
        <div className="duplicate-segments-empty">No hay tramos detallados para esta comparación.</div>
      ) : (
        <>
          <div className="duplicate-timeline-legend" aria-hidden="true">
            <span className="match"><i />Coincidencia</span>
            <span className="difference"><i />Diferencia</span>
          </div>
          <div className="duplicate-timeline" aria-label="Tramos alineados">
            {detail.segments.map((segment, index) => (
              <button
                key={segment.id}
                type="button"
                className={`${segment.kind} ${selectedIndex === index ? 'selected' : ''} ${filter !== 'all' && filter !== segment.kind ? 'filtered-out' : ''}`}
                style={{ flexGrow: duplicateSegmentWidth(segment, timelineDuration) }}
                onClick={() => setSelectedIndex(index)}
                aria-label={`${segment.kind === 'match' ? 'Coincidencia' : 'Diferencia'} de ${fmtTime(segment.startSec)} a ${fmtTime(segment.endSec)}, ${scoreText(segment.score)}`}
                aria-current={selectedIndex === index ? 'true' : undefined}
              />
            ))}
          </div>
          <div className="duplicate-timeline-scale" aria-hidden="true"><span>0:00</span><span>{fmtTime(timelineDuration)}</span></div>

          <div className="duplicate-segment-picker" aria-label="Tramos disponibles">
            {visibleSegments.map(({ segment, index }) => (
              <button
                key={segment.id}
                type="button"
                className={`${segment.kind} ${selectedIndex === index ? 'selected' : ''}`}
                onClick={() => setSelectedIndex(index)}
              >
                <i aria-hidden="true" />
                <span>{segment.kind === 'match' ? 'Coincidencia' : 'Diferencia'}</span>
                <strong>{fmtTime(segment.startSec)}–{fmtTime(segment.endSec)}</strong>
                <em>{scoreText(segment.score)}</em>
              </button>
            ))}
          </div>

          {selected && (
            <div className="duplicate-segment-action">
              <div>
                <strong>{selected.kind === 'match' ? 'Tramo coincidente' : 'Tramo diferente'}</strong>
                <span>{fmtTime(selected.startSec)}–{fmtTime(selected.endSec)} · similitud {scoreText(selected.score)}</span>
              </div>
              <button
                type="button"
                className="btn primary"
                onClick={() => onCompare(selectedBackendIndex)}
                disabled={disabled || selectedBackendIndex < 0}
              >
                <Icon name={audition.comparingSegmentIndex === selectedBackendIndex && audition.status === 'playing' ? 'pause' : 'wave'} size={13} />
                {audition.comparingSegmentIndex === selectedBackendIndex && audition.status === 'playing' ? 'Comparando…' : 'Comparar A/B'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function KeepBothDialog({
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: (reason: DuplicateKeepBothReason) => void
}) {
  const [reason, setReason] = useState<DuplicateKeepBothReason | null>(null)
  const firstRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    firstRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onCancel])
  return (
    <ModalShell
      title="Conservar ambos temas"
      onClose={onCancel}
      footer={(
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancelar</button>
          <button type="button" className="btn primary" onClick={() => reason && onConfirm(reason)} disabled={!reason || busy}>
            {busy ? 'Guardando…' : 'Conservar ambos'}
          </button>
        </>
      )}
    >
      <div className="duplicate-decision-dialog">
        <p className="modal-copy">Esta pareja no volverá a aparecer mientras el audio de ambos archivos siga siendo el mismo.</p>
        {error && <p className="duplicate-dialog-error" role="alert">{error}</p>}
        <label>
          <input ref={firstRef} type="radio" name="keep-both-reason" checked={reason === 'different_versions'} onChange={() => setReason('different_versions')} />
          <span><strong>Son versiones diferentes</strong><small>Por ejemplo, edición de single, álbum, remaster o mezcla alternativa.</small></span>
        </label>
        <label>
          <input type="radio" name="keep-both-reason" checked={reason === 'not_duplicates'} onChange={() => setReason('not_duplicates')} />
          <span><strong>No son duplicados</strong><small>La coincidencia automática no representa la relación entre estos temas.</small></span>
        </label>
      </div>
    </ModalShell>
  )
}

function TrashDialog({
  side,
  candidate,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  side: DuplicateAuditionSide
  candidate: DuplicateCandidateSummary
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const overridesRecommendation = side === 'right'
  const discardedTrack = side === 'left' ? candidate.left : candidate.right
  const keptTrack = side === 'left' ? candidate.right : candidate.left
  const [acknowledged, setAcknowledged] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onCancel])
  return (
    <ModalShell
      title={overridesRecommendation ? '¿Conservar la alternativa?' : '¿Conservar el tema recomendado?'}
      onClose={onCancel}
      footer={(
        <>
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel} disabled={busy}>Cancelar</button>
          <button type="button" className="btn danger" onClick={onConfirm} disabled={busy || (overridesRecommendation && !acknowledged)}>
            {busy ? 'Moviendo…' : 'Enviar a la Papelera'}
          </button>
        </>
      )}
    >
      <div className="duplicate-decision-dialog">
        <div className="duplicate-trash-summary">
          <div className="kept">
            <span><Icon name="check" size={11} />Se conserva</span>
            <strong>{keptTrack.title}</strong>
            <small>{keptTrack.artist} · {keptTrack.album || 'Álbum desconocido'}</small>
          </div>
          <Icon name="fwd" size={12} className="duplicate-trash-summary-arrow" />
          <div className="discarded">
            <span><Icon name="trash" size={11} />Va a la Papelera</span>
            <strong>{discardedTrack.title}</strong>
            <small>{discardedTrack.artist} · {discardedTrack.album || 'Álbum desconocido'}</small>
          </div>
        </div>
        <p className="modal-copy duplicate-trash-path">{discardedTrack.path}</p>
        <p className="modal-muted">El archivo se moverá a la Papelera y su estado se fusionará con el tema conservado. Si está en OneDrive, irá a la papelera de OneDrive.</p>
        {error && <p className="duplicate-dialog-error" role="alert">{error}</p>}
        {overridesRecommendation && (
          <label className="duplicate-warning-choice">
            <input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />
            <span><strong>Entiendo que esta es la copia recomendada</strong><small>La otra versión quedará como archivo principal de esta pareja.</small></span>
          </label>
        )}
      </div>
    </ModalShell>
  )
}

export function DuplicateReviewView({ candidateId }: { candidateId?: string }) {
  const summary = useDuplicateStore(state => state.summary)
  const candidates = useDuplicateStore(state => state.candidates)
  const detail = useDuplicateStore(state => state.detail)
  const selectedIndex = useDuplicateStore(state => state.selectedIndex)
  const loading = useDuplicateStore(state => state.loading)
  const reanalyzing = useDuplicateStore(state => state.reanalyzing)
  const resolving = useDuplicateStore(state => state.resolving)
  const resolvingCandidateId = useDuplicateStore(state => state.resolvingCandidateId)
  const error = useDuplicateStore(state => state.error)
  const notice = useDuplicateStore(state => state.notice)
  const audition = useDuplicateStore(state => state.audition)
  const enter = useDuplicateStore(state => state.enter)
  const leave = useDuplicateStore(state => state.leave)
  const selectCandidate = useDuplicateStore(state => state.selectCandidate)
  const selectRelative = useDuplicateStore(state => state.selectRelative)
  const showList = useDuplicateStore(state => state.showList)
  const reanalyze = useDuplicateStore(state => state.reanalyze)
  const keepBoth = useDuplicateStore(state => state.keepBoth)
  const keepCandidate = useDuplicateStore(state => state.keepCandidate)
  const togglePlay = useDuplicateStore(state => state.togglePlay)
  const pause = useDuplicateStore(state => state.pause)
  const seek = useDuplicateStore(state => state.seek)
  const compareSegment = useDuplicateStore(state => state.compareSegment)
  const clearNotice = useDuplicateStore(state => state.clearNotice)
  const [keepDialogOpen, setKeepDialogOpen] = useState(false)
  const [trashDecision, setTrashDecision] = useState<TrashDecision | null>(null)
  const [decisionError, setDecisionError] = useState<string | null>(null)
  const [postResolutionFocus, setPostResolutionFocus] = useState<{ candidateId: string | null } | null>(null)
  const listRef = useRef<HTMLElement>(null)
  const emptyStateRef = useRef<HTMLElement>(null)
  const returnFocusCandidateRef = useRef<string | null>(null)

  useEffect(() => {
    void enter(candidateId)
    return () => { void leave() }
  }, [candidateId, enter, leave])

  useEffect(() => {
    if (detail || !returnFocusCandidateRef.current) return
    const candidateToFocus = returnFocusCandidateRef.current
    returnFocusCandidateRef.current = null
    const frame = requestAnimationFrame(() => {
      const button = Array.from(
        listRef.current?.querySelectorAll<HTMLButtonElement>('[data-candidate-id]') ?? [],
      ).find(item => item.dataset.candidateId === candidateToFocus)
      button?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [candidates, detail])

  useEffect(() => {
    if (detail || trashDecision || !postResolutionFocus) return
    const frame = requestAnimationFrame(() => {
      const target = postResolutionFocus.candidateId
        ? Array.from(
            listRef.current?.querySelectorAll<HTMLButtonElement>('[data-candidate-id]') ?? [],
          ).find(item => item.dataset.candidateId === postResolutionFocus.candidateId)
        : emptyStateRef.current
      target?.focus()
      setPostResolutionFocus(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [candidates, detail, postResolutionFocus, trashDecision])

  const changed = useMemo(
    () => detail ? changedFieldKeys(detail.left, detail.right) : new Set<TrackFieldKey>(),
    [detail],
  )
  const progress = summary.progress
  const progressPercent = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
    : null
  const analysisBlocked = Boolean(summary.blocker && !summary.blocker.retryable)

  return (
    <main className="duplicate-review" aria-busy={loading || resolving}>
      <header className="duplicate-review-head">
        <div>
          <div className="duplicate-eyebrow"><Icon name="duplicate" size={13} />Corrección de biblioteca</div>
          <h1>Temas duplicados</h1>
          <p>
            {summary.pendingCount === 1
              ? '1 comparación pendiente'
              : `${summary.pendingCount.toLocaleString()} comparaciones pendientes`}
          </p>
        </div>
        <div className="duplicate-review-nav">
          {detail && (
            <>
              <button
                type="button"
                className="btn duplicate-back-to-list"
                onClick={() => {
                  returnFocusCandidateRef.current = detail.id
                  void showList()
                }}
                disabled={loading || resolving}
              >
                <Icon name="list" size={12} />
                Ver todos
              </button>
              <span aria-live="polite">{selectedIndex + 1} de {candidates.length}</span>
              <button type="button" className="btn icon" onClick={() => { void selectRelative(-1) }} disabled={loading || selectedIndex <= 0} aria-label="Comparación anterior">
                <Icon name="back" size={13} />
              </button>
              <button type="button" className="btn icon" onClick={() => { void selectRelative(1) }} disabled={loading || selectedIndex >= candidates.length - 1} aria-label="Comparación siguiente">
                <Icon name="fwd" size={13} />
              </button>
            </>
          )}
          <button type="button" className="btn" onClick={() => { void reanalyze() }} disabled={reanalyzing || summary.running || analysisBlocked}>
            <Icon name={reanalyzing || summary.running ? 'loader' : 'rotate'} size={12} className={reanalyzing || summary.running ? 'duplicate-spin' : undefined} />
            {reanalyzing || summary.running ? 'Analizando…' : analysisBlocked ? 'Análisis no disponible' : 'Volver a analizar'}
          </button>
        </div>
      </header>

      {summary.running && (
        <div className="duplicate-analysis-banner" role="status" aria-live="polite">
          <span className="duplicate-analysis-icon"><Icon name="wave" size={14} /></span>
          <div>
            <strong>Buscando coincidencias acústicas</strong>
            <span>{progress?.currentTitle || 'Analizando la biblioteca en segundo plano'}</span>
          </div>
          <div className={`duplicate-analysis-progress ${progressPercent == null ? 'indeterminate' : ''}`}>
            <i style={progressPercent == null ? undefined : { width: `${progressPercent}%` }} />
          </div>
          <em>{progress && progress.total > 0 ? `${progress.completed}/${progress.total}` : 'En curso'}</em>
        </div>
      )}

      {summary.blocker && (
        <div className={`duplicate-feedback ${summary.blocker.retryable ? 'waiting' : 'error'} duplicate-blocker`} role={summary.blocker.retryable ? 'status' : 'alert'}>
          <Icon name="info" size={13} />
          <span>
            <strong>{summary.blocker.retryable ? 'Biblioteca temporalmente no disponible' : 'Análisis acústico no disponible'}</strong>
            <small>{summary.blocker.message}</small>
          </span>
        </div>
      )}

      {error && <div className="duplicate-feedback error" role="alert"><Icon name="info" size={13} />{error}</div>}
      {notice && (
        <div className="duplicate-feedback success" role="status">
          <Icon name="check" size={13} />
          <span>{notice}</span>
          <button type="button" className="tb-icon-btn" onClick={clearNotice} aria-label="Cerrar aviso"><Icon name="close" size={11} /></button>
        </div>
      )}

      {loading && !detail && candidates.length === 0 && (
        <section className="duplicate-empty" role="status">
          <span><Icon name="loader" size={22} className="duplicate-spin" /></span>
          <h2>Cargando comparaciones</h2>
          <p>Preparando los datos y la audición A/B sin modificar tu cola.</p>
        </section>
      )}

      {!loading && !detail && candidates.length === 0 && summary.blocker && (
        <section className="duplicate-empty">
          <span className={summary.blocker.retryable ? 'is-waiting' : 'is-error'}><Icon name="info" size={22} /></span>
          <h2>{summary.blocker.retryable ? 'El análisis está en espera' : 'No se pudo iniciar el análisis'}</h2>
          <p>
            {summary.blocker.retryable
              ? 'Conectá la biblioteca o concedé acceso y volvé a intentarlo. No se marcó ninguna pista como dañada.'
              : 'Corregí la instalación de Chromaprint y reiniciá Crate. No se marcó ninguna pista como dañada.'}
          </p>
          {summary.blocker.retryable && (
            <button type="button" className="btn" onClick={() => { void reanalyze() }} disabled={reanalyzing || summary.running}>
              <Icon name="rotate" size={12} />Volver a intentar
            </button>
          )}
        </section>
      )}

      {!loading && !detail && candidates.length === 0 && error && !summary.blocker && (
        <section className="duplicate-empty">
          <span className="is-error"><Icon name="info" size={22} /></span>
          <h2>No se pudo cargar la lista</h2>
          <p>Las comparaciones siguen guardadas. Volvé a intentar para recuperar la lista pendiente.</p>
          <button type="button" className="btn" onClick={() => { void enter() }}>
            <Icon name="rotate" size={12} />Volver a cargar
          </button>
        </section>
      )}

      {!loading && !detail && candidates.length === 0 && !error && !summary.blocker && (
        <section ref={emptyStateRef} className="duplicate-empty" tabIndex={-1}>
          <span><Icon name="check" size={22} /></span>
          <h2>No hay comparaciones pendientes</h2>
          <p>La biblioteca está al día. Crate seguirá revisando los temas nuevos y los cambios de audio.</p>
          <button type="button" className="btn" onClick={() => { void reanalyze() }} disabled={reanalyzing || summary.running}>
            <Icon name="rotate" size={12} />Analizar ahora
          </button>
        </section>
      )}

      {!detail && candidates.length > 0 && (
        <DuplicateCandidateList
          candidates={candidates}
          selectedIndex={selectedIndex}
          opening={loading && !resolving}
          resolvingCandidateId={resolvingCandidateId}
          selectedChoice={trashDecision?.source === 'list'
            ? {
                candidateId: trashDecision.candidate.id,
                side: trashDecision.trashSide === 'left' ? 'right' : 'left',
              }
            : null}
          listRef={listRef}
          onOpen={id => { void selectCandidate(id) }}
          onKeep={(id, side) => {
            const index = candidates.findIndex(candidate => candidate.id === id)
            const candidate = candidates[index]
            if (!candidate) return
            setDecisionError(null)
            setTrashDecision({
              candidate,
              trashSide: side === 'left' ? 'right' : 'left',
              source: 'list',
              listIndex: index,
            })
          }}
        />
      )}

      {detail && (
        <div className={`duplicate-review-body ${loading ? 'is-loading' : ''}`}>
          <section className="duplicate-relation-strip" aria-label="Resultado de la comparación">
            <div className="duplicate-score-dial" style={{ '--duplicate-score': `${scoreText(detail.similarity)}` } as CSSProperties}>
              <strong>{scoreText(detail.similarity)}</strong>
              <span>similitud</span>
            </div>
            <div>
              <span>Relación acústica</span>
              <strong>{DUPLICATE_ACOUSTIC_LABELS[detail.acousticRelation]}</strong>
            </div>
            <div>
              <span>Relación editorial</span>
              <strong>{DUPLICATE_EDITORIAL_LABELS[detail.editorialRelation]}</strong>
            </div>
            <div>
              <span>Alineación</span>
              <strong>{detail.alignmentOffsetSeconds === 0 ? 'Sin desplazamiento' : `${detail.alignmentOffsetSeconds > 0 ? '+' : ''}${detail.alignmentOffsetSeconds.toFixed(1)} s`}</strong>
            </div>
          </section>

          <div className="duplicate-track-grid">
            <DuplicateTrackCard
              side="left"
              track={detail.left}
              audition={audition}
              changed={changed}
              recommended={false}
              recommendationReasons={[]}
              resolving={resolving}
              onTogglePlay={side => { void togglePlay(side) }}
              onSeek={(side, position) => { void seek(side, position) }}
              onTrash={side => {
                setDecisionError(null)
                setTrashDecision({ candidate: detail, trashSide: side, source: 'detail', listIndex: null })
              }}
            />
            <div className="duplicate-versus" aria-hidden="true">A/B</div>
            <DuplicateTrackCard
              side="right"
              track={detail.right}
              audition={audition}
              changed={changed}
              recommended
              recommendationReasons={detail.recommendationReasons}
              resolving={resolving}
              onTogglePlay={side => { void togglePlay(side) }}
              onSeek={(side, position) => { void seek(side, position) }}
              onTrash={side => {
                setDecisionError(null)
                setTrashDecision({ candidate: detail, trashSide: side, source: 'detail', listIndex: null })
              }}
            />
          </div>

          <div className="duplicate-keep-row">
            <span />
            <button type="button" className="btn" onClick={() => setKeepDialogOpen(true)} disabled={resolving}>
              <Icon name="check" size={12} />Conservar ambos
            </button>
            <span />
          </div>

          <DuplicateTimeline
            detail={detail}
            audition={audition}
            disabled={resolving || audition.status === 'loading'}
            onCompare={index => {
              if (audition.comparingSegmentIndex === index && audition.status === 'playing') void pause()
              else void compareSegment(index)
            }}
          />

          {detail.evidence.length > 0 && (
            <section className="duplicate-evidence" aria-labelledby="duplicate-evidence-title">
              <div className="duplicate-section-head">
                <div>
                  <h2 id="duplicate-evidence-title">Qué observó Crate</h2>
                  <p>Las señales editoriales se muestran como indicios; no modifican los tags.</p>
                </div>
              </div>
              <ul>
                {detail.evidence.map((item, index) => (
                  <li key={`${item.kind}-${index}`}>
                    <Icon name={item.source === 'audio' ? 'wave' : item.source === 'musicbrainz' ? 'cloud' : 'info'} size={12} />
                    <span>{item.message}</span>
                    <em>{scoreText(item.confidence)}</em>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {loading && <div className="duplicate-loading-overlay" role="status"><Icon name="loader" size={18} /><span>Cargando comparación…</span></div>}
        </div>
      )}

      {keepDialogOpen && detail && (
        <KeepBothDialog
          busy={resolving}
          error={decisionError}
          onCancel={() => {
            if (resolving) return
            setDecisionError(null)
            setKeepDialogOpen(false)
          }}
          onConfirm={reason => {
            void keepBoth(reason).then(success => {
              if (!success) {
                setDecisionError(useDuplicateStore.getState().error || 'No se pudo guardar la decisión.')
                return
              }
              setDecisionError(null)
              setKeepDialogOpen(false)
            })
          }}
        />
      )}
      {trashDecision && (
        <TrashDialog
          side={trashDecision.trashSide}
          candidate={trashDecision.candidate}
          busy={resolving}
          error={decisionError}
          onCancel={() => {
            if (resolving) return
            setDecisionError(null)
            setTrashDecision(null)
          }}
          onConfirm={() => {
            const decision = trashDecision
            const keptSide: DuplicateAuditionSide = decision.trashSide === 'left' ? 'right' : 'left'
            const resolution = keepCandidate(
              decision.candidate.id,
              decision.candidate.revision,
              keptSide,
            )
            void resolution.then(success => {
              if (!success) {
                setDecisionError(useDuplicateStore.getState().error || 'No se pudo mover el archivo a la Papelera.')
                return
              }
              if (decision.source === 'list' && decision.listIndex != null) {
                const remaining = useDuplicateStore.getState().candidates
                const next = remaining[Math.min(decision.listIndex, Math.max(0, remaining.length - 1))]
                setPostResolutionFocus({ candidateId: next?.id ?? null })
              }
              setDecisionError(null)
              setTrashDecision(null)
            })
          }}
        />
      )}
    </main>
  )
}
