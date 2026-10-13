import { useMemo } from 'react'
import type { ArtistsSortBy } from '@renderer/utils/listSort'
import type { Artist } from '@shared/types/library'
import { Artwork } from '@renderer/components/Artwork'
import { Icon } from '@renderer/components/Icon'
import { ListPrefsDivider, ListPrefsMenu, ListPrefsOptions, SortDirectionButton } from '@renderer/components/ListPrefsMenu'
import { useListPrefs } from '@renderer/stores/settingsStore'
import { createListPrefsDefaults, sortArtists } from '@renderer/utils/listSort'
import { toggleArtistFavorite, useVisibleArtists } from '@renderer/stores/libraryStore'
import { SourceBadge } from '@renderer/components/SourceBadge'

const ARTISTS_SORT_OPTIONS: Array<{ value: ArtistsSortBy, label: string }> = [
  { value: 'name', label: 'Nombre' },
  { value: 'albumCount', label: 'Álbums' },
  { value: 'trackCount', label: 'Tracks' },
  { value: 'favorite', label: 'Favoritos' },
]

function sortArtistsLabel(sortBy: ArtistsSortBy): string {
  return ARTISTS_SORT_OPTIONS.find(option => option.value === sortBy)?.label ?? sortBy
}

export function ArtistsView({ onSelect }: { onSelect?: (ar: Artist) => void }) {
  const all = useVisibleArtists()
  const [prefs, setPrefs] = useListPrefs('artists')
  const defaults = useMemo(() => createListPrefsDefaults(), [])

  const list = useMemo(() => {
    const query = prefs.query.trim().toLowerCase()
    const filtered = all
      .filter(ar => !prefs.principalOnly || ar.trackCount > 0)
      .filter(ar => !query || ar.name.toLowerCase().includes(query))

    return sortArtists(filtered, prefs.sortBy, prefs.sortDir)
  }, [all, prefs.query, prefs.principalOnly, prefs.sortBy, prefs.sortDir])

  const filters = [
    ...prefs.query.trim() ? [`texto “${prefs.query.trim()}”`] : [],
    ...(prefs.principalOnly ? ['solo principales'] : []),
  ]
  const subtitle = `${list.length} artistas` +
    (filters.length > 0 ? ` · Filtrado por ${filters.join(', ')}` : '') +
    ` · Ordenado por ${sortArtistsLabel(prefs.sortBy)}${prefs.sortDir === 'desc' ? ' · Descendente' : ' · Ascendente'}`

  if (all.length === 0) {
    return (
      <div style={{ padding: 48, color: 'var(--text-secondary)' }}>
        No artists yet. Import a folder from Preferences → Library to populate your collection.
      </div>
    )
  }

  return (
    <>
      <div className="lib-head">
        <div>
          <h1>Artists</h1>
          <div className="sub" title={subtitle}>{subtitle}</div>
        </div>
        <div className="actions list-toolbar">
          <ListPrefsMenu buttonLabel="Filtro" menuTitle="Artists" onReset={() => setPrefs(defaults.artists)}>
            <ListPrefsOptions
              label="Ordenar por"
              ariaLabel="Ordenar artistas"
              value={prefs.sortBy}
              options={ARTISTS_SORT_OPTIONS}
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
                checked={prefs.principalOnly}
                onChange={e => setPrefs({ principalOnly: e.target.checked })}
              />
              Principal
            </label>
          </ListPrefsMenu>
        </div>
      </div>
      {list.length === 0 ? (
        <div className="list-empty">No se encontraron artistas con este filtro.</div>
      ) : (
        <div className="grid artists-grid">
          {list.map(ar => (
            <div
              key={ar.id}
              className="card artist-card"
              onClick={() => onSelect?.(ar)}
              onKeyDown={event => {
                if (event.target !== event.currentTarget) return
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                onSelect?.(ar)
              }}
              role="button"
              tabIndex={0}
            >
              <div className="artist-card-cover">
                <div className="art">
                  <Artwork album={ar} radius={0} />
                </div>
                {ar.dbId != null && (
                  <button
                    type="button"
                    className={`artist-card-fav${ar.favorite ? ' on' : ''}`}
                    onClick={e => {
                      e.stopPropagation()
                      void toggleArtistFavorite(ar.dbId!, !ar.favorite)
                    }}
                    title={ar.favorite ? 'Remove from favorites' : 'Mark as favorite'}
                    aria-label={ar.favorite ? 'Remove from favorites' : 'Mark as favorite'}
                    aria-pressed={!!ar.favorite}
                  >
                    <Icon name={ar.favorite ? 'heartF' : 'heart'} size={14} />
                  </button>
                )}
              </div>
              <div className="ti">{ar.name}</div>
              <div className="su with-source">
                <span>{ar.albums.length} album{ar.albums.length === 1 ? '' : 'es'} · {ar.trackCount} tracks</span>
                <SourceBadge
                  folderIds={ar.albums.flatMap(album => album.tracks.map(track => track.folderId))}
                  provider={ar.albums[0]?.tracks[0]?.provider}
                  appearance="icon"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
