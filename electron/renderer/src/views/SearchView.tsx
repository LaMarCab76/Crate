import { useState } from 'react'
import type { Album, Artist, Track } from '@shared/types/library'
import { Artwork } from '@renderer/components/Artwork'
import { Icon } from '@renderer/components/Icon'
import { TrackTable } from '@renderer/components/TrackTable'
import { mockLibrary } from '@renderer/data/mockLibrary'

interface Props {
  onSelectAlbum?: (al: Album) => void
  onSelectArtist?: (ar: Artist) => void
  playingId?: string
  onPlay?: (t: Track) => void
}

export function SearchView({ onSelectAlbum, onSelectArtist, playingId, onPlay }: Props) {
  const [q, setQ] = useState('halcyon')
  const ql = q.toLowerCase()
  const trackRes = mockLibrary.tracks.filter(t => (t.t + t.artist + t.albumTitle).toLowerCase().includes(ql)).slice(0, 6)
  const albRes = mockLibrary.albums.filter(a => (a.title + a.artist).toLowerCase().includes(ql)).slice(0, 6)
  const artRes = mockLibrary.artists.filter(a => a.name.toLowerCase().includes(ql)).slice(0, 6)

  return (
    <div className="search-page">
      <div className="search-bigbar">
        <Icon name="search" size={18} style={{ color: 'var(--text-secondary)' }} />
        <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search your library…" />
        {q && (
          <button className="tb-icon-btn" onClick={() => setQ('')}>
            <Icon name="close" size={14} />
          </button>
        )}
      </div>

      {q ? (
        <>
          {trackRes.length > 0 && (
            <div className="search-section">
              <h3>Songs</h3>
              <TrackTable tracks={trackRes} showArt showPlays={false} playingId={playingId} onPlay={onPlay} />
            </div>
          )}
          {albRes.length > 0 && (
            <div className="search-section">
              <h3>Albums</h3>
              <div className="grid" style={{ padding: 0 }}>
                {albRes.map(al => (
                  <div key={al.id} className="card" onClick={() => onSelectAlbum?.(al)} role="button" tabIndex={0}>
                    <div className="art"><Artwork album={al} /></div>
                    <div className="ti">{al.title}</div>
                    <div className="su">{al.artist}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {artRes.length > 0 && (
            <div className="search-section">
              <h3>Artists</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
                {artRes.map(ar => (
                  <div
                    key={ar.id}
                    className="card"
                    style={{ width: 120 }}
                    onClick={() => onSelectArtist?.(ar)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="art" style={{ borderRadius: '50%', overflow: 'hidden' }}>
                      <Artwork album={{ seed: ar.seed, palette: ar.palette, pattern: ar.pattern }} />
                    </div>
                    <div className="ti" style={{ textAlign: 'center' }}>{ar.name}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="search-section">
          <h3>Recent searches</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {['Halcyon', 'Folio', 'Atrium Six', 'High-Res', 'Petrichor'].map(s => (
              <div key={s} className="sb-item" style={{ margin: 0 }} onClick={() => setQ(s.toLowerCase())} role="button" tabIndex={0}>
                <Icon name="recent" size={14} /> {s}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
