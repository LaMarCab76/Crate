import { type FormEvent, type MouseEvent, type ReactNode, useMemo, useState } from 'react'
import type { Album, Playlist, Track } from '@shared/types/library'
import type { TrackMetadataUpdatePayload } from '@shared/types/ipc-contract'
import { fmtTime, fmtTotal } from '@renderer/utils/format'
import {
  addTracksToPlaylist,
  createPlaylistWithTracks,
  toggleTrackFavorite,
  trashTracks,
  updateTrackMetadata,
  updateTracksMetadata,
  usePlaylists,
} from '@renderer/stores/libraryStore'
import { useQueueStore } from '@renderer/stores/queueStore'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { Icon } from './Icon'
import { MetadataCompletionModal } from './MetadataCompletionModal'

type TrackDialog =
  | { kind: 'playlist'; tracks: Track[] }
  | { kind: 'details'; track: Track }
  | { kind: 'edit'; track: Track }
  | { kind: 'metadata'; tracks: Track[] }
  | { kind: 'trash'; tracks: Track[] }

type AlbumDialog =
  | { kind: 'details'; album: Album }
  | { kind: 'edit'; album: Album }
  | { kind: 'metadata'; album: Album }
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
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ids = trackDbIds(tracks)

  const onConfirm = async () => {
    setWorking(true)
    setError(null)
    try {
      const result = await trashTracks(ids)
      if (result.failed.length > 0) {
        setError(result.failed.map(f => `${f.title}: ${f.error}`).join('\n'))
        return
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(false)
    }
  }

  return (
    <ModalShell
      title={title}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={working}>Cancelar</button>
          <button type="button" className="btn danger" disabled={working || ids.length === 0} onClick={() => { void onConfirm() }}>
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
      {error && <pre className="modal-error">{error}</pre>}
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
        id: 'complete-metadata',
        label: 'Completar metadatos...',
        icon: 'sparkle',
        disabled,
        onSelect: () => setDialog({ kind: 'metadata', tracks: [track] }),
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
  }, [menu])

  const elements = (
    <>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      {dialog?.kind === 'playlist' && <PlaylistPickerModal tracks={dialog.tracks} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'details' && <TrackDetailsModal track={dialog.track} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <TrackMetadataEditor track={dialog.track} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'metadata' && (
        <MetadataCompletionModal trackIds={trackDbIds(dialog.tracks)} onClose={() => setDialog(null)} />
      )}
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
        onSelect: () => setDialog({ kind: 'metadata', album }),
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
  }, [menu])

  const elements = (
    <>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      {dialog?.kind === 'details' && <AlbumDetailsModal album={dialog.album} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <AlbumMetadataEditor album={dialog.album} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'metadata' && (
        <MetadataCompletionModal trackIds={trackDbIds(dialog.album.tracks)} onClose={() => setDialog(null)} />
      )}
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
