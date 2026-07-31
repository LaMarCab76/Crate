import { useMemo, useState } from 'react'
import type { Album, Artist } from '@shared/types/library'
import { pickArtistArtwork, resetArtistArtwork, setArtistArtworkFromAlbum } from '@renderer/stores/libraryStore'
import { Artwork } from './Artwork'
import { Icon } from './Icon'
import { ModalShell } from './ModalShell'

interface Props {
  artist: Artist
  onClose: () => void
}

function albumSubtitle(album: Album): string {
  const parts = [album.year > 0 ? String(album.year) : '', `${album.tracks.length} tracks`]
  return parts.filter(Boolean).join(' · ')
}

export function ArtistArtworkPicker({ artist, onClose }: Props) {
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const albumsWithArtwork = useMemo(
    () => artist.albums.filter(album => album.artworkPath),
    [artist.albums],
  )
  const canEdit = artist.dbId != null

  const run = async (key: string, action: () => Promise<void | boolean>) => {
    if (!canEdit || busyKey) return
    setBusyKey(key)
    setError(null)
    try {
      const shouldClose = await action()
      if (shouldClose !== false) onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo cambiar la imagen del artista.')
    } finally {
      setBusyKey(null)
    }
  }

  const chooseFile = () => run('upload', () => pickArtistArtwork(artist.dbId!))

  const selectAlbum = (album: Album) => run(album.id, () => (
    setArtistArtworkFromAlbum(artist.dbId!, album.id)
  ))

  const reset = () => run('reset', () => resetArtistArtwork(artist.dbId!))

  return (
    <ModalShell
      title="Imagen del artista"
      onClose={onClose}
      footer={(
        <>
          {artist.artworkSourceType && (
            <button className="btn ghost artist-artwork-reset" type="button" disabled={Boolean(busyKey)} onClick={() => { void reset() }}>
              Usar selección automática
            </button>
          )}
          <button className="btn" type="button" disabled={Boolean(busyKey)} onClick={onClose}>Cancelar</button>
        </>
      )}
    >
      <div className="artist-artwork-dialog">
        <p className="modal-copy">
          Elegí una portada de la discografía o cargá una imagen propia. El cambio se guarda sólo para {artist.name}.
        </p>

        <button
          className="artist-artwork-upload"
          type="button"
          disabled={!canEdit || Boolean(busyKey)}
          onClick={() => { void chooseFile() }}
        >
          <span className="artist-artwork-upload-icon"><Icon name="upload" size={18} /></span>
          <span>
            <strong>{busyKey === 'upload' ? 'Cargando imagen…' : 'Cargar una imagen'}</strong>
            <small>JPG, PNG, WebP o HEIC</small>
          </span>
        </button>

        <div className="artist-artwork-section-head">
          <span>Portadas de álbumes</span>
          <small>{albumsWithArtwork.length}</small>
        </div>

        {albumsWithArtwork.length > 0 ? (
          <div className="artist-artwork-grid">
            {albumsWithArtwork.map(album => {
              const selected = artist.artworkSourceType === 'album' && artist.artworkPath === album.artworkPath
              return (
                <button
                  key={album.id}
                  className={`artist-artwork-option${selected ? ' selected' : ''}`}
                  type="button"
                  disabled={Boolean(busyKey)}
                  aria-pressed={selected}
                  onClick={() => { void selectAlbum(album) }}
                >
                  <span className="artist-artwork-cover"><Artwork album={album} radius={6} /></span>
                  <span className="artist-artwork-option-copy">
                    <strong>{album.title}</strong>
                    <small>{busyKey === album.id ? 'Guardando…' : albumSubtitle(album)}</small>
                  </span>
                  {selected && <span className="artist-artwork-check"><Icon name="check" size={12} /></span>}
                </button>
              )
            })}
          </div>
        ) : (
          <div className="artist-artwork-empty">Este artista todavía no tiene portadas disponibles.</div>
        )}

        {error && <div className="modal-error" role="alert">{error}</div>}
      </div>
    </ModalShell>
  )
}
