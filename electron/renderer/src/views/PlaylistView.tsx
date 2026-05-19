import type { Playlist } from '@shared/types/library'
import { Artwork } from '@renderer/components/Artwork'
import { Icon } from '@renderer/components/Icon'
import { TrackTable } from '@renderer/components/TrackTable'
import { fmtTotal } from '@renderer/utils/format'
import { useAlbums } from '@renderer/stores/libraryStore'

interface Props {
  playlist: Playlist
}

export function PlaylistView({ playlist }: Props) {
  const albums = useAlbums()
  if (!playlist) return null
  if (playlist.tracks.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          padding: 48,
          gap: 16,
          color: 'var(--text-secondary)',
        }}
      >
        <Icon name="heartF" size={48} />
        <h1 style={{ margin: 0, fontSize: 22, color: 'var(--text-primary)' }}>
          Aún no hay canciones favoritas
        </h1>
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          Esta playlist inteligente está siempre disponible. Marcá canciones con el corazón para irla llenando.
        </div>
      </div>
    )
  }

  const total = playlist.tracks.reduce((s, t) => s + t.d, 0)
  return (
    <>
      <div className="album-hero">
        <div
          className="art"
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 0 }}
        >
          {playlist.tracks.slice(0, 4).map((t, i) => {
            const al = albums.find(a => a.id === t.albumId)
            return <div key={i} style={{ overflow: 'hidden' }}><Artwork album={al} radius={0} /></div>
          })}
        </div>
        <div className="meta">
          <div className="kicker">{playlist.kind === 'smart' ? 'Smart Playlist' : 'Playlist'}</div>
          <h1>{playlist.name}</h1>
          {playlist.desc && <div className="credits" style={{ marginBottom: 4 }}>{playlist.desc}</div>}
          <div className="credits">{playlist.tracks.length} tracks · {fmtTotal(total)}</div>
          <div className="ctas">
            <button className="btn primary"><Icon name="play" size={12} /> Play</button>
            <button className="btn"><Icon name="shuffle" size={14} /> Shuffle</button>
            {playlist.kind === 'smart' && (
              <button className="btn"><Icon name="sliders" size={14} /> Edit Rules</button>
            )}
            <button className="btn ghost icon"><Icon name="ellipsis" /></button>
          </div>
        </div>
      </div>
      <TrackTable tracks={playlist.tracks} showArt />
    </>
  )
}
