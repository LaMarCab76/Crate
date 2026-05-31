import { useMemo } from 'react'
import type { Playlist } from '@shared/types/library'
import type { PlaylistTrackSortBy } from '@renderer/utils/listSort'
import { Artwork } from '@renderer/components/Artwork'
import { Icon } from '@renderer/components/Icon'
import { TrackTable } from '@renderer/components/TrackTable'
import { ListPrefsMenu, SortDirectionButton } from '@renderer/components/ListPrefsMenu'
import { useListPrefs } from '@renderer/stores/settingsStore'
import { createListPrefsDefaults, sortTracks, trackMatchesQuery } from '@renderer/utils/listSort'
import { fmtTotal } from '@renderer/utils/format'
import { useAlbums } from '@renderer/stores/libraryStore'

interface Props {
  playlist: Playlist
  kind: 'playlist' | 'favoriteTracks'
}

const PLAYLIST_SORT_OPTIONS: Array<{ value: PlaylistTrackSortBy, label: string }> = [
  { value: 'title', label: 'Título' },
  { value: 'album', label: 'Álbum' },
  { value: 'artist', label: 'Artista' },
  { value: 'plays', label: 'Reproducciones' },
  { value: 'duration', label: 'Duración' },
  { value: 'dateAdded', label: 'Fecha de agregado' },
]

function playlistSortLabel(sortBy: PlaylistTrackSortBy): string {
  return PLAYLIST_SORT_OPTIONS.find(option => option.value === sortBy)?.label ?? sortBy
}

export function PlaylistView({ playlist, kind }: Props) {
  const [prefs, setPrefs] = useListPrefs(kind)
  const defaults = useMemo(() => createListPrefsDefaults(), [])
  const isFavoriteView = kind === 'favoriteTracks'
  const albums = useAlbums()
  const filteredTracks = useMemo(() => {
    const query = prefs.query.trim()
    let next = playlist.tracks
    if (prefs.favoritesOnly) next = next.filter(t => t.loved)
    if (query) next = next.filter(t => trackMatchesQuery(t, query))
    return sortTracks(next, prefs.sortBy, prefs.sortDir)
  }, [playlist.tracks, prefs.favoritesOnly, prefs.query, prefs.sortBy, prefs.sortDir])

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
          {isFavoriteView ? 'Aún no hay canciones favoritas' : 'Esta playlist está vacía'}
        </h1>
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          {isFavoriteView
            ? 'Esta playlist inteligente está siempre disponible. Marcá canciones con el corazón para irla llenando.'
            : 'Añadí canciones para comenzar a crear esta playlist.'}
        </div>
      </div>
    )
  }

  if (filteredTracks.length === 0) {
    return (
      <div className="search-section" style={{ padding: 24, color: 'var(--text-tertiary)' }}>
        No hay resultados para este filtro.
      </div>
    )
  }

  const total = filteredTracks.reduce((s, t) => s + t.d, 0)
  const filterBits = [
    ...prefs.query.trim() ? [`texto “${prefs.query.trim()}”`] : [],
    ...(prefs.favoritesOnly ? ['solo favoritas'] : []),
  ]

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
          <div className="credits">
            {filteredTracks.length} tracks · {fmtTotal(total)}
            · Ordenado por {playlistSortLabel(prefs.sortBy)}
            · {prefs.sortDir === 'desc' ? 'desc' : 'asc'}
            {filterBits.length > 0 ? ` · Filtrado por ${filterBits.join(', ')}` : ''}
          </div>
          <div className="ctas" style={{ marginTop: 8, flexWrap: 'wrap', rowGap: 6 }}>
            <button className="btn primary"><Icon name="play" size={12} /> Play</button>
            <button className="btn"><Icon name="shuffle" size={14} /> Shuffle</button>
            {playlist.kind === 'smart' && (
              <button className="btn"><Icon name="sliders" size={14} /> Edit Rules</button>
            )}
            <button className="btn ghost icon"><Icon name="ellipsis" /></button>
          </div>
          <div className="actions list-toolbar" style={{ marginTop: 12 }}>
            <ListPrefsMenu buttonLabel="Filtro" menuTitle="Playlist" onReset={() => setPrefs(defaults[kind])}>
              <div className="list-prefs-row">
                <div className="list-prefs-label">Ordenar por</div>
                <div className="list-prefs-row-inline">
                  <select
                    className="list-select"
                    value={prefs.sortBy}
                    onChange={e => setPrefs({ sortBy: e.target.value as PlaylistTrackSortBy })}
                    aria-label="Ordenar lista"
                  >
                    {PLAYLIST_SORT_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <SortDirectionButton
                    direction={prefs.sortDir}
                    onToggle={() => setPrefs({ sortDir: prefs.sortDir === 'asc' ? 'desc' : 'asc' })}
                  />
                </div>
              </div>
              <div className="list-prefs-row-inline">
                <label className="list-toggle">
                  <input
                    type="checkbox"
                    checked={prefs.favoritesOnly}
                    onChange={e => setPrefs({ favoritesOnly: e.target.checked })}
                  />
                  Solo favoritas
                </label>
              </div>
            </ListPrefsMenu>
          </div>
        </div>
      </div>
      <TrackTable tracks={filteredTracks} showArt />
    </>
  )
}
