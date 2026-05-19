import { useState } from 'react'
import type { Album, Artist } from '@shared/types/library'
import { Artwork } from '@renderer/components/Artwork'
import { Icon } from '@renderer/components/Icon'
import { TrackTable } from '@renderer/components/TrackTable'
import { fmtTotal } from '@renderer/utils/format'
import { toggleArtistFavorite, useArtistByUiId } from '@renderer/stores/libraryStore'

interface Props {
  artist: Artist
  onSelectAlbum?: (al: Album) => void
}

export function ArtistView({ artist, onSelectAlbum }: Props) {
  const [mode, setMode] = useState<'discography' | 'albums'>('discography')
  const fresh = useArtistByUiId(artist?.id)
  const ar = fresh ?? artist
  if (!ar) return null

  const allTracks = ar.albums.flatMap(a => a.tracks)
  const sortedAlbums = [...ar.albums].sort((a, b) => b.year - a.year)

  return (
    <>
      <div className="artist-hero">
        <div className="bg">
          <Artwork album={{ seed: ar.seed, palette: ar.palette, pattern: ar.pattern }} radius={0} />
        </div>
        <div className="meta">
          <div className="kicker">Artist</div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span>{ar.name}</span>
            {ar.dbId != null && (
              <button
                className="tb-icon-btn"
                onClick={() => { void toggleArtistFavorite(ar.dbId!, !ar.favorite) }}
                title={ar.favorite ? 'Remove from favorite artists' : 'Mark as favorite artist'}
                style={{ width: 28, height: 28 }}
              >
                <Icon name={ar.favorite ? 'heartF' : 'heart'} size={16} />
              </button>
            )}
          </h1>
          <div className="stat">
            {ar.albums.length} album{ar.albums.length > 1 ? 's' : ''} · {allTracks.length} tracks ·{' '}
            {allTracks.reduce((s, t) => s + t.plays, 0)} plays
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
            <button className="btn primary"><Icon name="play" size={12} /> Play</button>
            <button className="btn"><Icon name="shuffle" size={14} /> Shuffle</button>
            <div className="view-toggle" style={{ marginLeft: 'auto' }}>
              <button className={mode === 'discography' ? 'on' : ''} onClick={() => setMode('discography')} title="Albums with tracks">
                <Icon name="list" size={13} /> Discography
              </button>
              <button className={mode === 'albums' ? 'on' : ''} onClick={() => setMode('albums')} title="Albums only">
                <Icon name="grid" size={13} /> Albums
              </button>
            </div>
          </div>
        </div>
      </div>

      {mode === 'discography' ? (
        sortedAlbums.map(al => {
          const total = al.tracks.reduce((s, t) => s + t.d, 0)
          return (
            <div key={al.id} className="artist-album">
              <div className="aa-head">
                <div className="aa-art" onClick={() => onSelectAlbum?.(al)} role="button" tabIndex={0}>
                  <Artwork album={al} radius={6} />
                </div>
                <div className="aa-meta">
                  <div className="aa-kicker">{al.genre} · {al.year}</div>
                  <div className="aa-title" onClick={() => onSelectAlbum?.(al)} role="button" tabIndex={0}>
                    {al.title}
                  </div>
                  <div className="aa-sub">{al.tracks.length} tracks · {fmtTotal(total)}</div>
                </div>
                <div className="aa-actions">
                  <button className="btn sm"><Icon name="play" size={11} /> Play</button>
                  <button className="btn ghost icon sm" title="Shuffle"><Icon name="shuffle" size={13} /></button>
                  <button className="btn ghost icon sm" title="More"><Icon name="ellipsis" size={14} /></button>
                </div>
              </div>
              <TrackTable tracks={al.tracks} showArt={false} showAlbum={false} showPlays={false} />
            </div>
          )
        })
      ) : (
        <div className="grid">
          {sortedAlbums.map(al => (
            <div key={al.id} className="card" onClick={() => onSelectAlbum?.(al)} role="button" tabIndex={0}>
              <div className="art">
                <Artwork album={al} radius={6} />
                <div className="play-overlay"><div className="pb"><Icon name="play" size={14} /></div></div>
              </div>
              <div className="ti">{al.title}</div>
              <div className="su">{al.year} · {al.tracks.length} tracks</div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
