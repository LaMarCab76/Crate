import { useMemo, useState } from 'react'
import { Icon } from '@renderer/components/Icon'
import { TrackTable } from '@renderer/components/TrackTable'
import { ListPrefsMenu } from '@renderer/components/ListPrefsMenu'
import { useListPrefs } from '@renderer/stores/settingsStore'
import { createListPrefsDefaults, trackMatchesQuery, type LibraryTrackSortBy, sortTracks } from '@renderer/utils/listSort'
import { fmtTotal } from '@renderer/utils/format'
import { useLibraryStore, useTracks } from '@renderer/stores/libraryStore'

function EmptyState() {
  const pickFolder = useLibraryStore(s => s.pickFolder)
  const addFolder = useLibraryStore(s => s.addFolder)

  const handleAddFolder = async () => {
    const picked = await pickFolder()
    if (picked) await addFolder(picked)
  }

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 48,
        textAlign: 'center',
        gap: 16,
      }}
    >
      <div style={{ color: 'var(--text-tertiary)' }}>
        <Icon name="folder" size={56} stroke={1.1} />
      </div>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
        Your library is empty
      </h1>
      <p
        style={{
          margin: 0,
          maxWidth: 380,
          color: 'var(--text-secondary)',
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        Add a folder of audio files and Crate will scan it for tracks. FLAC, ALAC,
        AAC, MP3, WAV, AIFF, OGG, OPUS, APE, DSD all supported.
      </p>
      <button className="btn primary" onClick={handleAddFolder}>
        <Icon name="plus" size={12} /> Add Folder…
      </button>
    </div>
  )
}

const LIBRARY_SORT_OPTIONS: Array<{ value: LibraryTrackSortBy, label: string }> = [
  { value: 'dateAdded', label: 'Date Added' },
  { value: 'title', label: 'Título' },
  { value: 'artist', label: 'Artista' },
  { value: 'album', label: 'Álbum' },
  { value: 'plays', label: 'Reproducciones' },
  { value: 'duration', label: 'Duración' },
]

const libraryLabel = (sortBy: LibraryTrackSortBy): string =>
  LIBRARY_SORT_OPTIONS.find(o => o.value === sortBy)?.label ?? sortBy

export function LibraryView() {
  const tracks = useTracks()
  const [prefs, setPrefs] = useListPrefs('library')
  const [defaults] = useState(() => createListPrefsDefaults())
  const visibleTracks = useMemo(() => {
    let next = tracks
    if (prefs.query.trim()) {
      next = next.filter(t => trackMatchesQuery(t, prefs.query))
    }
    if (prefs.favoritesOnly) {
      next = next.filter(t => t.loved)
    }
    return sortTracks(next, prefs.sortBy, prefs.sortDir)
  }, [tracks, prefs.favoritesOnly, prefs.query, prefs.sortBy, prefs.sortDir])

  if (tracks.length === 0) {
    return <EmptyState />
  }

  if (visibleTracks.length === 0) {
    return (
      <div style={{ padding: 48, color: 'var(--text-secondary)' }}>
        No hay resultados para este filtro.
      </div>
    )
  }

  const totalDur = visibleTracks.reduce((s, t) => s + t.d, 0)
  const filters = [
    ...prefs.query.trim() ? [`texto “${prefs.query.trim()}”`] : [],
    ...(prefs.favoritesOnly ? ['favoritas'] : []),
  ]
  const sub = `${visibleTracks.length} tracks · ${fmtTotal(totalDur)} · Ordenado por ${libraryLabel(prefs.sortBy)}${prefs.sortDir === 'desc' ? ' · Descendente' : ' · Ascendente'}${filters.length > 0 ? ` · Filtrado por ${filters.join(', ')}` : ''}`

  return (
    <>
      <div className="lib-head">
        <div>
          <h1>Songs</h1>
          <div className="sub">{sub}</div>
        </div>
        <div className="actions list-toolbar">
          <ListPrefsMenu
            buttonLabel="Filtro"
            buttonIcon="filter"
            menuTitle="Library"
            onReset={() => setPrefs(defaults.library)}
          >
            <div className="list-prefs-row">
              <div className="list-prefs-label">Buscar</div>
              <input
                className="list-input"
                value={prefs.query}
                onChange={e => setPrefs({ query: e.target.value })}
                placeholder="Título, artista, álbum o género"
                aria-label="Buscar canciones"
              />
            </div>
            <div className="list-prefs-row">
              <div className="list-prefs-row-inline">
                <div className="list-prefs-label">Ordenar por</div>
                <select
                  className="list-select"
                  value={prefs.sortBy}
                  onChange={e => setPrefs({ sortBy: e.target.value as LibraryTrackSortBy })}
                  aria-label="Ordenar canciones"
                >
                  {LIBRARY_SORT_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <button
                  className="btn sm"
                  onClick={() => setPrefs({ sortDir: prefs.sortDir === 'asc' ? 'desc' : 'asc' })}
                  title="Alternar dirección"
                >
                  {prefs.sortDir === 'asc' ? 'Asc' : 'Desc'}
                </button>
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
      <TrackTable tracks={visibleTracks} showArt />
    </>
  )
}
