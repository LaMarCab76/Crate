import { useEffect, useMemo, useState } from 'react'
import type { PlayerTintSource, Tweak } from '@renderer/stores/settingsStore'
import type { DbFolder } from '@shared/types/db'
import { useEqStore } from '@renderer/stores/eqStore'
import { Icon } from '@renderer/components/Icon'
import { ModalShell } from '@renderer/components/ModalShell'
import { FolderRemovalConfirmModal } from '@renderer/components/FolderRemovalConfirmModal'
import { DeviceConnectModal, type DeviceConnectTarget } from '@renderer/components/DeviceConnectModal'
import { useDeviceStore } from '@renderer/stores/deviceStore'
import { useFolders, useLibraryStore } from '@renderer/stores/libraryStore'
import { DEVICE_ARTWORK_EDGE_MAX, DEVICE_ARTWORK_EDGE_MIN } from '@shared/constants/device-sync'
import { EQ_BAND_LABELS, EQ_GAIN_MAX, EQ_GAIN_MIN, EQ_GAIN_STEP } from '@shared/constants/equalizer'
import { LYRICS_OFFSET_LIMIT_MS, clampLyricsOffsetMs } from '@shared/lyrics/lrc'
import type { LibraryScanEvent, LibraryScanLogPayload, LibraryScanRun, PlaybackCacheStats } from '@shared/types/ipc-contract'
import { COLOR_PRESETS } from '@renderer/utils/colorPresets'
import { clearPlaybackTableBarsMemoryCache } from '@renderer/utils/playbackTableBars'
import { basenameForPath } from '@renderer/utils/devicePaths'
import {
  UP_NEXT_TOAST_END_SEC_MIN,
  UP_NEXT_TOAST_START_SEC_MAX,
  UP_NEXT_TOAST_START_SEC_MIN,
} from '@renderer/utils/upNextToast'

interface Props {
  tweak: Tweak
  setTweak: <K extends keyof Tweak>(key: K, value: Tweak[K]) => void
}

function DeviceDetectionPanel({ tweak, setTweak }: Props) {
  const devices = useDeviceStore(s => s.devices)
  const candidates = useDeviceStore(s => s.candidates)
  const unknownVolumes = useDeviceStore(s => s.unknownVolumes)
  const loading = useDeviceStore(s => s.loading)
  const error = useDeviceStore(s => s.error)
  const refreshVolumes = useDeviceStore(s => s.refreshVolumes)
  const ignoreVolume = useDeviceStore(s => s.ignoreVolume)
  const addFolder = useLibraryStore(s => s.addFolder)
  const folders = useFolders()
  const [manualPath, setManualPath] = useState('')
  const [connectTarget, setConnectTarget] = useState<DeviceConnectTarget | null>(null)

  useEffect(() => {
    void refreshVolumes()
  }, [refreshVolumes])

  const connectedRoots = useMemo(() => new Set(devices.map(device => device.rootPath)), [devices])
  const libraryRoots = useMemo(() => new Set(folders.map(folder => folder.path)), [folders])

  const connectManual = async () => {
    const rootPath = manualPath.trim()
    if (!rootPath) return
    setConnectTarget({ rootPath, name: basenameForPath(rootPath) })
  }

  const pickDeviceRoot = async () => {
    const picked = await window.api.devices.pickRoot()
    if (picked.canceled || !picked.path) return
    setConnectTarget({
      rootPath: picked.path,
      name: basenameForPath(picked.path),
    })
  }

  const addAsLibrary = async (rootPath: string) => {
    await addFolder(rootPath)
    await ignoreVolume(rootPath)
  }

  return (
    <div className="set-card device-settings-panel">
      <div className="set-row">
        <div>
          <div className="lbl">Default device artwork limit</div>
          <div className="sub">Maximum embedded cover edge for newly connected MP3/DAP devices.</div>
        </div>
        <input
          type="number"
          className="number-input"
          min={DEVICE_ARTWORK_EDGE_MIN}
          max={DEVICE_ARTWORK_EDGE_MAX}
          step={1}
          value={tweak.deviceArtworkMaxEdge}
          onChange={e => setTweak('deviceArtworkMaxEdge', Number(e.target.value))}
          aria-label="Default device artwork limit"
        />
      </div>

      <div className="device-settings-actions">
        <button className="btn" type="button" disabled={loading} onClick={() => void refreshVolumes()}>
          <Icon name="rotate" size={13} /> Detectar ahora
        </button>
        <button className="btn primary" type="button" disabled={loading} onClick={() => void pickDeviceRoot()}>
          <Icon name="device" size={13} /> Elegir carpeta/unidad
        </button>
      </div>

      <div className="device-settings-manual">
        <input
          value={manualPath}
          onChange={event => setManualPath(event.target.value)}
          placeholder="/Volumes/iPod"
        />
        <button className="btn" type="button" disabled={loading || !manualPath.trim()} onClick={() => void connectManual()}>
          Agregar DAP
        </button>
      </div>

      {error && <div className="device-error inline">{error}</div>}

      <div className="device-settings-lists">
        <div>
          <h3>Conectados</h3>
          {devices.length === 0 ? (
            <div className="device-empty compact">No hay dispositivos vinculados.</div>
          ) : (
            <div className="device-settings-list">
              {devices.map(device => (
                <div className="device-settings-row" key={device.id}>
                  <Icon name="device" size={15} />
                  <span>
                    <strong>{device.name}</strong>
                    <em>{device.rootPath}</em>
                  </span>
                  <b className={device.isAvailable ? 'online' : ''}>{device.isAvailable ? 'Mounted' : 'Offline'}</b>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3>Detectados</h3>
          {candidates.length === 0 ? (
            <div className="device-empty compact">No hay candidatos Rockbox/Crate.</div>
          ) : (
            <div className="device-settings-list">
              {candidates.map(candidate => (
                <div className="device-settings-row" key={candidate.rootPath}>
                  <Icon name="plus" size={14} />
                  <span>
                    <strong>{candidate.name}</strong>
                    <em>{candidate.rootPath}</em>
                  </span>
                  <button
                    className="btn"
                    type="button"
                    disabled={loading || connectedRoots.has(candidate.rootPath)}
                    onClick={() => setConnectTarget({ rootPath: candidate.rootPath, name: candidate.name })}
                  >
                    Conectar
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h3>Volúmenes sin clasificar</h3>
          {unknownVolumes.length === 0 ? (
            <div className="device-empty compact">No hay volúmenes nuevos pendientes.</div>
          ) : (
            <div className="device-settings-list">
              {unknownVolumes.map(volume => (
                <div className="device-settings-row unknown" key={volume.rootPath}>
                  <Icon name="folder" size={14} />
                  <span>
                    <strong>{volume.name}</strong>
                    <em>{volume.rootPath}</em>
                  </span>
                  <div className="device-settings-inline-actions">
                    <button
                      className="btn"
                      type="button"
                      disabled={loading}
                      onClick={() => setConnectTarget({ rootPath: volume.rootPath, name: volume.name })}
                    >
                      DAP
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={libraryRoots.has(volume.rootPath)}
                      onClick={() => void addAsLibrary(volume.rootPath)}
                    >
                      Biblioteca
                    </button>
                    <button className="btn ghost" type="button" onClick={() => void ignoreVolume(volume.rootPath)}>
                      Ignorar
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {connectTarget && (
        <DeviceConnectModal
          target={connectTarget}
          artworkMaxEdge={tweak.deviceArtworkMaxEdge}
          onConnected={() => {
            if (connectTarget.rootPath === manualPath.trim()) setManualPath('')
          }}
          onClose={() => {
            setConnectTarget(null)
          }}
        />
      )}
    </div>
  )
}

function formatOffsetMs(value: number): string {
  return `${value > 0 ? '+' : ''}${value} ms`
}

function LyricsGlobalOffsetSetting({ tweak, setTweak }: Props) {
  const value = tweak.lyricsGlobalOffsetMs
  const [draft, setDraft] = useState(String(value))

  useEffect(() => {
    setDraft(String(value))
  }, [value])

  const commit = (nextValue?: number) => {
    if (nextValue == null && draft.trim() === '') {
      setDraft(String(value))
      return
    }
    const next = clampLyricsOffsetMs(nextValue ?? Number(draft))
    setDraft(String(next))
    setTweak('lyricsGlobalOffsetMs', next)
  }

  return (
    <div className="set-row lyrics-global-offset-row">
      <div>
        <div className="lbl">Desfasaje global de letras</div>
        <div className="sub">Positivo retrasa la letra; negativo la adelanta.</div>
      </div>
      <div className="lyrics-offset-setting">
        <span className="lyrics-offset-value">{formatOffsetMs(value)}</span>
        <button type="button" className="btn sm" title="Adelantar 250 ms" onClick={() => commit(value - 250)}>-250</button>
        <input
          type="number"
          className="number-input lyrics-offset-number"
          min={-LYRICS_OFFSET_LIMIT_MS}
          max={LYRICS_OFFSET_LIMIT_MS}
          step={50}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setDraft(String(value))
              e.currentTarget.blur()
            }
          }}
          aria-label="Desfasaje global de letras en milisegundos"
        />
        <button type="button" className="btn sm" title="Retrasar 250 ms" onClick={() => commit(value + 250)}>+250</button>
        <button type="button" className="btn sm ghost" title="Resetear desfasaje global" onClick={() => commit(0)}>0</button>
      </div>
    </div>
  )
}

function LibraryFoldersPanel() {
  const folders = useFolders()
  const pickFolder = useLibraryStore(s => s.pickFolder)
  const addFolder = useLibraryStore(s => s.addFolder)
  const refresh = useLibraryStore(s => s.refresh)
  const [removeTarget, setRemoveTarget] = useState<DbFolder | null>(null)
  const [adding, setAdding] = useState(false)
  const [scanningId, setScanningId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pickAndAdd = async () => {
    setAdding(true)
    setError(null)
    try {
      const picked = await pickFolder()
      if (picked) await addFolder(picked)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdding(false)
    }
  }

  const scanFolder = async (folderId: number) => {
    setScanningId(folderId)
    setError(null)
    try {
      await window.api.library.scanNow(folderId)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanningId(null)
    }
  }

  return (
    <>
      <div className="set-card library-folders-card">
        <div className="library-folders-head">
          <div>
            <div className="lbl">Carpetas de música</div>
            <div className="sub">Rutas que Crate analiza y mantiene conectadas.</div>
          </div>
          <button className="btn" type="button" disabled={adding} onClick={() => { void pickAndAdd() }}>
            <Icon name="plus" size={13} /> {adding ? 'Agregando...' : 'Agregar carpeta'}
          </button>
        </div>
        {error && <pre className="modal-error library-folders-error">{error}</pre>}
        {folders.length === 0 ? (
          <div className="library-folders-empty">No hay carpetas configuradas.</div>
        ) : (
          <div className="library-folders-list">
            {folders.map(folder => (
              <div className="library-folder-row" key={folder.id}>
                <Icon name="folder" size={15} />
                <div className="library-folder-main">
                  <strong>{folder.name}</strong>
                  <span>{folder.path}</span>
                </div>
                <span className="library-folder-count">{folder.track_count} temas</span>
                <div className="library-folder-actions">
                  <button
                    className="btn ghost sm"
                    type="button"
                    disabled={scanningId === folder.id}
                    onClick={() => { void scanFolder(folder.id) }}
                  >
                    {scanningId === folder.id ? 'Analizando' : 'Analizar'}
                  </button>
                  <button className="btn ghost sm" type="button" onClick={() => setRemoveTarget(folder)}>
                    Eliminar
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {removeTarget && (
        <FolderRemovalConfirmModal
          folder={removeTarget}
          onClose={() => setRemoveTarget(null)}
          onRemoved={() => {
            if (scanningId === removeTarget.id) setScanningId(null)
          }}
        />
      )}
    </>
  )
}

export function SettingsView({ tweak, setTweak }: Props) {
  const [libraryLogOpen, setLibraryLogOpen] = useState(false)

  return (
    <div className="settings">
      <h1>Preferences</h1>

      <div className="set-section">
        <h2>Appearance</h2>
        <div className="set-card">
          <div className="set-row">
            <div>
              <div className="lbl">Theme</div>
              <div className="sub">Switch between light & dark interface.</div>
            </div>
            <div className="rule-row" style={{ margin: 0 }}>
              <div
                className="select"
                style={{ background: !tweak.dark ? 'var(--bg-selected)' : 'var(--bg-elev)' }}
                onClick={() => setTweak('dark', false)}
                role="button" tabIndex={0}
              >
                Light
              </div>
              <div
                className="select"
                style={{ background: tweak.dark ? 'var(--bg-selected)' : 'var(--bg-elev)' }}
                onClick={() => setTweak('dark', true)}
                role="button" tabIndex={0}
              >
                Dark
              </div>
            </div>
          </div>
          <div className="set-row">
            <div>
              <div className="lbl">Density</div>
              <div className="sub">Row height in lists & tables.</div>
            </div>
            <div className="rule-row" style={{ margin: 0 }}>
              {(['compact', 'regular', 'comfy'] as const).map(d => (
                <div
                  key={d}
                  className="select"
                  style={{ background: tweak.density === d ? 'var(--bg-selected)' : 'var(--bg-elev)' }}
                  onClick={() => setTweak('density', d)}
                  role="button" tabIndex={0}
                >
                  {d}
                </div>
              ))}
            </div>
          </div>
          <div className="set-row">
            <div>
              <div className="lbl">Translucent sidebar</div>
              <div className="sub">Vibrancy blur behind the navigation pane.</div>
            </div>
            <div
              className={`toggle ${tweak.translucent ? 'on' : ''}`}
              onClick={() => setTweak('translucent', !tweak.translucent)}
              role="switch"
              aria-checked={tweak.translucent}
              tabIndex={0}
            />
          </div>

        </div>
      </div>

      <div className="set-section">
        <h2>Now Playing</h2>
        <div className="set-card">
          <div className="set-row">
            <div>
              <div className="lbl">Player tint</div>
              <div className="sub">Color del panel de reproducción. "Artwork" usa el color dominante del track actual.</div>
            </div>
            <div className="rule-row" style={{ margin: 0 }}>
              {(['default', 'preset', 'custom', 'artwork'] as const).map(s => (
                <div
                  key={s}
                  className="select"
                  style={{ background: tweak.playerTintSource === s ? 'var(--bg-selected)' : 'var(--bg-elev)' }}
                  onClick={() => setTweak('playerTintSource', s as PlayerTintSource)}
                  role="button" tabIndex={0}
                >
                  {s === 'default' ? 'Default' : s === 'preset' ? 'Preset' : s === 'custom' ? 'Custom' : 'Artwork'}
                </div>
              ))}
            </div>
          </div>
          {tweak.playerTintSource === 'preset' && (
            <div className="set-color-extra">
              <div className="swatch-row">
                {COLOR_PRESETS.map(p => (
                  <div
                    key={p.id}
                    className={`swatch ${tweak.playerTintColor.toLowerCase() === p.hex.toLowerCase() ? 'selected' : ''}`}
                    style={{ background: p.hex }}
                    title={p.label}
                    onClick={() => setTweak('playerTintColor', p.hex)}
                    role="button" tabIndex={0}
                  />
                ))}
              </div>
            </div>
          )}
          {tweak.playerTintSource === 'custom' && (
            <div className="set-color-extra">
              <input
                type="color"
                className="color-input"
                value={tweak.playerTintColor}
                onChange={e => setTweak('playerTintColor', e.target.value)}
                aria-label="Custom player tint color"
              />
              <span className="set-color-note">{tweak.playerTintColor}</span>
            </div>
          )}
          {tweak.playerTintSource === 'artwork' && (
            <div className="set-color-extra">
              <span className="set-color-note">
                El panel de reproducción adopta el color dominante del track que se está reproduciendo.
              </span>
            </div>
          )}
          <div className="set-row">
            <div>
              <div className="lbl">Aviso de siguiente tema</div>
              <div className="sub">Visible entre {tweak.upNextToastStartSec}s y {tweak.upNextToastEndSec}s antes del final.</div>
            </div>
            <div className="up-next-window-controls">
              <label>
                <span>Desde</span>
                <input
                  type="number"
                  className="number-input up-next-window-input"
                  min={UP_NEXT_TOAST_START_SEC_MIN}
                  max={UP_NEXT_TOAST_START_SEC_MAX}
                  step={1}
                  value={tweak.upNextToastStartSec}
                  onChange={e => setTweak('upNextToastStartSec', Number(e.target.value))}
                  aria-label="Segundos antes del final para mostrar el aviso de siguiente tema"
                />
              </label>
              <label>
                <span>Hasta</span>
                <input
                  type="number"
                  className="number-input up-next-window-input"
                  min={UP_NEXT_TOAST_END_SEC_MIN}
                  max={Math.max(UP_NEXT_TOAST_END_SEC_MIN, tweak.upNextToastStartSec - 1)}
                  step={1}
                  value={tweak.upNextToastEndSec}
                  onChange={e => setTweak('upNextToastEndSec', Number(e.target.value))}
                  aria-label="Segundos antes del final para ocultar el aviso de siguiente tema"
                />
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="set-section">
        <h2>Playback</h2>
        <div className="set-card">
          <div className="set-row">
            <div>
              <div className="lbl">Crossfade</div>
              <div className="sub">Bajar y subir rápido (segundos). {tweak.crossfade === 0 ? 'Sin transición' : `Total: ${tweak.crossfade}s`}</div>
            </div>
            <input
              type="range" min={0} max={12} step={1}
              value={tweak.crossfade}
              onChange={e => setTweak('crossfade', Number(e.target.value))}
              style={{ width: 160 }}
            />
          </div>
          <div className="set-row">
            <div>
              <div className="lbl">Gapless playback</div>
              <div className="sub">Honor album track-to-track sequencing.</div>
            </div>
            <div
              className={`toggle ${tweak.gapless ? 'on' : ''}`}
              onClick={() => setTweak('gapless', !tweak.gapless)}
              role="switch"
              aria-checked={tweak.gapless}
              tabIndex={0}
            />
          </div>
          <div className="set-row">
            <div>
              <div className="lbl">Sound check</div>
              <div className="sub">Normalize song loudness to a consistent target.</div>
            </div>
            <div
              className={`toggle ${tweak.soundcheck ? 'on' : ''}`}
              onClick={() => setTweak('soundcheck', !tweak.soundcheck)}
              role="switch"
              aria-checked={tweak.soundcheck}
              tabIndex={0}
            />
          </div>
        </div>
      </div>

      <div className="set-section">
        <h2>Playback Cache</h2>
        <PlaybackCachePanel />
      </div>

      <div className="set-section">
        <h2>Dispositivos</h2>
        <DeviceDetectionPanel tweak={tweak} setTweak={setTweak} />
      </div>

      <div className="set-section">
        <h2>Library</h2>
        <LibraryFoldersPanel />
        <div className="set-card">
          <div className="set-row">
            <div>
              <div className="lbl">Keep portable backup in folder</div>
              <div className="sub">
                Saves your plays, favorites, ratings and EQ settings into a hidden{' '}
                <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>.crate/library.yaml</code>
                {' '}inside each library folder. When you reconnect the folder elsewhere those
                are merged back automatically.
              </div>
            </div>
            <div
              className={`toggle ${tweak.libraryBackup ? 'on' : ''}`}
              onClick={() => setTweak('libraryBackup', !tweak.libraryBackup)}
              role="switch"
              aria-checked={tweak.libraryBackup}
              tabIndex={0}
            />
          </div>
          <div className="set-row">
            <div>
              <div className="lbl">Registro de análisis</div>
              <div className="sub">Historial de análisis, cambios y archivos omitidos por biblioteca.</div>
            </div>
            <button className="btn" type="button" onClick={() => setLibraryLogOpen(true)}>
              <Icon name="list" size={13} /> Ver registros
            </button>
          </div>
        </div>
        {libraryLogOpen && (
          <ModalShell title="Registro de biblioteca" onClose={() => setLibraryLogOpen(false)}>
            <div className="library-log-modal">
              <LibraryScanLogPanel tweak={tweak} setTweak={setTweak} />
            </div>
          </ModalShell>
        )}
      </div>

      <div className="set-section">
        <h2>Lyrics</h2>
        <div className="set-card">
          <LyricsGlobalOffsetSetting tweak={tweak} setTweak={setTweak} />
          {([
            ['lyricsAutoFetch', 'Buscar letras automáticamente', 'Al reproducir, busca letras en línea (LRCLIB) si no hay en caché.'],
            ['lyricsPreferSynced', 'Preferir letras sincronizadas', 'Usa la versión con tiempos cuando esté disponible.'],
            ['lyricsCacheLocal', 'Guardar letras en caché local', 'Cachea los resultados en la base de datos.'],
          ] as const).map(([key, label, sub]) => (
            <div className="set-row" key={key}>
              <div>
                <div className="lbl">{label}</div>
                <div className="sub">{sub}</div>
              </div>
              <div
                className={`toggle ${tweak[key] ? 'on' : ''}`}
                onClick={() => setTweak(key, !tweak[key])}
                role="switch"
                aria-checked={tweak[key]}
                tabIndex={0}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="set-section">
        <h2>Equalizer</h2>
        <EqPanel />
      </div>
    </div>
  )
}

const RETENTION_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: '7 días', value: 7 },
  { label: '30 días', value: 30 },
  { label: '90 días', value: 90 },
  { label: '1 año', value: 365 },
  { label: 'Sin límite', value: null },
]

const SCAN_EVENT_LABELS: Record<LibraryScanEvent['type'], string> = {
  added: 'Agregado',
  updated: 'Actualizado',
  removed: 'Eliminado',
  missing_root: 'Carpeta faltante',
  skipped: 'Omitido',
  error: 'Error',
}

const SCAN_REASON_LABELS: Record<LibraryScanRun['reason'], string> = {
  startup: 'Inicio',
  watch: 'Watcher',
  background: 'Fondo',
  manual: 'Manual',
  import: 'Importación',
}

function formatScanDate(value: number | null): string {
  if (!value) return 'En curso'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value))
}

function scanSummary(run: LibraryScanRun): string {
  const parts = [
    run.added > 0 ? `${run.added} agregados` : '',
    run.updated > 0 ? `${run.updated} actualizados` : '',
    run.removed > 0 ? `${run.removed} eliminados` : '',
    run.skipped > 0 ? `${run.skipped} omitidos` : '',
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : 'Sin cambios'
}

function eventTitle(event: LibraryScanEvent): string {
  return event.title || event.path?.split(/[\\/]/).pop() || 'Sin título'
}

function LibraryScanLogPanel({ tweak, setTweak }: Props) {
  const [payload, setPayload] = useState<LibraryScanLogPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [scanningId, setScanningId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadLog = async () => {
    setLoading(true)
    setError(null)
    try {
      setPayload(await window.api.library.scanLog(undefined, 200))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadLog()
  }, [])

  const scanFolder = async (folderId: number) => {
    setScanningId(folderId)
    setError(null)
    try {
      await window.api.library.scanNow(folderId)
      await loadLog()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanningId(null)
    }
  }

  const folderName = (folderId: number): string => {
    const folder = payload?.folders.find(item => item.id === folderId)
    return folder?.name ?? `Biblioteca ${folderId}`
  }

  const selectedRetention = tweak.libraryScanLogRetentionDays == null
    ? 'none'
    : String(tweak.libraryScanLogRetentionDays)

  return (
    <div className="library-log-panel">
      <div className="set-card">
        <div className="set-row">
          <div>
            <div className="lbl">Retención del registro</div>
            <div className="sub">Se aplica al historial de análisis y cambios por biblioteca.</div>
          </div>
          <select
            className="settings-select"
            value={selectedRetention}
            onChange={e => {
              const next = e.target.value === 'none' ? null : Number(e.target.value)
              setTweak('libraryScanLogRetentionDays', next)
              window.setTimeout(() => { void loadLog() }, 100)
            }}
            aria-label="Library scan log retention"
          >
            {RETENTION_OPTIONS.map(option => (
              <option key={option.value ?? 'none'} value={option.value ?? 'none'}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        {error && (
          <div className="set-row">
            <div className="sub library-log-error">{error}</div>
            <button className="btn ghost sm" type="button" onClick={() => { void loadLog() }}>
              Reintentar
            </button>
          </div>
        )}
      </div>

      <div className="library-log-folders">
        {(payload?.folders ?? []).map(folder => {
          const latest = payload?.runs.find(run => run.folderId === folder.id)
          return (
            <div className="library-log-folder" key={folder.id}>
              <div className="library-log-folder-main">
                <strong>{folder.name}</strong>
                <span>
                  {folder.track_count} temas · {latest ? `${formatScanDate(latest.finishedAt ?? latest.startedAt)} · ${SCAN_REASON_LABELS[latest.reason]}` : 'Sin registro'}
                </span>
              </div>
              <span className="library-log-summary">{latest ? scanSummary(latest) : 'Sin cambios'}</span>
              <button
                className="btn ghost sm"
                type="button"
                disabled={scanningId === folder.id}
                onClick={() => { void scanFolder(folder.id) }}
              >
                {scanningId === folder.id ? 'Analizando' : 'Analizar ahora'}
              </button>
            </div>
          )
        })}
        {!loading && (payload?.folders.length ?? 0) === 0 && (
          <div className="library-log-empty">No hay bibliotecas configuradas.</div>
        )}
      </div>

      <div className="library-log-events">
        {(payload?.events ?? []).slice(0, 80).map(event => (
          <div className={`library-log-event ${event.type}`} key={event.id}>
            <span className="library-log-event-type">{SCAN_EVENT_LABELS[event.type]}</span>
            <div className="library-log-event-main">
              <strong>{eventTitle(event)}</strong>
              <span>{folderName(event.folderId)} · {formatScanDate(event.occurredAt)}{event.detail ? ` · ${event.detail}` : ''}</span>
            </div>
          </div>
        ))}
        {loading && <div className="library-log-empty">Cargando registro...</div>}
        {!loading && (payload?.events.length ?? 0) === 0 && (
          <div className="library-log-empty">No hay eventos registrados.</div>
        )}
      </div>
    </div>
  )
}

function formatCacheBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / 1024 / 1024
  if (mb < 1024) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`
  const gb = mb / 1024
  return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`
}

function cacheLimitMb(stats: PlaybackCacheStats | null): number {
  return Math.round((stats?.maxBytes ?? 1024 * 1024 * 1024) / 1024 / 1024)
}

function PlaybackCachePanel() {
  const [stats, setStats] = useState<PlaybackCacheStats | null>(null)
  const [limitMb, setLimitMb] = useState('1024')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const loadStats = async () => {
    const next = await window.api.audio.getPlaybackCacheStats()
    setStats(next)
    setLimitMb(String(cacheLimitMb(next)))
  }

  useEffect(() => {
    let cancelled = false
    void window.api.audio.getPlaybackCacheStats()
      .then(next => {
        if (cancelled) return
        setStats(next)
        setLimitMb(String(cacheLimitMb(next)))
      })
      .catch(() => { /* main not ready */ })

    const off = window.api.audio.onPlaybackCacheChanged(next => {
      if (cancelled) return
      setStats(next)
      setLimitMb(String(cacheLimitMb(next)))
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const saveLimit = async () => {
    const mb = Math.max(64, Math.floor(Number(limitMb) || 1024))
    setBusy(true)
    setStatus(null)
    try {
      const next = await window.api.audio.setPlaybackCacheLimit(mb * 1024 * 1024)
      setStats(next)
      setLimitMb(String(cacheLimitMb(next)))
      setStatus('Límite actualizado')
    } finally {
      setBusy(false)
    }
  }

  const clearCache = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const next = await window.api.audio.clearPlaybackCache()
      clearPlaybackTableBarsMemoryCache()
      setStats(next)
      setLimitMb(String(cacheLimitMb(next)))
      setStatus('Cache limpiado')
    } finally {
      setBusy(false)
    }
  }

  const used = stats?.usedBytes ?? 0
  const max = stats?.maxBytes ?? 1024 * 1024 * 1024
  const percent = max > 0 ? Math.min(100, Math.max(0, (used / max) * 100)) : 0

  return (
    <div className="set-card playback-cache-card">
      <div className="set-row">
        <div>
          <div className="lbl">Cache de reproducción</div>
          <div className="sub">
            Guarda waveforms y barras compactas de la tabla; el visualizador visible usa FFT en vivo.
          </div>
        </div>
        <div className="playback-cache-usage">
          <strong>{formatCacheBytes(used)}</strong>
          <span>{stats?.entries ?? 0} temas</span>
        </div>
      </div>
      <div className="playback-cache-meter" aria-hidden="true">
        <i style={{ width: `${percent}%` }} />
      </div>
      <div className="set-row">
        <div>
          <div className="lbl">Tamaño máximo</div>
          <div className="sub">Cuando entra cache nuevo, se descartan primero los temas menos escuchados y menos recientes.</div>
        </div>
        <div className="cache-limit-controls">
          <input
            type="number"
            className="number-input cache-limit-input"
            min={64}
            step={64}
            value={limitMb}
            disabled={busy}
            onChange={e => setLimitMb(e.target.value)}
            aria-label="Playback cache limit in MB"
          />
          <span>MB</span>
          <button className="btn ghost" disabled={busy} onClick={saveLimit}>Guardar</button>
        </div>
      </div>
      <div className="set-row">
        <div>
          <div className="lbl">Gestión</div>
          <div className="sub">{status ?? `Límite actual: ${formatCacheBytes(max)}`}</div>
        </div>
        <div className="cache-limit-controls">
          <button className="btn ghost" disabled={busy} onClick={() => { void loadStats() }}>Actualizar</button>
          <button className="btn danger" disabled={busy || used <= 0} onClick={clearCache}>Limpiar cache</button>
        </div>
      </div>
    </div>
  )
}

function EqPanel() {
  const enabled = useEqStore(s => s.enabled)
  const preset = useEqStore(s => s.preset)
  const bands = useEqStore(s => s.bands)
  const presetNames = useEqStore(s => s.presetNames)
  const setEnabled = useEqStore(s => s.setEnabled)
  const setBand = useEqStore(s => s.setBand)
  const setPreset = useEqStore(s => s.setPreset)
  const selectedPreset = presetNames.includes(preset) ? preset : 'Custom'

  return (
    <>
      <div className="set-card" style={{ marginBottom: 12 }}>
        <div className="set-row">
          <div>
            <div className="lbl">Enable equalizer</div>
            <div className="sub">15-band peaking EQ applied to the BASS playback chain.</div>
          </div>
          <div
            className={`toggle ${enabled ? 'on' : ''}`}
            onClick={() => { void setEnabled(!enabled) }}
            role="switch"
            aria-checked={enabled}
            tabIndex={0}
          />
        </div>
      </div>

      <div className="eq-graph" style={{ opacity: enabled ? 1 : 0.45 }}>
        <div className="eq-bands">
          {EQ_BAND_LABELS.map((label, i) => {
            // Map the gain range to 0..1 for the hidden design parity fill.
            const gain = bands[i] ?? 0
            const normalized = (gain - EQ_GAIN_MIN) / (EQ_GAIN_MAX - EQ_GAIN_MIN)
            return (
              <div key={label} className="eq-band">
                <input
                  type="range"
                  min={EQ_GAIN_MIN}
                  max={EQ_GAIN_MAX}
                  step={EQ_GAIN_STEP}
                  value={gain}
                  disabled={!enabled}
                  onChange={e => { void setBand(i, parseFloat(e.target.value)) }}
                  title={`${label} Hz: ${gain.toFixed(1)} dB`}
                  style={{
                    flex: 1,
                    width: 16,
                    writingMode: 'vertical-lr',
                    direction: 'rtl',
                    // Vertical orientation via CSS appearance hint (browser-specific).
                    ['appearance' as never]: 'slider-vertical',
                    ['WebkitAppearance' as never]: 'slider-vertical',
                  }}
                />
                <div className="hz">{label}</div>
                <div className="gain">
                  {gain > 0 ? `+${gain.toFixed(0)}` : gain.toFixed(0)}
                </div>
                {/* Visual track behind the slider for parity with the design */}
                <div style={{ position: 'absolute', pointerEvents: 'none', opacity: 0 }}>
                  <div className="col"><div className="fill" style={{ bottom: 0, height: `${normalized * 100}%` }} /></div>
                </div>
              </div>
            )
          })}
        </div>
        <div className="eq-preset-row">
          <label className="eq-preset-control">
            <span>Preset</span>
            <span className="eq-preset-select-wrap">
              <select
                value={selectedPreset}
                onChange={e => { void setPreset(e.target.value) }}
                aria-label="Equalizer preset"
              >
                <option value="Custom" disabled>Custom</option>
                {presetNames.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </span>
          </label>
          {preset === 'Custom' && (
            <span className="eq-custom-note">Custom curve</span>
          )}
        </div>
      </div>
    </>
  )
}
