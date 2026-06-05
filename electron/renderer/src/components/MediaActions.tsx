import { type FormEvent, type MouseEvent, type ReactNode, useEffect, useMemo, useState } from 'react'
import type { Album, Playlist, Track } from '@shared/types/library'
import type { TrackAlbumMovePreview, TrackAlbumMoveQuality, TrackMetadataUpdatePayload } from '@shared/types/ipc-contract'
import { fmtTime, fmtTotal } from '@renderer/utils/format'
import {
  addTracksToPlaylist,
  applyTrackAlbumMove,
  createPlaylistWithTracks,
  previewTrackAlbumMove,
  toggleTrackFavorite,
  trashTracksWithAnimation,
  updateTrackMetadata,
  updateTracksMetadata,
  useAlbums,
  usePlaylists,
} from '@renderer/stores/libraryStore'
import { useQueueStore } from '@renderer/stores/queueStore'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { Icon } from './Icon'
import { useNavIntentStore } from '@renderer/stores/navIntentStore'

type TrackDialog =
  | { kind: 'playlist'; tracks: Track[] }
  | { kind: 'details'; track: Track }
  | { kind: 'edit'; track: Track }
  | { kind: 'moveAlbum'; track: Track }
  | { kind: 'trash'; tracks: Track[] }

type AlbumDialog =
  | { kind: 'details'; album: Album }
  | { kind: 'edit'; album: Album }
  | { kind: 'trash'; album: Album }

interface MenuState<T> {
  x: number
  y: number
  target: T
}

function trackDbIds(tracks: Track[]): number[] {
  return tracks.map(t => t.dbId).filter((id): id is number => id != null)
}

function playlistDbId(playlist: Playlist): number | null {
  const match = /^p(\d+)$/.exec(playlist.id)
  return match ? Number.parseInt(match[1], 10) : null
}

function albumDbId(album: Album): number | null {
  const match = /^a(\d+)$/.exec(album.id)
  return match ? Number.parseInt(match[1], 10) : null
}

function parseOptionalInt(value: string): number | null {
  const cleaned = value.trim()
  if (!cleaned) return null
  const parsed = Number.parseInt(cleaned, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value = value / 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function formatKbps(value: number | null | undefined): string {
  return value ? `${Math.round(value / 1000)} kbps` : '-'
}

function formatHz(value: number | null | undefined): string {
  return value ? `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)} kHz` : '-'
}

function ModalShell({
  title,
  children,
  footer,
  onClose,
}: {
  title: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="tb-icon-btn" onClick={onClose} title="Cerrar">
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

function DetailRow({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong title={title}>{value}</strong>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'number'
}) {
  return (
    <label className="form-field">
      <span>{label}</span>
      <input type={type} value={value} onChange={event => onChange(event.target.value)} />
    </label>
  )
}

function TrackDetailsModal({ track, onClose }: { track: Track; onClose: () => void }) {
  return (
    <ModalShell title="Datos del archivo" onClose={onClose}>
      <div className="detail-grid">
        <DetailRow label="Título" value={track.t} />
        <DetailRow label="Artista" value={track.artist} />
        <DetailRow label="Álbum" value={track.albumTitle} />
        <DetailRow label="Album artist" value={track.albumArtist || '-'} />
        <DetailRow label="Género" value={track.genre || '-'} />
        <DetailRow label="Año" value={track.year || '-'} />
        <DetailRow label="Duración" value={fmtTime(track.d)} />
        <DetailRow label="Formato" value={track.fmt} />
        <DetailRow label="Codec" value={track.codec || '-'} />
        <DetailRow label="Bitrate" value={formatKbps(track.bitrate)} />
        <DetailRow label="Sample rate" value={formatHz(track.sampleRate)} />
        <DetailRow label="Bit depth" value={track.bitDepth ? `${track.bitDepth}-bit` : '-'} />
        <DetailRow label="Canales" value={track.channels ?? '-'} />
        <DetailRow label="Tamaño" value={formatBytes(track.fileSize)} />
        <DetailRow label="Agregado" value={formatDate(track.added)} />
        <DetailRow label="Modificado" value={formatDate(track.dateModified)} />
        <DetailRow label="Ruta" value={track.path || '-'} title={track.path} />
      </div>
    </ModalShell>
  )
}

function TrackMetadataEditor({ track, onClose }: { track: Track; onClose: () => void }) {
  const [title, setTitle] = useState(track.t)
  const [artist, setArtist] = useState(track.artist)
  const [album, setAlbum] = useState(track.albumTitle)
  const [albumArtist, setAlbumArtist] = useState(track.albumArtist ?? '')
  const [composer, setComposer] = useState(track.composer ?? '')
  const [genre, setGenre] = useState(track.genre)
  const [year, setYear] = useState(track.year ? String(track.year) : '')
  const [trackNumber, setTrackNumber] = useState(track.no ? String(track.no) : '')
  const [totalTracks, setTotalTracks] = useState(track.totalTracks ? String(track.totalTracks) : '')
  const [discNumber, setDiscNumber] = useState(track.discNumber ? String(track.discNumber) : '')
  const [totalDiscs, setTotalDiscs] = useState(track.totalDiscs ? String(track.totalDiscs) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (track.dbId == null) return
    setSaving(true)
    setError(null)
    try {
      await updateTrackMetadata(track.dbId, {
        title,
        artist,
        album,
        albumArtist: albumArtist.trim() || null,
        composer,
        genre,
        year,
        trackNumber: parseOptionalInt(trackNumber),
        totalTracks: parseOptionalInt(totalTracks),
        discNumber: parseOptionalInt(discNumber),
        totalDiscs: parseOptionalInt(totalDiscs),
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell
      title="Editar metadatos"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" form="track-metadata-form" className="btn primary" disabled={saving || track.dbId == null}>
            Guardar
          </button>
        </>
      )}
    >
      <form id="track-metadata-form" className="metadata-form" onSubmit={onSubmit}>
        <Field label="Título" value={title} onChange={setTitle} />
        <Field label="Artista" value={artist} onChange={setArtist} />
        <Field label="Álbum" value={album} onChange={setAlbum} />
        <Field label="Album artist" value={albumArtist} onChange={setAlbumArtist} />
        <Field label="Compositor" value={composer} onChange={setComposer} />
        <Field label="Género" value={genre} onChange={setGenre} />
        <Field label="Año" value={year} onChange={setYear} type="number" />
        <div className="form-grid-2">
          <Field label="Track" value={trackNumber} onChange={setTrackNumber} type="number" />
          <Field label="Total tracks" value={totalTracks} onChange={setTotalTracks} type="number" />
          <Field label="Disco" value={discNumber} onChange={setDiscNumber} type="number" />
          <Field label="Total discos" value={totalDiscs} onChange={setTotalDiscs} type="number" />
        </div>
        {error && <div className="modal-error">{error}</div>}
      </form>
    </ModalShell>
  )
}

function formatTrackPosition(preview: TrackAlbumMovePreview | null): string {
  const p = preview?.proposal
  if (!p) return '-'
  const disc = p.discNumber && p.totalDiscs && p.totalDiscs > 1 ? `D${p.discNumber} · ` : ''
  return `${disc}${p.trackNumber}${p.totalTracks ? `/${p.totalTracks}` : ''}`
}

function normalizeAlbumSuggestionText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function wordsForAlbumSuggestion(value: string): string[] {
  return normalizeAlbumSuggestionText(value)
    .split(' ')
    .map(word => word.trim())
    .filter(word => word.length > 1)
}

function wordMatchScore(left: string, right: string): number {
  const leftWords = wordsForAlbumSuggestion(left)
  const rightWords = new Set(wordsForAlbumSuggestion(right))
  if (leftWords.length === 0 || rightWords.size === 0) return 0
  let rawScore = 0

  for (const word of leftWords) {
    if (rightWords.has(word)) {
      rawScore += 18
      continue
    }

    for (const candidate of rightWords) {
      if (candidate.includes(word) || word.includes(candidate)) {
        rawScore += 6
        break
      }
    }
  }

  const maxScore = leftWords.length * 20
  const normalized = rawScore / maxScore
  return Math.round(Math.min(0.6, Math.max(0, normalized)) * 45)
}

function albumMoveSuggestionLabel(score: number): string {
  if (score >= 150) return 'Sugerencia'
  if (score >= 110) return 'Muy probable'
  if (score >= 70) return 'Posible'
  return 'Relacionado'
}

// Map the heuristic match score onto a 0–99% confidence band, aligned with the
// qualitative tiers in albumMoveSuggestionLabel so the shown percentage tracks
// the same thresholds (>=150 ≈ 95%+, >=110 ≈ 80%+, >=70 ≈ 60%+).
function albumMoveSuggestionPercent(score: number): number {
  let pct: number
  if (score >= 150) pct = 95 + (score - 150) / 12
  else if (score >= 110) pct = 80 + ((score - 110) / 40) * 15
  else if (score >= 70) pct = 60 + ((score - 70) / 40) * 20
  else pct = (score / 70) * 60
  return Math.max(1, Math.min(99, Math.round(pct)))
}

// Compact quality label for the replacement comparison, e.g. "FLAC · Lossless · 96 kHz · 24 bit".
function albumMoveQualityLabel(quality: TrackAlbumMoveQuality): string {
  const parts = [
    quality.format ? quality.format.toUpperCase() : null,
    quality.lossless ? 'Lossless' : 'Lossy',
    quality.sampleRate ? `${+(quality.sampleRate / 1000).toFixed(1)} kHz` : null,
    quality.bitDepth ? `${quality.bitDepth} bit` : null,
  ]
  return parts.filter(Boolean).join(' · ')
}

function bestAlbumTrackTitleScore(trackTitle: string, album: Album): number {
  let best = 0
  const maxTitleScore = 24

  for (const candidate of album.tracks.slice(0, 24)) {
    if (!candidate.t) continue
    const candidateScore = wordMatchScore(trackTitle, candidate.t)
    if (candidateScore > best) {
      best = candidateScore
      if (best >= maxTitleScore) break
    }
  }

  return Math.min(best, maxTitleScore)
}

function albumMoveSuggestionScore(args: { track: Track; album: Album }): number {
  const trackArtist = normalizeAlbumSuggestionText(args.track.artist)
  const trackAlbumArtist = normalizeAlbumSuggestionText(args.track.albumArtist)
  const trackGenre = normalizeAlbumSuggestionText(args.track.genre)
  const trackTitle = normalizeAlbumSuggestionText(args.track.t)
  const trackYear = String(args.track.year)

  const albumArtist = normalizeAlbumSuggestionText(args.album.artist)
  const albumGenre = normalizeAlbumSuggestionText(args.album.genre)
  const albumTitle = normalizeAlbumSuggestionText(args.album.title)
  const albumYear = String(args.album.year)

  let score = 0

  if (trackAlbumArtist && isAlbumSuggestionTextEqual(albumArtist, trackAlbumArtist)) {
    score += 70
  } else if (trackAlbumArtist && isAlbumSuggestionTextIncluded(albumArtist, trackAlbumArtist)) {
    score += 40
  }

  if (trackArtist) {
    if (isAlbumSuggestionTextEqual(albumArtist, trackArtist)) {
      score += 50
    } else if (isAlbumSuggestionTextIncluded(albumArtist, trackArtist) || isAlbumSuggestionTextIncluded(trackArtist, albumArtist)) {
      score += 28
    }
  }

  if (albumYear === trackYear) {
    score += 28
  }

  if (trackGenre) {
    if (isAlbumSuggestionTextEqual(albumGenre, trackGenre)) {
      score += 22
    } else if (isAlbumSuggestionTextIncluded(albumGenre, trackGenre) || isAlbumSuggestionTextIncluded(trackGenre, albumGenre)) {
      score += 12
    }
  }

  score += wordMatchScore(trackTitle, albumTitle)

  const trackTitleInAlbum = bestAlbumTrackTitleScore(trackTitle, args.album)
  score += trackTitleInAlbum

  return score
}

function isAlbumSuggestionTextEqual(left: string, right: string): boolean {
  return normalizeAlbumSuggestionText(left) === normalizeAlbumSuggestionText(right)
}

function isAlbumSuggestionTextIncluded(haystack: string, needle: string): boolean {
  const normalizedHaystack = normalizeAlbumSuggestionText(haystack)
  const normalizedNeedle = normalizeAlbumSuggestionText(needle)
  return !!(normalizedHaystack && normalizedNeedle && normalizedHaystack.includes(normalizedNeedle))
}

  type AlbumSuggestion = {
  album: Album
  score: number
}

function TrackAlbumMoveModal({ track, onClose }: { track: Track; onClose: () => void }) {
  const albums = useAlbums()
  const [query, setQuery] = useState('')
  const candidates = useMemo<AlbumSuggestion[]>(() => {
    const q = normalizeAlbumSuggestionText(query)
    const bySource = albums
      .filter(album => albumDbId(album) != null && album.id !== track.albumId)
      .filter(album => {
        if (!q) return true
        return isAlbumSuggestionTextIncluded(`${album.title} ${album.artist} ${album.genre} ${album.year}`, q)
      })
      .map(album => ({ album, score: albumMoveSuggestionScore({ track, album }) }))

    bySource.sort((a, b) => {
      const scoreDelta = b.score - a.score
      if (scoreDelta !== 0) return scoreDelta
      const title = a.album.title.localeCompare(b.album.title)
      if (title !== 0) return title
      return a.album.artist.localeCompare(b.album.artist)
    })

    return bySource.slice(0, 12)
  }, [albums, query, track.albumId, track.artist, track.albumArtist, track.genre, track.t, track.year])
  const firstAlbumId = candidates.map(candidate => albumDbId(candidate.album)).find((id): id is number => id != null)
  const [targetAlbumId, setTargetAlbumId] = useState<number | null>(firstAlbumId ?? null)
  // User-chosen destination slot. Reset whenever the target album changes so each
  // album starts from its own MusicBrainz/recommended slot.
  const [trackNumberOverride, setTrackNumberOverride] = useState<number | null>(null)
  const [preview, setPreview] = useState<TrackAlbumMovePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (targetAlbumId != null && candidates.some(candidate => albumDbId(candidate.album) === targetAlbumId)) return
    setTargetAlbumId(firstAlbumId ?? null)
  }, [candidates, firstAlbumId, targetAlbumId])

  useEffect(() => {
    setTrackNumberOverride(null)
  }, [targetAlbumId])

  useEffect(() => {
    if (track.dbId == null || targetAlbumId == null) {
      setPreview(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setPreview(null)
    void previewTrackAlbumMove({ trackId: track.dbId, targetAlbumId, trackNumber: trackNumberOverride })
      .then(next => {
        if (!cancelled) setPreview(next)
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [targetAlbumId, track.dbId, trackNumberOverride])

  const selectedAlbum = candidates.find(candidate => albumDbId(candidate.album) === targetAlbumId)?.album ?? null
  const canApply = preview?.status === 'ready' && !loading && !applying

  const apply = async () => {
    if (!preview || preview.status !== 'ready') return
    setApplying(true)
    setError(null)
    try {
      await applyTrackAlbumMove(preview)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }

  return (
    <ModalShell
      title="Mover a álbum"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={applying}>Cancelar</button>
          <button type="button" className="btn primary" disabled={!canApply} onClick={() => { void apply() }}>
            {applying
              ? (preview?.replacement?.incomingIsBetter ? 'Reemplazando...' : 'Moviendo...')
              : (preview?.replacement?.incomingIsBetter ? 'Reemplazar' : 'Mover')}
          </button>
        </>
      )}
    >
      <div className="album-move-modal">
        <div className="album-move-search">
          <Icon name="search" size={14} />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Buscar álbum"
            autoFocus
          />
        </div>

        <div className="album-move-picker" role="listbox" aria-label="Álbum destino">
          {candidates.map(({ album, score }) => {
            const id = albumDbId(album)
            if (id == null) return null
            return (
              <button
                key={album.id}
                type="button"
                className={id === targetAlbumId ? 'selected' : ''}
                onClick={() => setTargetAlbumId(id)}
              >
                <span className="album-move-pick-text">
                  <strong>{album.title}</strong>
                  <em>{album.artist} · {album.year || '-'} · {album.tracks.length}</em>
                </span>
                <span className="album-move-percent" title={albumMoveSuggestionLabel(score)}>
                  {albumMoveSuggestionPercent(score)}%
                </span>
              </button>
            )
          })}
          {candidates.length === 0 && <div className="album-move-empty">No hay álbumes locales coincidentes.</div>}
        </div>

        {preview && preview.slots.length > 0 && (
          <div className="album-move-slotpick">
            <div className="album-move-slotpick-head">
              <span>Pista</span>
              {!preview.trackNumberFromMusicBrainz && (
                <em>MusicBrainz no devolvió el número — elegí la pista (se recomienda la libre).</em>
              )}
            </div>
            <div className="album-move-slots" role="listbox" aria-label="Número de pista destino">
              {preview.slots.map(slot => {
                const isSelected = slot.trackNumber === preview.selectedTrackNumber
                const isSuggested = slot.trackNumber === preview.suggestedTrackNumber && !slot.occupiedBy
                const className = [
                  'album-move-slot',
                  slot.occupiedBy ? 'occupied' : 'free',
                  isSelected ? 'selected' : '',
                  isSuggested ? 'suggested' : '',
                ].filter(Boolean).join(' ')
                const hint = slot.occupiedBy
                  ? `Ocupada: ${slot.occupiedBy.title} (${albumMoveQualityLabel(slot.occupiedBy.quality)})`
                  : 'Libre'
                return (
                  <button
                    key={slot.trackNumber}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={className}
                    title={hint}
                    onClick={() => setTrackNumberOverride(slot.trackNumber)}
                  >
                    {slot.trackNumber}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {preview?.replacement && (
          <div className={`album-move-replace ${preview.replacement.incomingIsBetter ? 'ok' : 'blocked'}`}>
            <span>{preview.replacement.incomingIsBetter ? 'Reemplazo por mejor calidad' : 'No se reemplaza'}</span>
            <div className="album-move-replace-grid">
              <div>
                <small title={preview.replacement.title}>Existente · {preview.replacement.title}</small>
                <strong>{albumMoveQualityLabel(preview.replacement.existing)}</strong>
              </div>
              <span className="album-move-replace-arrow" aria-hidden="true">→</span>
              <div>
                <small>Entrante</small>
                <strong>{albumMoveQualityLabel(preview.replacement.incoming)}</strong>
              </div>
            </div>
            <em>
              {preview.replacement.incomingIsBetter
                ? 'La pista existente irá a la papelera (recuperable).'
                : 'La pista existente tiene calidad igual o superior; elegí otra pista.'}
            </em>
          </div>
        )}

        <div className="album-move-preview">
          <div>
            <span>Actual</span>
            <strong>{track.t}</strong>
            <em>{track.artist} · {track.albumTitle}</em>
            <small title={track.path}>{track.path}</small>
          </div>
          <div>
            <span>Destino</span>
            <strong>{preview?.proposal?.title ?? track.t}</strong>
            <em>{selectedAlbum ? `${selectedAlbum.artist} · ${selectedAlbum.title}` : '-'}</em>
            <small title={preview?.proposal?.destinationPath}>{preview?.proposal?.destinationPath ?? '-'}</small>
          </div>
        </div>

        <div className="album-move-facts">
          <div><span>Track</span><strong>{formatTrackPosition(preview)}</strong></div>
          <div><span>Archivo</span><strong>{preview?.proposal?.filename ?? '-'}</strong></div>
          <div><span>Confianza</span><strong>{preview?.proposal ? (preview.proposal.musicBrainzConfidence > 0 ? `${Math.round(preview.proposal.musicBrainzConfidence * 100)}%` : 'Sin confirmar') : '-'}</strong></div>
        </div>

        {loading && <div className="modal-muted">Validando en MusicBrainz...</div>}
        {preview?.errors.map(item => <div className="modal-error" key={item}>{item}</div>)}
        {preview?.warnings.map(item => <div className="modal-muted" key={item}>{item}</div>)}
        {error && <div className="modal-error">{error}</div>}
      </div>
    </ModalShell>
  )
}

function PlaylistPickerModal({ tracks, onClose }: { tracks: Track[]; onClose: () => void }) {
  const playlists = usePlaylists().filter(p => p.kind === 'manual')
  const firstPlaylistId = playlists.map(playlistDbId).find((id): id is number => id != null)
  const [selectedId, setSelectedId] = useState<number | ''>(firstPlaylistId ?? '')
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ids = trackDbIds(tracks)

  const addExisting = async () => {
    if (selectedId === '') return
    setSaving(true)
    setError(null)
    try {
      await addTracksToPlaylist(selectedId, ids)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const createNew = async () => {
    setSaving(true)
    setError(null)
    try {
      await createPlaylistWithTracks(newName, ids)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell title="Agregar a playlist" onClose={onClose}>
      <div className="playlist-picker">
        <div className="modal-muted">{tracks.length === 1 ? tracks[0].t : `${tracks.length} temas seleccionados`}</div>
        <div className="playlist-picker-row">
          <select
            value={selectedId}
            onChange={event => setSelectedId(event.target.value ? Number(event.target.value) : '')}
            disabled={playlists.length === 0 || saving}
          >
            {playlists.length === 0 && <option value="">No hay playlists manuales</option>}
            {playlists.map(playlist => {
              const id = playlistDbId(playlist)
              if (id == null) return null
              return <option key={playlist.id} value={id}>{playlist.name}</option>
            })}
          </select>
          <button type="button" className="btn" disabled={selectedId === '' || saving || ids.length === 0} onClick={() => { void addExisting() }}>
            Agregar
          </button>
        </div>
        <div className="playlist-picker-row">
          <input
            value={newName}
            onChange={event => setNewName(event.target.value)}
            placeholder="Nueva playlist"
            disabled={saving}
          />
          <button type="button" className="btn primary" disabled={!newName.trim() || saving || ids.length === 0} onClick={() => { void createNew() }}>
            Crear
          </button>
        </div>
        {error && <div className="modal-error">{error}</div>}
      </div>
    </ModalShell>
  )
}

function ConfirmTrashModal({
  title,
  message,
  tracks,
  onClose,
}: {
  title: string
  message: string
  tracks: Track[]
  onClose: () => void
}) {
  const ids = trackDbIds(tracks)

  const onConfirm = () => {
    onClose()
    void trashTracksWithAnimation(ids)
  }

  return (
    <ModalShell
      title={title}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn danger" disabled={ids.length === 0} onClick={onConfirm}>
            Mover a Papelera
          </button>
        </>
      )}
    >
      <p className="modal-copy">{message}</p>
      <div className="trash-list">
        {tracks.slice(0, 8).map(track => <div key={track.id}>{track.t}</div>)}
        {tracks.length > 8 && <div>+ {tracks.length - 8} más</div>}
      </div>
    </ModalShell>
  )
}

function AlbumDetailsModal({ album, onClose }: { album: Album; onClose: () => void }) {
  const totalDuration = album.tracks.reduce((sum, track) => sum + track.d, 0)
  const totalSize = album.tracks.reduce((sum, track) => sum + (track.fileSize ?? 0), 0)

  return (
    <ModalShell title="Datos del álbum" onClose={onClose}>
      <div className="detail-grid">
        <DetailRow label="Álbum" value={album.title} />
        <DetailRow label="Album artist" value={album.artist || '-'} />
        <DetailRow label="Año" value={album.year || '-'} />
        <DetailRow label="Género" value={album.genre || '-'} />
        <DetailRow label="Tracks" value={album.tracks.length} />
        <DetailRow label="Duración" value={fmtTotal(totalDuration)} />
        <DetailRow label="Tamaño" value={formatBytes(totalSize)} />
      </div>
      <div className="modal-list">
        {album.tracks.map(track => (
          <div key={track.id} className="modal-list-row">
            <span>{track.no || '-'}</span>
            <strong>{track.t}</strong>
            <em title={track.path}>{track.path}</em>
          </div>
        ))}
      </div>
    </ModalShell>
  )
}

function AlbumMetadataEditor({ album, onClose }: { album: Album; onClose: () => void }) {
  const inferredTotalTracks = album.tracks[0]?.totalTracks ?? album.tracks.length
  const inferredTotalDiscs = album.tracks[0]?.totalDiscs ?? null
  const [albumTitle, setAlbumTitle] = useState(album.title)
  const [albumArtist, setAlbumArtist] = useState(album.artist)
  const [genre, setGenre] = useState(album.genre)
  const [year, setYear] = useState(album.year ? String(album.year) : '')
  const [totalTracks, setTotalTracks] = useState(inferredTotalTracks ? String(inferredTotalTracks) : '')
  const [totalDiscs, setTotalDiscs] = useState(inferredTotalDiscs ? String(inferredTotalDiscs) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const ids = trackDbIds(album.tracks)
    setSaving(true)
    setError(null)
    try {
      const payload: TrackMetadataUpdatePayload = {
        album: albumTitle,
        albumArtist: albumArtist.trim() || null,
        genre,
        year,
        totalTracks: parseOptionalInt(totalTracks),
        totalDiscs: parseOptionalInt(totalDiscs),
      }
      await updateTracksMetadata(ids, payload)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell
      title="Editar álbum"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button type="submit" form="album-metadata-form" className="btn primary" disabled={saving}>
            Guardar
          </button>
        </>
      )}
    >
      <form id="album-metadata-form" className="metadata-form" onSubmit={onSubmit}>
        <Field label="Álbum" value={albumTitle} onChange={setAlbumTitle} />
        <Field label="Album artist" value={albumArtist} onChange={setAlbumArtist} />
        <Field label="Género" value={genre} onChange={setGenre} />
        <Field label="Año" value={year} onChange={setYear} type="number" />
        <div className="form-grid-2">
          <Field label="Total tracks" value={totalTracks} onChange={setTotalTracks} type="number" />
          <Field label="Total discos" value={totalDiscs} onChange={setTotalDiscs} type="number" />
        </div>
        {error && <div className="modal-error">{error}</div>}
      </form>
    </ModalShell>
  )
}

export function useTrackActions() {
  const [menu, setMenu] = useState<MenuState<Track> | null>(null)
  const [dialog, setDialog] = useState<TrackDialog | null>(null)
  const requestMetadataFix = useNavIntentStore(s => s.requestMetadataFix)

  const openTrackMenu = (event: MouseEvent<HTMLElement>, track: Track) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY, target: track })
  }

  const openPlaylistPicker = (track: Track) => {
    if (track.dbId == null) return
    setDialog({ kind: 'playlist', tracks: [track] })
  }

  const items = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return []
    const track = menu.target
    const disabled = track.dbId == null
    return [
      {
        id: 'favorite',
        label: track.loved ? 'Quitar de favoritos' : 'Agregar a favoritos',
        icon: track.loved ? 'heartF' : 'heart',
        disabled,
        onSelect: () => { if (track.dbId != null) void toggleTrackFavorite(track.dbId, !track.loved) },
      },
      {
        id: 'playlist',
        label: 'Agregar a playlist...',
        icon: 'plus',
        disabled,
        onSelect: () => setDialog({ kind: 'playlist', tracks: [track] }),
      },
      { id: 'sep-1', divider: true },
      {
        id: 'details',
        label: 'Ver datos del archivo',
        icon: 'info',
        onSelect: () => setDialog({ kind: 'details', track }),
      },
      {
        id: 'edit',
        label: 'Editar metadatos...',
        icon: 'edit',
        disabled,
        onSelect: () => setDialog({ kind: 'edit', track }),
      },
      {
        id: 'move-album',
        label: 'Mover a álbum...',
        icon: 'album',
        disabled,
        onSelect: () => setDialog({ kind: 'moveAlbum', track }),
      },
      {
        id: 'complete-metadata',
        label: 'Completar metadatos...',
        icon: 'sparkle',
        disabled,
        onSelect: () => requestMetadataFix(trackDbIds([track]), track.t),
      },
      {
        id: 'lyrics',
        label: 'Buscar letras',
        icon: 'lyrics',
        disabled,
        onSelect: () => { if (track.dbId != null) void window.api.lyrics?.fetchForSelection([track.dbId]) },
      },
      { id: 'sep-2', divider: true },
      {
        id: 'trash',
        label: 'Mover archivo a Papelera...',
        icon: 'trash',
        danger: true,
        disabled,
        onSelect: () => setDialog({ kind: 'trash', tracks: [track] }),
      },
    ]
  }, [menu, requestMetadataFix])

  const elements = (
    <>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      {dialog?.kind === 'playlist' && <PlaylistPickerModal tracks={dialog.tracks} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'details' && <TrackDetailsModal track={dialog.track} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <TrackMetadataEditor track={dialog.track} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'moveAlbum' && <TrackAlbumMoveModal track={dialog.track} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'trash' && (
        <ConfirmTrashModal
          title="Mover archivo a Papelera"
          message="El archivo se moverá a la Papelera del sistema y se quitará de la biblioteca."
          tracks={dialog.tracks}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  )

  return { openTrackMenu, openPlaylistPicker, elements }
}

export function useAlbumActions() {
  const [menu, setMenu] = useState<MenuState<Album> | null>(null)
  const [dialog, setDialog] = useState<AlbumDialog | null>(null)
  const playNow = useQueueStore(s => s.playNow)
  const requestMetadataFix = useNavIntentStore(s => s.requestMetadataFix)

  const openAlbumMenu = (event: MouseEvent<HTMLElement>, album: Album) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY, target: album })
  }

  const playAlbum = (album: Album) => {
    if (album.tracks.length === 0) return
    void playNow(album.tracks[0], album.tracks)
  }

  const shuffleAlbum = (album: Album) => {
    if (album.tracks.length === 0) return
    const tracks = [...album.tracks]
    for (let i = tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[tracks[i], tracks[j]] = [tracks[j], tracks[i]]
    }
    void playNow(tracks[0], tracks)
  }

  const items = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return []
    const album = menu.target
    const hasTracks = album.tracks.length > 0
    const hasDbTracks = trackDbIds(album.tracks).length > 0
    return [
      {
        id: 'play',
        label: 'Reproducir álbum',
        icon: 'play',
        disabled: !hasTracks,
        onSelect: () => playAlbum(album),
      },
      {
        id: 'shuffle',
        label: 'Shuffle',
        icon: 'shuffle',
        disabled: !hasTracks,
        onSelect: () => shuffleAlbum(album),
      },
      { id: 'sep-1', divider: true },
      {
        id: 'details',
        label: 'Ver metadatos',
        icon: 'info',
        disabled: !hasTracks,
        onSelect: () => setDialog({ kind: 'details', album }),
      },
      {
        id: 'edit',
        label: 'Editar metadatos del álbum...',
        icon: 'edit',
        disabled: !hasDbTracks,
        onSelect: () => setDialog({ kind: 'edit', album }),
      },
      {
        id: 'complete-metadata',
        label: 'Completar metadatos...',
        icon: 'sparkle',
        disabled: !hasDbTracks,
        onSelect: () => requestMetadataFix(trackDbIds(album.tracks), album.title),
      },
      { id: 'sep-2', divider: true },
      {
        id: 'trash',
        label: 'Mover álbum a Papelera...',
        icon: 'trash',
        danger: true,
        disabled: !hasDbTracks,
        onSelect: () => setDialog({ kind: 'trash', album }),
      },
    ]
  }, [menu, requestMetadataFix])

  const elements = (
    <>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      {dialog?.kind === 'details' && <AlbumDetailsModal album={dialog.album} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <AlbumMetadataEditor album={dialog.album} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'trash' && (
        <ConfirmTrashModal
          title="Mover álbum a Papelera"
          message="Todos los archivos de audio de este álbum se moverán a la Papelera del sistema. No se borrarán carpetas contenedoras."
          tracks={dialog.album.tracks}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  )

  return { openAlbumMenu, elements }
}
