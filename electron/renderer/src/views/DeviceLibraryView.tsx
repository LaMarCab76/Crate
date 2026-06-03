import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Icon, type IconName } from '@renderer/components/Icon'
import { LoadingState } from '@renderer/components/LoadingState'
import { useDeviceLibrary, useDeviceStore, useRockboxThemeLibrary } from '@renderer/stores/deviceStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { fmtFileSize, fmtTime } from '@renderer/utils/format'
import type {
  DeviceAlbumSummary,
  DeviceArtistSummary,
  DevicePlaylistSummary,
  DeviceTrack,
  RockboxThemeScanDiagnostic,
  RockboxThemeSummary,
} from '@shared/types/device-sync'

// Tracks/albums/artists are merged into a single "library" section with an
// in-view switcher; playlists and rockbox themes stay as their own sections.
export type DeviceLibrarySection = 'library' | 'playlists' | 'rockboxThemes'

export type DeviceLibraryView = 'albums' | 'artists' | 'tracks'

const DEVICE_LIB_VIEW_STORAGE_KEY = 'crate.device.libraryView.v1'

const DEVICE_LIB_VIEWS: Array<{ value: DeviceLibraryView; label: string; icon: IconName }> = [
  { value: 'albums', label: 'Álbumes', icon: 'album' },
  { value: 'artists', label: 'Artistas', icon: 'artist' },
  { value: 'tracks', label: 'Temas', icon: 'song' },
]

function loadDeviceLibView(): DeviceLibraryView {
  if (typeof window === 'undefined') return 'albums'
  try {
    const raw = window.localStorage.getItem(DEVICE_LIB_VIEW_STORAGE_KEY)
    if (raw === 'albums' || raw === 'artists' || raw === 'tracks') return raw
  } catch {
    /* ignore */
  }
  return 'albums'
}

function persistDeviceLibView(view: DeviceLibraryView): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(DEVICE_LIB_VIEW_STORAGE_KEY, view)
  } catch {
    /* ignore */
  }
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

function rockboxThemeScanText(scan: RockboxThemeScanDiagnostic, themeCount: number): string {
  if (scan.status === 'no-rockbox') return 'Sin instalación Rockbox detectada'
  if (scan.status === 'no-themes-dir') return 'Falta .rockbox/themes'
  if (scan.status === 'unreadable') return 'No se pudo leer .rockbox/themes'
  if (themeCount === 0) return 'Sin .cfg directos en .rockbox/themes'
  return `${themeCount} theme${themeCount === 1 ? '' : 's'} válido${themeCount === 1 ? '' : 's'}`
}

function rockboxThemeScanState(scan: RockboxThemeScanDiagnostic, themeCount: number): 'ok' | 'neutral' | 'warning' | 'error' {
  if (scan.status === 'unreadable') return 'error'
  if (scan.status === 'ok' && scan.misplacedConfigPaths.length === 0 && themeCount > 0) return 'ok'
  if (scan.status === 'ok' && themeCount > 0) return 'warning'
  if (scan.status === 'ok') return 'neutral'
  return 'warning'
}

function ThemeOverviewStat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string | number
  tone?: 'neutral' | 'ok' | 'warning'
}) {
  return (
    <span className={`device-theme-overview-stat ${tone}`}>
      <strong>{value}</strong>
      <em>{label}</em>
    </span>
  )
}

function RockboxThemeOverview({
  scan,
  themes,
  loading,
  onImport,
  onRefresh,
}: {
  scan: RockboxThemeScanDiagnostic
  themes: RockboxThemeSummary[]
  loading: boolean
  onImport: () => void
  onRefresh: () => void
}) {
  const missingThemeCount = themes.filter(theme => theme.missingFiles.length > 0).length
  const previewWarningCount = themes.filter(theme => theme.preview.warnings.length > 0).length
  const completeThemeCount = Math.max(0, themes.length - missingThemeCount)
  const state = rockboxThemeScanState(scan, themes.length)

  return (
    <section className={`device-theme-overview ${state}`}>
      <div className="device-theme-overview-main">
        <span className="device-theme-overview-label">
          <Icon name="sparkle" size={13} /> Rockbox Themes
        </span>
        <h2>{rockboxThemeScanText(scan, themes.length)}</h2>
        <p title={scan.themesPath}>{scan.themesPath}</p>
      </div>
      <div className="device-theme-overview-stats" aria-label="Resumen de Rockbox themes">
        <ThemeOverviewStat label="Total" value={themes.length} />
        <ThemeOverviewStat label="Completos" value={completeThemeCount} tone={themes.length > 0 ? 'ok' : 'neutral'} />
        <ThemeOverviewStat label="Faltantes" value={missingThemeCount} tone={missingThemeCount > 0 ? 'warning' : 'neutral'} />
        <ThemeOverviewStat label="Warnings" value={previewWarningCount} tone={previewWarningCount > 0 ? 'warning' : 'neutral'} />
      </div>
      <div className="device-theme-overview-actions">
        <button className="btn ghost" type="button" disabled={loading} onClick={onRefresh}>
          <Icon name="rotate" size={13} /> Actualizar
        </button>
        <button className="btn" type="button" disabled={loading} onClick={onImport}>
          <Icon name="folder" size={13} /> Importar
        </button>
      </div>
    </section>
  )
}

function ThemeScanNotice({
  scan,
  themeCount,
}: {
  scan: RockboxThemeScanDiagnostic
  themeCount: number
}) {
  const hasMisplaced = scan.misplacedConfigPaths.length > 0
  const showDetails = Boolean(scan.message) || hasMisplaced || scan.status !== 'ok' || themeCount === 0
  if (!showDetails) return null

  const state = rockboxThemeScanState(scan, themeCount)
  const visibleMisplaced = scan.misplacedConfigPaths.slice(0, 5)

  return (
    <div className={`device-theme-scan ${state}`}>
      <div className="device-theme-scan-head">
        <strong>{rockboxThemeScanText(scan, themeCount)}</strong>
        <span title={scan.themesPath}>{scan.themesPath}</span>
      </div>
      {scan.message && <p>{scan.message}</p>}
      {hasMisplaced && (
        <div className="device-theme-misplaced">
          <span>Configs fuera de lugar</span>
          {visibleMisplaced.map(path => <code key={path}>{path}</code>)}
          {scan.misplacedConfigPaths.length > visibleMisplaced.length && (
            <em>{scan.misplacedConfigPaths.length - visibleMisplaced.length} más</em>
          )}
        </div>
      )}
    </div>
  )
}

function ThemeFilePill({ label, value, missing = false }: { label: string; value: string | null; missing?: boolean }) {
  return (
    <span
      className={`device-theme-file-pill ${value ? 'present' : ''} ${missing ? 'missing' : ''}`}
      title={value ?? `${label} no configurado`}
    >
      <em>{label}</em>
      <strong>{value || '-'}</strong>
    </span>
  )
}

function encodeAssetPath(path: string): string {
  return path.split('/').map(part => encodeURIComponent(part)).join('/')
}

function rockboxAssetUrl(deviceId: string, path: string): string {
  return `crate://rockbox-theme/${encodeURIComponent(deviceId)}/${encodeAssetPath(path)}`
}

function artworkAssetUrl(filename: string): string {
  return `crate://artwork/${encodeURIComponent(filename)}`
}

function svgId(themeId: string, layerId: string): string {
  return `rb-${themeId}-${layerId}`.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function renderPreviewTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)}}/g, (_match, key: string) => values[key] ?? '')
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function RockboxThemeMiniPreview({
  deviceId,
  theme,
  values,
  progress,
  volume,
  artworkPath,
}: {
  deviceId: string
  theme: RockboxThemeSummary
  values: Record<string, string>
  progress: number
  volume: number
  artworkPath: string | null
}) {
  const preview = theme.preview
  const gradientId = svgId(theme.id, 'album-gradient')
  return (
    <div className="device-theme-screen-frame">
      <svg
        className="device-theme-screen-svg"
        viewBox={`0 0 ${preview.width} ${preview.height}`}
        role="img"
        aria-label={`Preview ${theme.name}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" x2="100%" y1="0%" y2="100%">
            <stop offset="0%" stopColor="#68a7d8" />
            <stop offset="52%" stopColor="#20242a" />
            <stop offset="100%" stopColor="#e3b46d" />
          </linearGradient>
          {preview.layers.map(layer => (
            <clipPath id={svgId(theme.id, `${layer.id}-clip`)} key={`${layer.id}-clip`}>
              <rect x={layer.x} y={layer.y} width={layer.width} height={layer.height} />
            </clipPath>
          ))}
        </defs>
        <rect x="0" y="0" width={preview.width} height={preview.height} fill={`#${preview.backgroundColor}`} />
        {preview.layers.map(layer => {
          const clipPath = `url(#${svgId(theme.id, `${layer.id}-clip`)})`
          switch (layer.type) {
            case 'image':
              return (
                <image
                  key={layer.id}
                  href={rockboxAssetUrl(deviceId, layer.path)}
                  x={layer.x - layer.sourceX}
                  y={layer.y - layer.sourceY}
                  width={layer.intrinsicWidth}
                  height={layer.intrinsicHeight}
                  clipPath={clipPath}
                  preserveAspectRatio="none"
                />
              )
            case 'albumArt':
              return artworkPath ? (
                <image
                  key={layer.id}
                  href={artworkAssetUrl(artworkPath)}
                  x={layer.x}
                  y={layer.y}
                  width={layer.width}
                  height={layer.height}
                  clipPath={clipPath}
                  preserveAspectRatio="xMidYMid slice"
                />
              ) : (
                <g key={layer.id} clipPath={clipPath}>
                  <rect x={layer.x} y={layer.y} width={layer.width} height={layer.height} fill={`url(#${gradientId})`} />
                  <circle cx={layer.x + layer.width * 0.72} cy={layer.y + layer.height * 0.28} r={Math.min(layer.width, layer.height) * 0.18} fill="rgba(255,255,255,0.24)" />
                </g>
              )
            case 'bar': {
              const value = layer.kind === 'progress' ? progress : layer.kind === 'volume' ? volume : layer.value
              return (
                <g key={layer.id}>
                  <rect x={layer.x} y={layer.y} width={layer.width} height={layer.height} fill={`#${layer.trackColor}`} rx={Math.min(2, layer.height / 2)} />
                  <rect x={layer.x} y={layer.y} width={layer.width * clamp01(value)} height={layer.height} fill={`#${layer.color}`} rx={Math.min(2, layer.height / 2)} />
                </g>
              )
            }
            case 'rect':
              return <rect key={layer.id} x={layer.x} y={layer.y} width={layer.width} height={layer.height} fill={`#${layer.color}`} opacity={layer.opacity} />
            case 'text': {
              const anchor = layer.align === 'center' ? 'middle' : layer.align === 'right' ? 'end' : 'start'
              const textX = layer.align === 'center'
                ? layer.x + layer.width / 2
                : layer.align === 'right'
                  ? layer.x + layer.width
                  : layer.x
              return (
                <text
                  key={layer.id}
                  x={textX}
                  y={layer.y + Math.max(1, (layer.height - layer.fontSize) / 2)}
                  fill={`#${layer.color}`}
                  fontSize={layer.fontSize}
                  fontFamily="ui-sans-serif, system-ui"
                  fontWeight="600"
                  textAnchor={anchor}
                  dominantBaseline="hanging"
                  clipPath={clipPath}
                >
                  {renderPreviewTemplate(layer.template, values)}
                </text>
              )
            }
          }
        })}
      </svg>
    </div>
  )
}

function RockboxThemeCard({
  deviceId,
  theme,
  values,
  progress,
  volume,
  artworkPath,
  onDelete,
  loading,
}: {
  deviceId: string
  theme: RockboxThemeSummary
  values: Record<string, string>
  progress: number
  volume: number
  artworkPath: string | null
  onDelete: (theme: RockboxThemeSummary) => void
  loading: boolean
}) {
  const hasMissingFiles = theme.missingFiles.length > 0
  return (
    <article className={`device-theme-card ${hasMissingFiles ? 'warning' : ''}`}>
      <RockboxThemeMiniPreview
        deviceId={deviceId}
        theme={theme}
        values={values}
        progress={progress}
        volume={volume}
        artworkPath={artworkPath}
      />
      <div className="device-theme-card-main">
        <div className="device-theme-card-head">
          <div className="device-theme-card-title">
            <h2 title={theme.name}>{theme.name}</h2>
            <span title={theme.configPath}>{theme.configPath}</span>
          </div>
          <div className="device-theme-card-controls">
            <b className={hasMissingFiles ? 'warning' : 'ok'}>{hasMissingFiles ? `${theme.missingFiles.length} faltantes` : 'Completo'}</b>
            <button
              className="btn icon"
              type="button"
              disabled={loading}
              title="Eliminar theme"
              onClick={() => onDelete(theme)}
            >
              <Icon name="trash" size={12} />
            </button>
          </div>
        </div>
        <div className="device-theme-card-metrics">
          <span>
            <strong>{theme.fileCount}</strong>
            <em>archivos</em>
          </span>
          <span>
            <strong>{theme.preview.width}x{theme.preview.height}</strong>
            <em>preview</em>
          </span>
          <span>
            <strong>{theme.preview.layers.length}</strong>
            <em>capas</em>
          </span>
        </div>
        <div className="device-theme-file-grid">
          <ThemeFilePill label="WPS" value={theme.wpsPath} />
          <ThemeFilePill label="SBS" value={theme.sbsPath} />
          <ThemeFilePill label="FMS" value={theme.fmsPath} />
          <ThemeFilePill label="Font" value={theme.font} missing={theme.font != null && theme.missingFiles.includes(theme.font)} />
          <ThemeFilePill label="Backdrop" value={theme.backdropPath} />
          <ThemeFilePill label="Icons" value={theme.iconsetPath ?? theme.viewerIconsetPath} />
        </div>
        {hasMissingFiles && (
          <div className="device-theme-missing-list">
            <span>Archivos referenciados que no existen</span>
            {theme.missingFiles.slice(0, 4).map(path => <code key={path}>{path}</code>)}
            {theme.missingFiles.length > 4 && <em>{theme.missingFiles.length - 4} más</em>}
          </div>
        )}
        {theme.preview.warnings.length > 0 && (
          <div className="device-theme-missing-list muted">
            {theme.preview.warnings.slice(0, 2).map(warning => <code key={warning}>{warning}</code>)}
          </div>
        )}
      </div>
    </article>
  )
}

function RockboxThemeDropzone({
  dragOver,
}: {
  dragOver: boolean
}) {
  return (
    <div className={`device-theme-drop ${dragOver ? 'active' : ''}`}>
      <Icon name="drop" size={20} stroke={1.3} />
      <div className="device-theme-drop-copy">
        <strong>Soltá ZIP o carpeta</strong>
        <span>.cfg, wps, fonts, icons y backdrops quedan en la estructura Rockbox.</span>
      </div>
    </div>
  )
}

function RockboxThemeEmptyState({
  scan,
}: {
  scan: RockboxThemeScanDiagnostic
}) {
  return (
    <div className="device-theme-empty device-empty large">
      <Icon name="sparkle" size={24} />
      <div>
        <strong>{rockboxThemeScanText(scan, 0)}</strong>
        <span>{scan.message ?? 'No hay themes Rockbox instalados.'}</span>
      </div>
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
  const loadRockboxThemes = useDeviceStore(s => s.loadRockboxThemes)
  const installRockboxThemes = useDeviceStore(s => s.installRockboxThemes)
  const deleteRockboxTheme = useDeviceStore(s => s.deleteRockboxTheme)
  const themeInstallResult = useDeviceStore(s => s.themeInstallResult)
  const library = useDeviceLibrary(deviceId)
  const rockboxThemeLibrary = useRockboxThemeLibrary(deviceId)
  const currentTrack = usePlaybackStore(s => s.currentTrack)
  const positionSec = usePlaybackStore(s => s.positionSec)
  const durationSec = usePlaybackStore(s => s.durationSec)
  const volume = usePlaybackStore(s => s.volume)
  const [dragOver, setDragOver] = useState(false)
  const [libView, setLibView] = useState<DeviceLibraryView>(() => loadDeviceLibView())
  const fileInputRef = useRef<HTMLInputElement>(null)
  const isRockboxSection = section === 'rockboxThemes'

  const changeLibView = (view: DeviceLibraryView) => {
    setLibView(view)
    persistDeviceLibView(view)
  }

  useEffect(() => {
    if (devices.length === 0) void load()
  }, [devices.length, load])

  useEffect(() => {
    if (isRockboxSection) {
      void loadRockboxThemes(deviceId)
    } else {
      void loadDeviceLibrary(deviceId)
    }
  }, [deviceId, isRockboxSection, loadDeviceLibrary, loadRockboxThemes])

  const device = useMemo(
    () => rockboxThemeLibrary?.device ?? library?.device ?? devices.find(item => item.id === deviceId) ?? null,
    [deviceId, devices, library?.device, rockboxThemeLibrary?.device],
  )

  const refresh = () => {
    if (isRockboxSection) {
      void loadRockboxThemes(deviceId, true)
    } else {
      void loadDeviceLibrary(deviceId, true)
    }
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

  const onPickThemeFiles = async (files: FileList | null) => {
    const picked = Array.from(files ?? [])
    if (picked.length === 0) return
    try {
      await installRockboxThemes(deviceId, picked)
    } catch {
      /* store surfaces the error */
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const removeTheme = async (theme: RockboxThemeSummary) => {
    const confirmed = window.confirm(`Eliminar "${theme.name}" de Rockbox? Se borra el .cfg y skins asociados, no fuentes compartidas.`)
    if (!confirmed) return
    try {
      await deleteRockboxTheme(deviceId, theme.id)
    } catch {
      /* store surfaces the error */
    }
  }

  const previewValues = useMemo(() => {
    const duration = durationSec || currentTrack?.d || 218
    const elapsed = Math.min(Math.max(0, positionSec || 0), duration)
    const remaining = Math.max(0, duration - elapsed)
    const now = new Date()
    const clock = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const title = currentTrack?.t || 'Positions'
    const artist = currentTrack?.artist || 'Ariana Grande'
    const album = currentTrack?.albumTitle || 'Positions (Deluxe)'
    const filename = currentTrack?.filename || `${title}.flac`
    const codec = currentTrack?.fmt || currentTrack?.codec || 'FLAC'
    const bitrate = currentTrack?.bitrate ? `${Math.round(currentTrack.bitrate / 1000)}k` : '940'
    const sampleRateKhz = currentTrack?.sampleRate ? `${Math.round(currentTrack.sampleRate / 1000)}` : '44'
    return {
      title,
      artist,
      album,
      year: currentTrack?.year ? String(currentTrack.year) : '2026',
      filename,
      elapsed: fmtTime(elapsed),
      duration: fmtTime(duration),
      remaining: fmtTime(remaining),
      playlistPosition: '114',
      playlistTotal: '2399',
      bitrate,
      codec,
      sampleRateKhz,
      volumeDb: '-12 dB',
      clock,
      nextTitle: 'test drive',
      nextArtist: 'Ariana Grande',
      nextAlbum: 'Positions (Deluxe)',
      nextFilename: '16 - test drive.flac',
    }
  }, [currentTrack, durationSec, positionSec])

  const previewProgress = durationSec > 0 ? clamp01(positionSec / durationSec) : 0.48
  const previewVolume = clamp01(volume)

  function renderSection() {
    if (isRockboxSection) {
      if (!rockboxThemeLibrary) return <LoadingState label="Cargando themes..." />
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
          <RockboxThemeOverview
            scan={rockboxThemeLibrary.scan}
            themes={rockboxThemeLibrary.themes}
            loading={loading}
            onImport={() => fileInputRef.current?.click()}
            onRefresh={refresh}
          />
          <RockboxThemeDropzone dragOver={dragOver} />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden-file-input"
            onChange={event => { void onPickThemeFiles(event.target.files) }}
          />
          {themeInstallResult && (
            <div className={themeInstallResult.failed > 0 ? 'device-error inline' : 'sync-result-ok inline'}>
              {themeInstallResult.installed} instalados, {themeInstallResult.skipped} omitidos, {themeInstallResult.failed} fallidos.
            </div>
          )}
          <ThemeScanNotice scan={rockboxThemeLibrary.scan} themeCount={rockboxThemeLibrary.themes.length} />
          {rockboxThemeLibrary.themes.length === 0 ? (
            <RockboxThemeEmptyState scan={rockboxThemeLibrary.scan} />
          ) : (
            <div className="device-theme-grid">
              {rockboxThemeLibrary.themes.map(theme => (
                <RockboxThemeCard
                  key={theme.id}
                  deviceId={deviceId}
                  theme={theme}
                  values={previewValues}
                  progress={previewProgress}
                  volume={previewVolume}
                  artworkPath={currentTrack?.artworkPath ?? null}
                  onDelete={theme => { void removeTheme(theme) }}
                  loading={loading}
                />
              ))}
            </div>
          )}
        </div>
      )
    }
    if (!library) return <LoadingState label="Cargando dispositivo..." />
    switch (section) {
      case 'library':
        return libView === 'albums'
          ? <AlbumRows albums={library.albums} />
          : libView === 'artists'
            ? <ArtistRows artists={library.artists} />
            : <TrackRows tracks={library.tracks} />
      case 'playlists':
        return <PlaylistRows playlists={library.playlists} />
    }
  }

  return (
    <div className="device-browser-page">
      {!isRockboxSection && (
        <div className={`device-browser-controls ${section !== 'library' ? 'only-actions' : ''}`}>
          {section === 'library' && (
            <nav className="device-subtabs" role="tablist" aria-label="Vista de biblioteca">
              {DEVICE_LIB_VIEWS.map(item => (
                <button
                  key={item.value}
                  className={`device-section-tab ${libView === item.value ? 'active' : ''}`}
                  type="button"
                  role="tab"
                  aria-selected={libView === item.value}
                  title={item.label}
                  onClick={() => changeLibView(item.value)}
                >
                  <Icon name={item.icon} size={13} /> {item.label}
                </button>
              ))}
            </nav>
          )}
          <div className="device-browser-actions">
            <button className="btn" type="button" disabled={loading} onClick={refresh}>
              {loading && library
                ? <span className="track-loading-spinner loading-state-spinner inline" aria-hidden="true" />
                : <Icon name="rotate" size={13} />}
              {' '}Actualizar
            </button>
          </div>
        </div>
      )}

      {error && <div className="device-error">{error}</div>}

      {!isRockboxSection && library && (
        <div className="device-browser-summary">
          <span>{library.summary.trackCount} temas</span>
          <span>{library.summary.albumCount} álbumes</span>
          <span>{library.summary.artistCount} artistas</span>
          <span>{library.summary.playlistCount} playlists</span>
          {device?.hasRockbox && <span>{library.summary.rockboxThemeCount} themes</span>}
          {device?.hasRockbox && (
            <span title={library.rockboxThemeScan.themesPath}>
              {rockboxThemeScanText(library.rockboxThemeScan, library.rockboxThemes.length)}
            </span>
          )}
        </div>
      )}

      <div className="device-browser-content">
        {renderSection()}
      </div>
    </div>
  )
}
