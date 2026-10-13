import { useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { Album, Artist } from '@shared/types/library'
import { Artwork } from '@renderer/components/Artwork'
import { ListPrefsMenu, SortDirectionButton } from '@renderer/components/ListPrefsMenu'
import { Icon } from '@renderer/components/Icon'
import { useListPrefs } from '@renderer/stores/settingsStore'
import { useAlbumActions } from '@renderer/components/MediaActions'
import {
  createListPrefsDefaults,
  sortArtistAlbums,
  sortTracks,
  type ArtistAlbumSortBy,
  type ArtistTrackSortBy,
} from '@renderer/utils/listSort'
import { DiscGroupedTrackTable } from '@renderer/components/TrackTable'
import { fmtFileSize, fmtTotal } from '@renderer/utils/format'
import { toggleArtistFavorite, useArtistByUiId } from '@renderer/stores/libraryStore'
import { useQueueStore } from '@renderer/stores/queueStore'
import { ArtistArtworkPicker } from '@renderer/components/ArtistArtworkPicker'

interface Props {
  artist: Artist
  onSelectAlbum?: (al: Album) => void
}

interface ArtistAlbumBlockProps {
  album: Album
  onSelectAlbum?: (al: Album) => void
  onOpenAlbumMenu: (event: ReactMouseEvent<HTMLElement>, album: Album) => void
  trackSortBy: ArtistTrackSortBy
  trackSortDir: 'asc' | 'desc'
}

const TRACK_SORT_OPTIONS: Array<{ value: ArtistTrackSortBy, label: string }> = [
  { value: 'trackNo', label: 'Pista' },
  { value: 'title', label: 'Título' },
  { value: 'duration', label: 'Duración' },
  { value: 'plays', label: 'Reproducciones' },
]

const ALBUM_SORT_OPTIONS: Array<{ value: ArtistAlbumSortBy, label: string }> = [
  { value: 'year', label: 'Año' },
  { value: 'title', label: 'Título' },
  { value: 'trackCount', label: 'Pistas' },
]

function trackSortLabel(value: ArtistTrackSortBy): string {
  return TRACK_SORT_OPTIONS.find(option => option.value === value)?.label ?? value
}

function albumSortLabel(value: ArtistAlbumSortBy): string {
  return ALBUM_SORT_OPTIONS.find(option => option.value === value)?.label ?? value
}

function ArtistAlbumBlock({
  album: al,
  onSelectAlbum,
  onOpenAlbumMenu,
  trackSortBy,
  trackSortDir,
}: ArtistAlbumBlockProps) {
  const playNow = useQueueStore(state => state.playNow)
  const playShuffled = useQueueStore(state => state.playShuffled)
  const tracks = useMemo(
    () => sortTracks(al.tracks, trackSortBy, trackSortDir),
    [al.tracks, trackSortBy, trackSortDir],
  )
  const total = tracks.reduce((s, t) => s + t.d, 0)
  const totalSize = tracks.reduce((s, t) => s + (t.fileSize ?? 0), 0)

  return (
    <div
      className="artist-album"
      onContextMenu={e => onOpenAlbumMenu(e, al)}
    >
      <div className="aa-head">
        <div className="aa-art" onClick={() => onSelectAlbum?.(al)} onKeyDown={event => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onSelectAlbum?.(al)
        }} role="button" tabIndex={0}>
          <Artwork album={al} radius={6} />
        </div>
        <div className="aa-meta">
          <div className="aa-kicker">{al.genre} · {al.year}</div>
          <div className="aa-title" onClick={() => onSelectAlbum?.(al)} onKeyDown={event => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            onSelectAlbum?.(al)
          }} role="button" tabIndex={0}>
            {al.title}
          </div>
          <div className="aa-sub">{tracks.length} tracks · {fmtTotal(total)} · {fmtFileSize(totalSize)}</div>
        </div>
        <div className="aa-actions">
          <button className="btn sm" type="button" onClick={() => { if (tracks[0]) void playNow(tracks[0], tracks) }}><Icon name="play" size={11} /> Play</button>
          <button className="btn ghost icon sm" type="button" title="Shuffle" onClick={() => { void playShuffled(tracks) }}><Icon name="shuffle" size={13} /></button>
          <button
            className="btn ghost icon sm"
            title="More"
            onClick={e => onOpenAlbumMenu(e, al)}
          >
            <Icon name="ellipsis" size={14} />
          </button>
        </div>
      </div>
      <DiscGroupedTrackTable
        tracks={tracks}
        showArt={false}
        showAlbum={false}
        showPlays={false}
        showSize
        showTrackNo
        showSource={false}
        compact
      />
    </div>
  )
}

export function ArtistView({ artist, onSelectAlbum }: Props) {
  const [mode, setMode] = useState<'discography' | 'albums'>('discography')
  const [artworkPickerOpen, setArtworkPickerOpen] = useState(false)
  const fresh = useArtistByUiId(artist?.id)
  const ar = fresh ?? artist
  const albumActions = useAlbumActions()
  const [prefs, setPrefs] = useListPrefs('artist')
  const defaults = useMemo(() => createListPrefsDefaults(), [])
  const allTracks = ar.albums.flatMap(a => a.tracks)
  const playNow = useQueueStore(state => state.playNow)
  const playShuffled = useQueueStore(state => state.playShuffled)

  const sortedAlbums = useMemo(
    () => sortArtistAlbums(ar.albums, prefs.albumSortBy, prefs.albumSortDir),
    [ar.albums, prefs.albumSortBy, prefs.albumSortDir],
  )

  const totalPlays = allTracks.reduce((s, t) => s + t.plays, 0)
  if (!ar) return null

  return (
    <div className="artist-page">
      <div className="artist-hero">
        <div className="bg">
          <Artwork album={ar} radius={0} />
        </div>
        {ar.dbId != null && (
          <button
            className="artist-artwork-edit"
            type="button"
            aria-haspopup="dialog"
            onClick={() => setArtworkPickerOpen(true)}
          >
            <Icon name="edit" size={13} />
            <span>Cambiar imagen</span>
          </button>
        )}
        <div className="meta">
          <div className="kicker">Artist</div>
          <div className="artist-title-row">
            <h1>{ar.name}</h1>
            {ar.dbId != null && (
              <button
                className="tb-icon-btn artist-fav-btn"
                onClick={() => { void toggleArtistFavorite(ar.dbId!, !ar.favorite) }}
                title={ar.favorite ? 'Remove from favorite artists' : 'Mark as favorite artist'}
              >
                <Icon name={ar.favorite ? 'heartF' : 'heart'} size={16} />
              </button>
            )}
          </div>
          <div className="stat">
            {ar.albums.length} album{ar.albums.length > 1 ? 's' : ''} · {allTracks.length} tracks · {totalPlays} plays
            {` · Álbumes ordenadas por ${albumSortLabel(prefs.albumSortBy)} (${prefs.albumSortDir})`}
            {` · Tracks ordenados por ${trackSortLabel(prefs.trackSortBy)} (${prefs.trackSortDir})`}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn primary" type="button" onClick={() => { if (allTracks[0]) void playNow(allTracks[0], allTracks) }}><Icon name="play" size={12} /> Play</button>
            <button className="btn" type="button" onClick={() => { void playShuffled(allTracks) }}><Icon name="shuffle" size={14} /> Shuffle</button>
          </div>
        </div>
      </div>

      <div className="artist-view-controls">
        <div aria-hidden />
        <div className="view-toggle" role="group" aria-label="Vista del artista">
          <button className={mode === 'discography' ? 'on' : ''} onClick={() => setMode('discography')} title="Álbumes con pistas">
            <Icon name="list" size={13} /> Discografía
          </button>
          <button className={mode === 'albums' ? 'on' : ''} onClick={() => setMode('albums')} title="Sólo álbumes">
            <Icon name="grid" size={13} /> Álbumes
          </button>
        </div>
        <div className="actions list-toolbar artist-view-filter">
          <ListPrefsMenu
            buttonLabel="Filtro"
            menuTitle="Artista"
            onReset={() => setPrefs(defaults.artist)}
          >
            <div className="list-prefs-row">
              <div className="list-prefs-label">Ordenar álbumes</div>
              <div className="list-prefs-row-inline">
                <select
                  className="list-select"
                  value={prefs.albumSortBy}
                  onChange={e => setPrefs({ albumSortBy: e.target.value as ArtistAlbumSortBy })}
                  aria-label="Ordenar álbumes"
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
            <div className="list-prefs-row">
              <div className="list-prefs-label">Ordenar tracks</div>
              <div className="list-prefs-row-inline">
                <select
                  className="list-select"
                  value={prefs.trackSortBy}
                  onChange={e => setPrefs({ trackSortBy: e.target.value as ArtistTrackSortBy })}
                  aria-label="Ordenar tracks"
                >
                  {TRACK_SORT_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <SortDirectionButton
                  direction={prefs.trackSortDir}
                  onToggle={() => setPrefs({ trackSortDir: prefs.trackSortDir === 'asc' ? 'desc' : 'asc' })}
                />
              </div>
            </div>
          </ListPrefsMenu>
        </div>
      </div>

      {mode === 'discography' ? (
        sortedAlbums.map(al => (
          <ArtistAlbumBlock
            key={al.id}
            album={al}
            onSelectAlbum={onSelectAlbum}
            onOpenAlbumMenu={albumActions.openAlbumMenu}
            trackSortBy={prefs.trackSortBy}
            trackSortDir={prefs.trackSortDir}
          />
        ))
      ) : (
        <div className="artist-grid grid">
          {sortedAlbums.map(al => (
            <div
              key={al.id}
              className="card"
              onClick={() => onSelectAlbum?.(al)}
              onContextMenu={e => albumActions.openAlbumMenu(e, al)}
              role="button"
              tabIndex={0}
            >
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
      {artworkPickerOpen && <ArtistArtworkPicker artist={ar} onClose={() => setArtworkPickerOpen(false)} />}
      {albumActions.elements}
    </div>
  )
}
