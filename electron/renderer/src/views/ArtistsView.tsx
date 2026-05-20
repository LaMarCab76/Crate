import { useMemo } from 'react'
import type { ArtistsSortBy } from '@renderer/utils/listSort'
import type { Artist } from '@shared/types/library'
import { Artwork } from '@renderer/components/Artwork'
import { Icon } from '@renderer/components/Icon'
import { ListPrefsMenu } from '@renderer/components/ListPrefsMenu'
import { useListPrefs } from '@renderer/stores/settingsStore'
import { createListPrefsDefaults, sortArtists } from '@renderer/utils/listSort'
import { toggleArtistFavorite, useArtists } from '@renderer/stores/libraryStore'

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
  const all = useArtists()
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
          <div className="sub">
            {list.length} artistas
            {filters.length > 0 ? ` · Filtrado por ${filters.join(', ')}` : ''}
            {` · Ordenado por ${sortArtistsLabel(prefs.sortBy)}`}
          </div>
        </div>
        <div className="actions list-toolbar">
          <ListPrefsMenu buttonLabel="Filtro" menuTitle="Artists" onReset={() => setPrefs(defaults.artists)}>
            <div className="list-prefs-row">
              <div className="list-prefs-label">Buscar</div>
              <input
                className="list-input"
                value={prefs.query}
                onChange={e => setPrefs({ query: e.target.value })}
                placeholder="Buscar artista"
                aria-label="Buscar artista"
              />
            </div>
            <div className="list-prefs-row">
              <div className="list-prefs-label">Ordenar por</div>
              <div className="list-prefs-row-inline">
                <select
                  className="list-select"
                  value={prefs.sortBy}
                  onChange={e => setPrefs({ sortBy: e.target.value as ArtistsSortBy })}
                  aria-label="Ordenar artistas"
                >
                  {ARTISTS_SORT_OPTIONS.map(option => (
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
                  checked={prefs.principalOnly}
                  onChange={e => setPrefs({ principalOnly: e.target.checked })}
                />
                Principal
              </label>
            </div>
          </ListPrefsMenu>
        </div>
      </div>
      <div style={{ padding: '4px 12px 24px' }}>
        {list.length === 0 ? (
          <div style={{ padding: 48, color: 'var(--text-secondary)' }}>
            No se encontraron artistas con este filtro.
          </div>
        ) : list.map(ar => (
          <div
            key={ar.id}
            className="sb-item"
            style={{ height: 56, margin: '2px 0', padding: '0 12px', gap: 14 }}
            onClick={() => onSelect?.(ar)}
            role="button"
            tabIndex={0}
          >
            <div style={{ width: 40, height: 40, borderRadius: '50%', overflow: 'hidden', flexShrink: 0 }}>
              <Artwork album={ar} radius={20} />
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{ar.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {ar.albums.length} album{ar.albums.length === 1 ? '' : 'es'} · {ar.trackCount} tracks
              </div>
            </div>
            {ar.dbId != null && (
              <button
                className="tb-icon-btn"
                style={{ marginLeft: 'auto' }}
                onClick={e => {
                  e.stopPropagation()
                  void toggleArtistFavorite(ar.dbId!, !ar.favorite)
                }}
                title={ar.favorite ? 'Remove from favorites' : 'Mark as favorite'}
              >
                <Icon name={ar.favorite ? 'heartF' : 'heart'} size={14} />
              </button>
            )}
            <Icon
              name="chevR"
              size={14}
              style={{ color: 'var(--text-tertiary)' }}
            />
          </div>
        ))}
      </div>
    </>
  )
}
