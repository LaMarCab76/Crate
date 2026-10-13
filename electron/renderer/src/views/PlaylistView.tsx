import { useMemo } from 'react'
import type { Playlist } from '@shared/types/library'
import type { PlaylistTrackSortBy } from '@renderer/utils/listSort'
import { Icon } from '@renderer/components/Icon'
import { TrackTable } from '@renderer/components/TrackTable'
import { ListPrefsDivider, ListPrefsMenu, ListPrefsOptions, SortDirectionButton } from '@renderer/components/ListPrefsMenu'
import { useListPrefs } from '@renderer/stores/settingsStore'
import { createListPrefsDefaults, sortTracks, trackMatchesQuery } from '@renderer/utils/listSort'
import { fmtTotal } from '@renderer/utils/format'
import { useQueueStore } from '@renderer/stores/queueStore'

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
  const playNow = useQueueStore(state => state.playNow)
  const playShuffled = useQueueStore(state => state.playShuffled)
  const filteredTracks = useMemo(() => {
    const query = prefs.query.trim()
    let next = playlist.tracks
    if (prefs.favoritesOnly) next = next.filter(t => t.loved)
    if (query) next = next.filter(t => trackMatchesQuery(t, query))
    return sortTracks(next, prefs.sortBy, prefs.sortDir)
  }, [playlist.tracks, prefs.favoritesOnly, prefs.query, prefs.sortBy, prefs.sortDir])

  const isEmptyPlaylist = playlist.tracks.length === 0
  const total = filteredTracks.reduce((s, t) => s + t.d, 0)
  const filterBits = [
    ...prefs.query.trim() ? [`texto “${prefs.query.trim()}”`] : [],
    ...(prefs.favoritesOnly ? ['solo favoritas'] : []),
  ]
  const sub = `${filteredTracks.length} tracks · ${fmtTotal(total)} · Ordenado por ${playlistSortLabel(prefs.sortBy)}` +
    (prefs.sortDir === 'desc' ? ' · Descendente' : ' · Ascendente') +
    (filterBits.length > 0 ? ` · Filtrado por ${filterBits.join(', ')}` : '')
  const hasResults = filteredTracks.length > 0

  // Same list header as Songs (the design's "Temas favoritos" list): the title
  // stays in the content, so the toolbar only shows it once it scrolls under
  // the pill, and the Filtro pill stays reachable when nothing matches.
  return (
    <>
      <div className="lib-head">
        <div>
          <h1>{playlist.name}</h1>
          {playlist.desc && <div className="sub">{playlist.desc}</div>}
          {!isEmptyPlaylist && <div className="sub" title={sub}>{sub}</div>}
        </div>
        {!isEmptyPlaylist && (
          <div className="actions list-toolbar">
            <button
              type="button"
              className="btn primary icon"
              title="Play"
              aria-label="Play"
              disabled={!hasResults}
              onClick={() => { if (filteredTracks[0]) void playNow(filteredTracks[0], filteredTracks) }}
            >
              <Icon name="play" size={12} />
            </button>
            <button
              type="button"
              className="btn icon"
              title="Shuffle"
              aria-label="Shuffle"
              disabled={!hasResults}
              onClick={() => { void playShuffled(filteredTracks) }}
            >
              <Icon name="shuffle" size={14} />
            </button>
            <ListPrefsMenu buttonLabel="Filtro" menuTitle="Playlist" onReset={() => setPrefs(defaults[kind])}>
              <ListPrefsOptions
                label="Ordenar por"
                ariaLabel="Ordenar lista"
                value={prefs.sortBy}
                options={PLAYLIST_SORT_OPTIONS}
                onChange={sortBy => setPrefs({ sortBy })}
              />
              <ListPrefsDivider />
              <SortDirectionButton
                direction={prefs.sortDir}
                onToggle={() => setPrefs({ sortDir: prefs.sortDir === 'asc' ? 'desc' : 'asc' })}
              />
              <label className="list-toggle">
                <input
                  type="checkbox"
                  checked={prefs.favoritesOnly}
                  onChange={e => setPrefs({ favoritesOnly: e.target.checked })}
                />
                Solo favoritas
              </label>
            </ListPrefsMenu>
          </div>
        )}
      </div>
      {isEmptyPlaylist ? (
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
          <h2 style={{ margin: 0, fontSize: 22, color: 'var(--text-primary)' }}>
            {isFavoriteView ? 'Aún no hay canciones favoritas' : 'Esta playlist está vacía'}
          </h2>
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            {isFavoriteView
              ? 'Esta playlist inteligente está siempre disponible. Marcá canciones con el corazón para irla llenando.'
              : 'Añadí canciones para comenzar a crear esta playlist.'}
          </div>
        </div>
      ) : hasResults ? (
        <TrackTable tracks={filteredTracks} showArt />
      ) : (
        <div className="list-empty">No hay resultados para este filtro.</div>
      )}
    </>
  )
}
