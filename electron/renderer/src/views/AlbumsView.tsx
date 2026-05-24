import { type MouseEvent, useMemo, useState } from 'react'
import type { AlbumsSortBy } from '@renderer/utils/listSort'
import type { Album } from '@shared/types/library'
import { Artwork } from '@renderer/components/Artwork'
import { Icon } from '@renderer/components/Icon'
import { ListPrefsMenu } from '@renderer/components/ListPrefsMenu'
import { useVisibleAlbums } from '@renderer/stores/libraryStore'
import { useListPrefs } from '@renderer/stores/settingsStore'
import { createListPrefsDefaults, albumMatchesQuery, sortAlbums } from '@renderer/utils/listSort'
import { useQueueStore } from '@renderer/stores/queueStore'
import { useAlbumActions } from '@renderer/components/MediaActions'

type AlbumsViewMode = 'albums' | 'recent'

const ALBUMS_SORT_OPTIONS: Array<{ value: AlbumsSortBy, label: string }> = [
  { value: 'dateAdded', label: 'Date Added' },
  { value: 'title', label: 'Título' },
  { value: 'artist', label: 'Artista' },
  { value: 'year', label: 'Año' },
]

function formatAlbumSort(sortBy: AlbumsSortBy): string {
  return ALBUMS_SORT_OPTIONS.find(o => o.value === sortBy)?.label ?? sortBy
}

export function AlbumsView({
  onSelect,
  mode = 'albums',
}: {
  onSelect?: (al: Album) => void
  mode?: AlbumsViewMode
}) {
  const albums = useVisibleAlbums()
  const [prefs, setPrefs] = useListPrefs('albums')
  const defaults = useMemo(() => createListPrefsDefaults(), [])
  const playNow = useQueueStore(s => s.playNow)
  const albumActions = useAlbumActions()
  const title = mode === 'recent' ? 'Recently Added' : 'Albums'

  const visibleAlbums = useMemo(() => {
    // Recently Added is a fixed view: always newest-first by date added,
    // decoupled from the Albums sort/filter preferences.
    if (mode === 'recent') {
      return sortAlbums(albums, 'dateAdded', 'desc')
    }

    const query = prefs.query.trim().toLowerCase()
    const list = albums.filter(album => {
      if (prefs.onlyWithArtwork && !album.artworkPath) return false

      if (prefs.yearMin != null && album.year < prefs.yearMin) return false
      if (prefs.yearMax != null && album.year > prefs.yearMax) return false

      if (!query) return true
      return albumMatchesQuery(album, query)
    })

    return sortAlbums(list, prefs.sortBy, prefs.sortDir)
  }, [mode, albums, prefs.onlyWithArtwork, prefs.query, prefs.sortBy, prefs.sortDir, prefs.yearMin, prefs.yearMax])

  const playAlbum = (album: Album, e?: MouseEvent<HTMLElement>) => {
    if (e) e.stopPropagation()
    if (!album.tracks || album.tracks.length === 0) return
    void playNow(album.tracks[0], album.tracks)
  }

  if (albums.length === 0) {
    return (
      <div style={{ padding: 48, color: 'var(--text-secondary)' }}>
        No albums yet. Add a folder from Library Sources to import your music.
      </div>
    )
  }

  if (visibleAlbums.length === 0) {
    return <div style={{ padding: 48, color: 'var(--text-tertiary)' }}>No hay resultados para este filtro.</div>
  }

  const sortLabel = formatAlbumSort(prefs.sortBy)
  const filters = [
    ...prefs.query.trim() ? [`texto “${prefs.query.trim()}”`] : [],
    ...(prefs.onlyWithArtwork ? ['con carátula'] : []),
    ...(prefs.yearMin != null ? [`desde ${prefs.yearMin}`] : []),
    ...(prefs.yearMax != null ? [`hasta ${prefs.yearMax}`] : []),
  ]

  const subtitle =
    mode === 'recent'
      ? `${visibleAlbums.length} álbum${visibleAlbums.length === 1 ? '' : 's'} · Ordenado por Date Added · Desc`
      : `${visibleAlbums.length} álbum${visibleAlbums.length === 1 ? '' : 's'} · ` +
        `Ordenado por ${sortLabel}${prefs.sortDir === 'desc' ? ' · Desc' : ' · Asc'}` +
        (filters.length > 0 ? ` · Filtrado por ${filters.join(', ')}` : '')

  return (
    <>
      <div className="lib-head">
        <div>
          <h1>{title}</h1>
          <div className="sub">{subtitle}</div>
        </div>
        {mode === 'albums' && (
        <div className="actions list-toolbar">
          <ListPrefsMenu buttonLabel="Filtro" menuTitle="Albums" onReset={() => setPrefs(defaults.albums)}>
            <div className="list-prefs-row">
              <div className="list-prefs-label">Buscar</div>
              <input
                className="list-input"
                value={prefs.query}
                placeholder="Título, artista o género"
                onChange={e => setPrefs({ query: e.target.value })}
              />
            </div>
            <div className="list-prefs-row">
              <div className="list-prefs-label">Ordenar por</div>
              <div className="list-prefs-row-inline">
                <select
                  className="list-select"
                  value={prefs.sortBy}
                  onChange={e => setPrefs({ sortBy: e.target.value as AlbumsSortBy })}
                >
                  {ALBUMS_SORT_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <button
                  className="btn sm"
                  onClick={() => setPrefs({ sortDir: prefs.sortDir === 'asc' ? 'desc' : 'asc' })}
                >
                  {prefs.sortDir === 'asc' ? 'Asc' : 'Desc'}
                </button>
              </div>
            </div>
            <div className="list-prefs-row-inline">
              <label className="list-toggle">
                <input
                  type="checkbox"
                  checked={prefs.onlyWithArtwork}
                  onChange={e => setPrefs({ onlyWithArtwork: e.target.checked })}
                />
                Solo con arte
              </label>
            </div>
            <div className="list-prefs-row">
              <div className="list-prefs-label">Filtrar por año</div>
              <div className="list-prefs-row-inline">
                <input
                  className="list-input list-input--small"
                  type="number"
                  placeholder="Desde"
                  value={prefs.yearMin ?? ''}
                  onChange={e => {
                    const value = e.target.value.trim()
                    const parsed = value ? Number(value) : null
                    setPrefs({ yearMin: Number.isFinite(parsed) ? parsed : null })
                  }}
                />
                <input
                  className="list-input list-input--small"
                  type="number"
                  placeholder="Hasta"
                  value={prefs.yearMax ?? ''}
                  onChange={e => {
                    const value = e.target.value.trim()
                    const parsed = value ? Number(value) : null
                    setPrefs({ yearMax: Number.isFinite(parsed) ? parsed : null })
                  }}
                />
              </div>
            </div>
          </ListPrefsMenu>
        </div>
        )}
      </div>
      <div className="grid">
        {visibleAlbums.map(al => (
          <div
            key={al.id}
            className="card"
            onClick={() => onSelect?.(al)}
            onContextMenu={e => albumActions.openAlbumMenu(e, al)}
            role="button"
            tabIndex={0}
          >
            <div className="art">
              <Artwork album={al} radius={6} />
              <div className="play-overlay">
                <button
                  type="button"
                  className="pb"
                  onClick={e => {
                    playAlbum(al, e)
                  }}
                  title="Play album"
                >
                  <Icon name="play" size={14} />
                </button>
              </div>
            </div>
            <div className="ti">{al.title}</div>
            <div className="su">{al.artist}</div>
          </div>
        ))}
      </div>
      {albumActions.elements}
    </>
  )
}
