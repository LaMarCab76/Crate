import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { Icon } from '@renderer/components/Icon'
import { useDeviceLibrary, useDeviceStore } from '@renderer/stores/deviceStore'
import { fmtFileSize, fmtTime } from '@renderer/utils/format'
import type {
  DeviceAlbumSummary,
  DeviceArtistSummary,
  DevicePlaylistSummary,
  DeviceTrack,
  RockboxThemeSummary,
} from '@shared/types/device-sync'

export type DeviceLibrarySection = 'tracks' | 'albums' | 'artists' | 'playlists' | 'rockboxThemes'

const SECTION_TITLES: Record<DeviceLibrarySection, string> = {
  tracks: 'Temas',
  albums: 'Álbumes',
  artists: 'Artistas',
  playlists: 'Playlists',
  rockboxThemes: 'Rockbox Themes',
}

function TrackRows({ tracks }: { tracks: DeviceTrack[] }) {
  if (tracks.length === 0) return <div className="device-empty">No hay temas escaneados.</div>
  return (
    <div className="device-track-table">
      {tracks.slice(0, 500).map(track => (
        <div className="device-track-row" key={track.key}>
          <span className="device-track-title">{track.title}</span>
          <span>{track.artist || 'Unknown Artist'}</span>
          <span>{track.album || 'Unknown Album'}</span>
          <span className="mono">{fmtTime(track.duration)}</span>
          <span className="mono">{fmtFileSize(track.fileSize)}</span>
        </div>
      ))}
      {tracks.length > 500 && (
        <div className="device-empty compact">{tracks.length - 500} temas más ocultos</div>
      )}
    </div>
  )
}

function AlbumRows({ albums }: { albums: DeviceAlbumSummary[] }) {
  if (albums.length === 0) return <div className="device-empty">No hay álbumes en el dispositivo.</div>
  return (
    <div className="device-entity-table">
      {albums.map(album => (
        <div className="device-entity-row" key={album.id}>
          <Icon name="album" size={16} />
          <span className="device-entity-main">
            <strong>{album.title}</strong>
            <em>{album.artist}</em>
          </span>
          <span>{album.trackCount} temas</span>
          <span className="mono">{fmtTime(album.duration)}</span>
          <span className="mono">{fmtFileSize(album.fileSize)}</span>
        </div>
      ))}
    </div>
  )
}

function ArtistRows({ artists }: { artists: DeviceArtistSummary[] }) {
  if (artists.length === 0) return <div className="device-empty">No hay artistas en el dispositivo.</div>
  return (
    <div className="device-entity-table">
      {artists.map(artist => (
        <div className="device-entity-row" key={artist.id}>
          <Icon name="artist" size={16} />
          <span className="device-entity-main">
            <strong>{artist.name}</strong>
            <em>{artist.albumCount} álbumes</em>
          </span>
          <span>{artist.trackCount} temas</span>
          <span className="mono">{fmtTime(artist.duration)}</span>
          <span className="mono">{fmtFileSize(artist.fileSize)}</span>
        </div>
      ))}
    </div>
  )
}

function PlaylistRows({ playlists }: { playlists: DevicePlaylistSummary[] }) {
  if (playlists.length === 0) return <div className="device-empty">No hay playlists M3U en el dispositivo.</div>
  return (
    <div className="device-entity-table">
      {playlists.map(playlist => (
        <div className="device-entity-row" key={playlist.id}>
          <Icon name="queue" size={16} />
          <span className="device-entity-main">
            <strong>{playlist.name}</strong>
            <em>{playlist.relativePath}</em>
          </span>
          <span>{playlist.trackCount} temas</span>
          <span>{playlist.missingCount > 0 ? `${playlist.missingCount} faltantes` : 'OK'}</span>
        </div>
      ))}
    </div>
  )
}

function ThemeRows({ themes }: { themes: RockboxThemeSummary[] }) {
  if (themes.length === 0) return <div className="device-empty">No hay temas Rockbox instalados.</div>
  return (
    <div className="device-entity-table">
      {themes.map(theme => (
        <div className="device-theme-row" key={theme.id}>
          <Icon name="sparkle" size={16} />
          <span className="device-entity-main">
            <strong>{theme.name}</strong>
            <em>{theme.configPath}</em>
          </span>
          <span>{theme.wpsPath ? 'WPS' : '-'}</span>
          <span>{theme.sbsPath ? 'SBS' : '-'}</span>
          <span>{theme.font ?? '-'}</span>
        </div>
      ))}
    </div>
  )
}

export function DeviceLibraryView({
  deviceId,
  section,
}: {
  deviceId: string
  section: DeviceLibrarySection
}) {
  const devices = useDeviceStore(s => s.devices)
  const loading = useDeviceStore(s => s.loading)
  const error = useDeviceStore(s => s.error)
  const load = useDeviceStore(s => s.load)
  const loadDeviceLibrary = useDeviceStore(s => s.loadDeviceLibrary)
  const installRockboxThemes = useDeviceStore(s => s.installRockboxThemes)
  const themeInstallResult = useDeviceStore(s => s.themeInstallResult)
  const library = useDeviceLibrary(deviceId)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    if (devices.length === 0) void load()
  }, [devices.length, load])

  useEffect(() => {
    void loadDeviceLibrary(deviceId)
  }, [deviceId, loadDeviceLibrary])

  const device = useMemo(
    () => library?.device ?? devices.find(item => item.id === deviceId) ?? null,
    [deviceId, devices, library?.device],
  )

  const refresh = () => {
    void loadDeviceLibrary(deviceId, true)
  }

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragOver(false)
    const files = Array.from(event.dataTransfer.files ?? [])
    if (files.length === 0) return
    try {
      await installRockboxThemes(deviceId, files)
    } catch {
      /* store surfaces the error */
    }
  }

  function renderSection() {
    if (!library) return <div className="device-empty large">Cargando dispositivo...</div>
    switch (section) {
      case 'tracks':
        return <TrackRows tracks={library.tracks} />
      case 'albums':
        return <AlbumRows albums={library.albums} />
      case 'artists':
        return <ArtistRows artists={library.artists} />
      case 'playlists':
        return <PlaylistRows playlists={library.playlists} />
      case 'rockboxThemes':
        return (
          <div
            className={`device-theme-panel ${dragOver ? 'drag-over' : ''}`}
            onDragOver={event => {
              event.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={event => { void onDrop(event) }}
          >
            <div className="device-theme-drop">
              <Icon name="drop" size={26} stroke={1.3} />
              <div>
                <strong>Soltá carpetas o ZIP de Rockbox</strong>
                <span>Se instalan dentro de .rockbox/themes, .rockbox/wps, fonts, icons y backdrops.</span>
              </div>
            </div>
            {themeInstallResult && (
              <div className={themeInstallResult.failed > 0 ? 'device-error inline' : 'sync-result-ok'}>
                {themeInstallResult.installed} instalados, {themeInstallResult.skipped} omitidos, {themeInstallResult.failed} fallidos.
              </div>
            )}
            <ThemeRows themes={library.rockboxThemes} />
          </div>
        )
    }
  }

  return (
    <div className="device-browser-page">
      <div className="lib-head">
        <div>
          <h1>{device?.name ?? 'Dispositivo'}</h1>
          <div className="sub">
            {SECTION_TITLES[section]} · {device?.rootPath ?? deviceId}
          </div>
        </div>
        <div className="actions">
          <button className="btn" type="button" disabled={loading} onClick={refresh}>
            <Icon name="rotate" size={13} /> Actualizar
          </button>
        </div>
      </div>

      {error && <div className="device-error">{error}</div>}

      {library && (
        <div className="device-browser-summary">
          <span>{library.summary.trackCount} temas</span>
          <span>{library.summary.albumCount} álbumes</span>
          <span>{library.summary.artistCount} artistas</span>
          <span>{library.summary.playlistCount} playlists</span>
          {device?.hasRockbox && <span>{library.summary.rockboxThemeCount} themes</span>}
        </div>
      )}

      <div className="device-browser-content">
        {renderSection()}
      </div>
    </div>
  )
}
