import { useEffect, useState } from 'react'
import type { Album, Artist } from '@shared/types/library'
import type { SearchResultsPayload } from '@shared/types/ipc-contract'
import { Artwork } from '@renderer/components/Artwork'
import { TrackTable } from '@renderer/components/TrackTable'
import { dbToUiAlbum, dbToUiArtist, dbToUiTrack } from '@renderer/stores/adapters'

interface Props {
  query: string
  onSelectAlbum?: (al: Album) => void
  onSelectArtist?: (ar: Artist) => void
}

export function SearchView({ query, onSelectAlbum, onSelectArtist }: Props) {
  const [results, setResults] = useState<SearchResultsPayload>({ tracks: [], albums: [], artists: [] })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let canceled = false
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      setResults({ tracks: [], albums: [], artists: [] })
      setLoading(false)
      return
    }
    setLoading(true)
    const handle = window.setTimeout(async () => {
      try {
        const res = await window.api.library.search(trimmed, 20)
        if (!canceled) setResults(res)
      } finally {
        if (!canceled) setLoading(false)
      }
    }, 120)
    return () => {
      canceled = true
      window.clearTimeout(handle)
    }
  }, [query])

  const tracks = results.tracks.map(dbToUiTrack)
  const albums = results.albums.map(a => dbToUiAlbum(a))
  const artists = results.artists.map(a => dbToUiArtist(a))

  return (
    <div className="search-page">
      {query.trim().length === 0 ? (
        <div className="search-section">
          <h3>Recent searches</h3>
          <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>
            (Recent searches will appear here once you start searching.)
          </div>
        </div>
      ) : loading && tracks.length === 0 && albums.length === 0 && artists.length === 0 ? (
        <div style={{ padding: 24, color: 'var(--text-tertiary)' }}>Searching…</div>
      ) : (
        <>
          {tracks.length > 0 && (
            <div className="search-section">
              <h3>Songs</h3>
              <TrackTable tracks={tracks} showArt showPlays={false} />
            </div>
          )}
          {albums.length > 0 && (
            <div className="search-section">
              <h3>Albums</h3>
              <div className="grid" style={{ padding: 0 }}>
                {albums.map(al => (
                  <div key={al.id} className="card" onClick={() => onSelectAlbum?.(al)} role="button" tabIndex={0}>
                    <div className="art"><Artwork album={al} /></div>
                    <div className="ti">{al.title}</div>
                    <div className="su">{al.artist}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {artists.length > 0 && (
            <div className="search-section">
              <h3>Artists</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
                {artists.map(ar => (
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
          {!loading && tracks.length === 0 && albums.length === 0 && artists.length === 0 && (
            <div style={{ padding: 24, color: 'var(--text-tertiary)' }}>No results for "{query}".</div>
          )}
        </>
      )}
    </div>
  )
}
