import { useMemo } from 'react'
import type { GenreAlbumSortBy, GenresSortBy } from '@renderer/utils/listSort'
import type { Album } from '@shared/types/library'
import { Artwork } from '@renderer/components/Artwork'
import { useAlbumActions } from '@renderer/components/MediaActions'
import { ListPrefsMenu, SortDirectionButton } from '@renderer/components/ListPrefsMenu'
import { useVisibleAlbums } from '@renderer/stores/libraryStore'
import { sortAlbums, sortGenreGroupsByNameOrCount } from '@renderer/utils/listSort'
import { createListPrefsDefaults } from '@renderer/utils/listSort'
import { useListPrefs } from '@renderer/stores/settingsStore'

const GENRE_SORT_OPTIONS: Array<{ value: GenresSortBy, label: string }> = [
  { value: 'name', label: 'Nombre de género' },
  { value: 'albumCount', label: 'Cantidad de álbumes' },
]

const ALBUM_SORT_OPTIONS: Array<{ value: GenreAlbumSortBy, label: string }> = [
  { value: 'dateAdded', label: 'Date Added' },
  { value: 'title', label: 'Título' },
  { value: 'artist', label: 'Artista' },
  { value: 'year', label: 'Año' },
]

function byGenreLabel(sortBy: GenresSortBy): string {
  return GENRE_SORT_OPTIONS.find(option => option.value === sortBy)?.label ?? sortBy
}

function byAlbumLabel(sortBy: GenreAlbumSortBy): string {
  return ALBUM_SORT_OPTIONS.find(option => option.value === sortBy)?.label ?? sortBy
}

export function GenresView({ onSelectAlbum }: { onSelectAlbum?: (al: Album) => void }) {
  const albums = useVisibleAlbums()
  const [prefs, setPrefs] = useListPrefs('genres')
  const albumActions = useAlbumActions()
  const defaults = useMemo(() => createListPrefsDefaults(), [])

  const groups = useMemo(() => {
    const byGenre: Record<string, Album[]> = {}
    const query = prefs.query.trim().toLowerCase()

    albums.forEach(a => {
      const genre = a.genre || 'Unknown'
      if (query && !genre.toLowerCase().includes(query)) return
      const bucket = byGenre[genre] || []
      bucket.push(a)
      byGenre[genre] = bucket
    })

    const grouped = Object.entries(byGenre).map(([genre, list]) => [
      genre,
      sortAlbums(list, prefs.albumSortBy, prefs.albumSortDir),
    ] as [string, Album[]])

    return sortGenreGroupsByNameOrCount(grouped, prefs.sortBy, prefs.sortDir)
  }, [albums, prefs.query, prefs.sortBy, prefs.sortDir, prefs.albumSortBy, prefs.albumSortDir])

  if (albums.length === 0) {
    return (
      <div style={{ padding: 48, color: 'var(--text-secondary)' }}>
        No music yet. Add a folder from Library Sources to import your music.
      </div>
    )
  }

  if (groups.length === 0) {
    return (
      <div className="search-section" style={{ padding: 24, color: 'var(--text-tertiary)' }}>
        No hay resultados para este filtro.
      </div>
    )
  }

  return (
    <>
      <div className="lib-head">
        <div>
          <h1>Genres</h1>
          <div className="sub">
            {groups.length} géneros · Ordenado por {byGenreLabel(prefs.sortBy)}{prefs.sortDir === 'desc' ? ' · Desc' : ' · Asc'} · {`Álbums ordenados por ${byAlbumLabel(prefs.albumSortBy)}${prefs.albumSortDir === 'desc' ? ' (desc)' : ' (asc)'}`}
            {prefs.query.trim() ? ` · Filtrado por texto “${prefs.query.trim()}”` : ''}
          </div>
        </div>
        <div className="actions list-toolbar">
          <ListPrefsMenu buttonLabel="Filtro" menuTitle="Géneros" onReset={() => setPrefs(defaults.genres)}>
            <div className="list-prefs-row">
              <div className="list-prefs-label">Ordenar géneros por</div>
              <div className="list-prefs-row-inline">
                <select
                  className="list-select"
                  value={prefs.sortBy}
                  onChange={e => setPrefs({ sortBy: e.target.value as GenresSortBy })}
                >
                  {GENRE_SORT_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <SortDirectionButton
                  direction={prefs.sortDir}
                  onToggle={() => setPrefs({ sortDir: prefs.sortDir === 'asc' ? 'desc' : 'asc' })}
                />
              </div>
            </div>
            <div className="list-prefs-row">
              <div className="list-prefs-label">Ordenar álbumes por</div>
              <div className="list-prefs-row-inline">
                <select
                  className="list-select"
                  value={prefs.albumSortBy}
                  onChange={e => setPrefs({ albumSortBy: e.target.value as GenreAlbumSortBy })}
                  aria-label="Ordenar álbumes del género"
                >
                  {ALBUM_SORT_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <SortDirectionButton
                  direction={prefs.albumSortDir}
                  onToggle={() => setPrefs({ albumSortDir: prefs.albumSortDir === 'asc' ? 'desc' : 'asc' })}
                />
              </div>
            </div>
          </ListPrefsMenu>
        </div>
      </div>

      <div style={{ padding: '0 20px 28px' }}>
        {groups.map(([g, list]) => (
          <div key={g} style={{ marginBottom: 24 }}>
            <div className="sec-head" style={{ padding: '8px 0 8px' }}>
              <h2>{g}</h2>
              <div className="muted tiny">{list.length} album{list.length > 1 ? 'es' : ''}</div>
            </div>
            <div className="grid" style={{ padding: 0 }}>
              {list.map(al => (
                <div
                  key={al.id}
                  className="card"
                  onClick={() => onSelectAlbum?.(al)}
                  onContextMenu={e => albumActions.openAlbumMenu(e, al)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="art"><Artwork album={al} /></div>
                  <div className="ti">{al.title}</div>
                  <div className="su">{al.artist}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {albumActions.elements}
    </>
  )
}
