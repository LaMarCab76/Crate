import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PlayerTintSource, Tweak } from '@renderer/stores/settingsStore'
import type { DbFolder } from '@shared/types/db'
import { useEqStore } from '@renderer/stores/eqStore'
import { useLevelerStore } from '@renderer/stores/levelerStore'
import {
  LEVELER_TARGET_MIN,
  LEVELER_TARGET_MAX,
  LEVELER_TARGET_STEP,
  formatLevelerGain,
} from '@shared/constants/leveler'
import { Icon } from '@renderer/components/Icon'
import { ModalShell } from '@renderer/components/ModalShell'
import { CloudSettingsPanel } from '@renderer/components/CloudSettingsPanel'
import { FolderRemovalConfirmModal } from '@renderer/components/FolderRemovalConfirmModal'
import type { DeviceConnectTarget } from '@renderer/components/DeviceConnectModal'
import { useDeviceStore } from '@renderer/stores/deviceStore'
import { useFolders, useLibraryStore } from '@renderer/stores/libraryStore'
import {
  EQ_BAND_COUNT_PRESETS,
  EQ_MAX_BAND_COUNT,
  EQ_MIN_BAND_COUNT,
  eqBandLabels,
} from '@shared/constants/equalizer'
import { EqGraph } from '@renderer/components/EqGraph'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { LYRICS_OFFSET_LIMIT_MS, clampLyricsOffsetMs } from '@shared/lyrics/lrc'
import type {
  AppUpdateState,
  LibraryScanEvent,
  LibraryScanLogPayload,
  LibraryScanRun,
  PlaybackCacheStats,
} from '@shared/types/ipc-contract'
import { COLOR_PRESETS } from '@renderer/utils/colorPresets'
import { clearPlaybackTableBarsMemoryCache } from '@renderer/utils/playbackTableBars'
import { basenameForPath } from '@renderer/utils/devicePaths'
import { fmtTime } from '@renderer/utils/format'
import { useVirtualRows } from '@renderer/utils/useVirtualRows'
import {
  filterLyricsLibraryItems,
  lyricsLibraryCounts,
  pruneLyricsSelection,
  type LyricsLibraryTab,
} from '@renderer/utils/lyricsLibraryPanel'
import {
  UP_NEXT_TOAST_END_SEC_MIN,
  UP_NEXT_TOAST_START_SEC_MAX,
  UP_NEXT_TOAST_START_SEC_MIN,
} from '@renderer/utils/upNextToast'
import type { LyricsLibraryOverview, LyricsLibraryProgress, LyricsSelectionProgress } from '@shared/types/lyrics'

interface Props {
  tweak: Tweak
  setTweak: <K extends keyof Tweak>(key: K, value: Tweak[K]) => void
}

export type SettingsMainTab = 'apariencia' | 'reproduccion' | 'bibliotecas' | 'actualizaciones'
export type PlaybackSubTab = 'general' | 'eq' | 'letras'

interface SettingsViewProps extends Props {
  activeTab: SettingsMainTab
  playbackSubTab: PlaybackSubTab
  onConnectDevice: (target: DeviceConnectTarget) => void
}

function LibraryVolumeClassificationPanel({
  onConnectDevice,
}: {
  onConnectDevice: (target: DeviceConnectTarget) => void
}) {
  const devices = useDeviceStore(s => s.devices)
  const candidates = useDeviceStore(s => s.candidates)
  const unknownVolumes = useDeviceStore(s => s.unknownVolumes)
  const loading = useDeviceStore(s => s.loading)
  const error = useDeviceStore(s => s.error)
  const refreshVolumes = useDeviceStore(s => s.refreshVolumes)
  const ignoreVolume = useDeviceStore(s => s.ignoreVolume)
  const addFolder = useLibraryStore(s => s.addFolder)
  const folders = useFolders()

  useEffect(() => {
    void refreshVolumes()
  }, [refreshVolumes])

  const connectedRoots = useMemo(() => new Set(devices.map(device => device.rootPath)), [devices])
  const libraryRoots = useMemo(() => new Set(folders.map(folder => folder.path)), [folders])

  const pickDeviceRoot = async () => {
    const picked = await window.api.devices.pickRoot()
    if (picked.canceled || !picked.path) return
    onConnectDevice({
      rootPath: picked.path,
      name: basenameForPath(picked.path),
    })
  }

  const addAsLibrary = async (rootPath: string) => {
    await addFolder(rootPath)
    await ignoreVolume(rootPath)
  }

  return (
    <section className="set-section library-volumes-section">
      <div className="set-section-head">
        <h2>Rutas de MP3 y volúmenes</h2>
        <div className="actions">
          <button className="btn sm" type="button" disabled={loading} onClick={() => void refreshVolumes()}>
            <Icon name="rotate" size={12} /> Detectar ahora
          </button>
          <button className="btn primary sm" type="button" disabled={loading} onClick={() => void pickDeviceRoot()}>
            <Icon name="device" size={12} /> Elegir MP3
          </button>
        </div>
      </div>
      <p className="set-section-sub">Clasificá los volúmenes detectados como biblioteca local, MP3 o ignorados.</p>

      {error && <div className="device-error inline">{error}</div>}

      <div className="set-card">
        <div className="library-group-label">
          Conectados <span className="volume-count">{devices.length}</span>
        </div>
        {devices.length === 0 ? (
          <div className="library-empty">No hay MP3 vinculados.</div>
        ) : (
          devices.map(device => (
            <div className="set-row library-row" key={device.id}>
              <div className="library-row-main">
                <Icon name="device" size={16} />
                <div className="library-row-text">
                  <div className="lbl">{device.name}</div>
                  <div className="sub">
                    {device.rootPath} · {device.trackCount} temas{device.hasRockbox ? ' · Rockbox' : ''}
                  </div>
                </div>
              </div>
              <span className={`volume-status ${device.isAvailable ? 'online' : ''}`}>
                <span className="volume-status-dot" aria-hidden="true" />
                {device.isAvailable ? 'Mounted' : 'Offline'}
              </span>
            </div>
          ))
        )}

        <div className="library-group-label">
          Detectados <span className="volume-count">{candidates.length}</span>
        </div>
        {candidates.length === 0 ? (
          <div className="library-empty">No hay MP3 candidatos.</div>
        ) : (
          candidates.map(candidate => (
            <div className="set-row library-row" key={candidate.rootPath}>
              <div className="library-row-main">
                <Icon name="device" size={16} />
                <div className="library-row-text">
                  <div className="lbl">{candidate.name}</div>
                  <div className="sub">{candidate.rootPath}</div>
                </div>
              </div>
              <div className="library-row-side">
                <button
                  className="btn sm"
                  type="button"
                  disabled={loading || connectedRoots.has(candidate.rootPath)}
                  onClick={() => onConnectDevice({ rootPath: candidate.rootPath, name: candidate.name })}
                >
                  MP3
                </button>
              </div>
            </div>
          ))
        )}

        <div className="library-group-label">
          Volúmenes sin clasificar <span className="volume-count">{unknownVolumes.length}</span>
        </div>
        {unknownVolumes.length === 0 ? (
          <div className="library-empty">No hay volúmenes nuevos pendientes.</div>
        ) : (
          unknownVolumes.map(volume => (
            <div className="set-row library-row" key={volume.rootPath}>
              <div className="library-row-main">
                <Icon name="folder" size={16} />
                <div className="library-row-text">
                  <div className="lbl">{volume.name}</div>
                  <div className="sub">{volume.rootPath}</div>
                </div>
              </div>
              <div className="library-row-side">
                <button
                  className="btn sm"
                  type="button"
                  disabled={loading}
                  onClick={() => onConnectDevice({ rootPath: volume.rootPath, name: volume.name })}
                >
                  MP3
                </button>
                <button
                  className="btn sm"
                  type="button"
                  disabled={libraryRoots.has(volume.rootPath)}
                  onClick={() => void addAsLibrary(volume.rootPath)}
                >
                  Biblioteca
                </button>
                <button className="btn ghost sm" type="button" onClick={() => void ignoreVolume(volume.rootPath)}>
                  Ignorar
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
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
    <section className="set-section">
      <div className="set-section-head">
        <h2>Carpetas de música</h2>
        <button className="btn sm" type="button" disabled={adding} onClick={() => { void pickAndAdd() }}>
          <Icon name="plus" size={12} /> {adding ? 'Agregando…' : 'Agregar carpeta'}
        </button>
      </div>
      <p className="set-section-sub">Rutas que Crate analiza y mantiene conectadas.</p>
      {error && <pre className="modal-error library-folders-error">{error}</pre>}
      <div className="set-card">
        {folders.length === 0 ? (
          <div className="library-empty">No hay carpetas configuradas.</div>
        ) : (
          folders.map(folder => (
            <div className="set-row library-row" key={folder.id}>
              <div className="library-row-main">
                <Icon name="folder" size={16} />
                <div className="library-row-text">
                  <div className="lbl">{folder.name}</div>
                  <div className="sub">{folder.path} · {folder.track_count} temas</div>
                </div>
              </div>
              <div className="library-row-side">
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
          ))
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
    </section>
  )
}

function AppearanceSection({ tweak, setTweak }: Props) {
  return (
    <section className="set-section">
      <h2>Apariencia</h2>
      <div className="set-card">
        <div className="set-row">
          <div>
            <div className="lbl">Theme</div>
            <div className="sub">Switch between light & dark interface.</div>
          </div>
          <div className="rule-row" style={{ margin: 0 }}>
            <div
              className={`select ${!tweak.dark ? 'active' : ''}`}
              onClick={() => setTweak('dark', false)}
              role="button" tabIndex={0} aria-pressed={!tweak.dark}
            >
              Light
            </div>
            <div
              className={`select ${tweak.dark ? 'active' : ''}`}
              onClick={() => setTweak('dark', true)}
              role="button" tabIndex={0} aria-pressed={tweak.dark}
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
                className={`select ${tweak.density === d ? 'active' : ''}`}
                onClick={() => setTweak('density', d)}
                role="button" tabIndex={0} aria-pressed={tweak.density === d}
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
    </section>
  )
}

function PlaybackGeneralSection({ tweak, setTweak }: Props) {
  return (
    <>
      <section className="set-section">
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
                  className={`select ${tweak.playerTintSource === s ? 'active' : ''}`}
                  onClick={() => setTweak('playerTintSource', s as PlayerTintSource)}
                  role="button" tabIndex={0} aria-pressed={tweak.playerTintSource === s}
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
      </section>
      <section className="set-section">
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
          <LevelerSettings />
        </div>
      </section>
      <section className="set-section">
        <h2>Playback Cache</h2>
        <PlaybackCachePanel />
      </section>
    </>
  )
}

// Volume leveler (Sound Check) controls. Backed by the shared levelerStore, so
// these mirror — and stay in sync with — the in-player Audio Output popover.
function LevelerSettings() {
  const enabled = useLevelerStore(s => s.enabled)
  const targetLufs = useLevelerStore(s => s.targetLufs)
  const preventClipping = useLevelerStore(s => s.preventClipping)
  const currentGainDb = useLevelerStore(s => s.currentGainDb)
  const setEnabled = useLevelerStore(s => s.setEnabled)
  const setTargetLufs = useLevelerStore(s => s.setTargetLufs)
  const setPreventClipping = useLevelerStore(s => s.setPreventClipping)

  return (
    <>
      <div className="set-row">
        <div>
          <div className="lbl">Nivelador de volumen</div>
          <div className="sub">
            Normaliza el volumen de cada canción a un nivel constante (Sound Check).
            {enabled ? ` Ganancia actual: ${formatLevelerGain(currentGainDb)}.` : ''}
          </div>
        </div>
        <div
          className={`toggle ${enabled ? 'on' : ''}`}
          onClick={() => { void setEnabled(!enabled) }}
          role="switch"
          aria-checked={enabled}
          aria-label="Activar nivelador de volumen"
          tabIndex={0}
        />
      </div>
      {enabled && (
        <>
          <div className="set-row">
            <div>
              <div className="lbl">Nivel objetivo</div>
              <div className="sub">Más bajo deja más margen sin saturación. {targetLufs} LUFS</div>
            </div>
            <input
              type="range"
              min={LEVELER_TARGET_MIN}
              max={LEVELER_TARGET_MAX}
              step={LEVELER_TARGET_STEP}
              value={targetLufs}
              onChange={e => { void setTargetLufs(Number(e.target.value)) }}
              style={{ width: 160 }}
              aria-label="Nivel objetivo de normalización en LUFS"
            />
          </div>
          <div className="set-row">
            <div>
              <div className="lbl">Evitar saturación</div>
              <div className="sub">Limita la amplificación para que el pico no supere los 0 dBFS.</div>
            </div>
            <div
              className={`toggle ${preventClipping ? 'on' : ''}`}
              onClick={() => { void setPreventClipping(!preventClipping) }}
              role="switch"
              aria-checked={preventClipping}
              aria-label="Evitar saturación al nivelar"
              tabIndex={0}
            />
          </div>
        </>
      )}
    </>
  )
}

function PlaybackEqSection() {
  return (
    <section className="set-section">
      <h2>Equalizer</h2>
      <EqPanel />
    </section>
  )
}

function PlaybackLyricsSection({ tweak, setTweak }: Props) {
  const [libraryOpen, setLibraryOpen] = useState(false)
  return (
    <section className="set-section">
      <h2>Lyrics</h2>
      <div className="set-card">
        <LyricsGlobalOffsetSetting tweak={tweak} setTweak={setTweak} />
        {([
          ['lyricsAutoFetch', 'Buscar letras automáticamente', 'Al reproducir, busca letras en línea (LRCLIB) si no hay un archivo .lrc.'],
          ['lyricsBackgroundFetch', 'Descargar letras en segundo plano', 'Busca letras faltantes en LRCLIB para toda la biblioteca, sin necesidad de reproducir. Genera tráfico de red.'],
          ['lyricsPreferSynced', 'Preferir letras sincronizadas', 'Usa la versión con tiempos cuando esté disponible.'],
          ['lyricsDeleteOrphans', 'Eliminar archivos .lrc huérfanos', 'Al escanear, borra archivos .lrc cuyo audio correspondiente ya no existe. Acción destructiva.'],
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
        <div className="set-row">
          <div>
            <div className="lbl">Biblioteca de letras</div>
            <div className="sub">Revisa qué canciones tienen letras y cuáles faltan, y descarga las que falten.</div>
          </div>
          <button className="btn" type="button" onClick={() => setLibraryOpen(true)}>
            <Icon name="lyrics" size={13} /> Administrar biblioteca
          </button>
        </div>
      </div>
      {libraryOpen && (
        <ModalShell title="Biblioteca de letras" onClose={() => setLibraryOpen(false)}>
          <LyricsLibraryManager />
        </ModalShell>
      )}
    </section>
  )
}

function LyricsLibraryManager() {
  const [overview, setOverview] = useState<LyricsLibraryOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<LyricsLibraryTab>('missing')
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [progress, setProgress] = useState<LyricsSelectionProgress | null>(null)
  const [scanProgress, setScanProgress] = useState<LyricsLibraryProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshOverview = async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      const next = await window.api.lyrics.libraryOverview(force)
      setOverview(next)
      setSelected(current => pruneLyricsSelection(current, next.items))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refreshOverview()
    const offSelection = window.api.lyrics.onSelectionProgress(event => {
      setProgress(event)
    })
    const offLibrary = window.api.lyrics.onLibraryProgress(event => {
      setScanProgress(event.done >= event.total ? null : event)
    })
    return () => {
      offSelection()
      offLibrary()
    }
    // refreshOverview is an event helper; this panel only needs one load on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const items = overview?.items ?? []
  const counts = useMemo(() => lyricsLibraryCounts(items), [items])
  const visibleItems = useMemo(
    () => filterLyricsLibraryItems(items, tab, query),
    [items, query, tab],
  )
  const visibleMissingIds = visibleItems
    .filter(item => !item.hasLyrics)
    .map(item => item.trackId)
  const selectedVisibleCount = visibleMissingIds.filter(id => selected.has(id)).length
  const allVisibleSelected = visibleMissingIds.length > 0 && selectedVisibleCount === visibleMissingIds.length

  const toggleSelected = (trackId: number) => {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }

  const toggleVisible = () => {
    setSelected(current => {
      const next = new Set(current)
      if (allVisibleSelected) {
        for (const id of visibleMissingIds) next.delete(id)
      } else {
        for (const id of visibleMissingIds) next.add(id)
      }
      return next
    })
  }

  const runSearch = async () => {
    const ids = [...selected]
    if (ids.length === 0 || running) return
    setRunning(true)
    setError(null)
    setProgress({ done: 0, total: ids.length, found: 0, failed: 0, phase: 'queued', nextAllowedAt: null })
    try {
      await window.api.lyrics.fetchForSelection(ids)
      setSelected(new Set())
      await refreshOverview()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const waitText = progress?.nextAllowedAt && progress.nextAllowedAt > Date.now()
    ? `Próxima búsqueda ${new Date(progress.nextAllowedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : null

  return (
    <div className="lyrics-library-panel">
      <div className="lyrics-library-head">
        <div>
          <span>{counts.withLyrics.toLocaleString()} con letras · {counts.missingLyrics.toLocaleString()} sin letras</span>
        </div>
        <button className="btn" type="button" disabled={loading || running} onClick={() => void refreshOverview(true)}>
          <Icon name="rotate" size={13} /> Actualizar
        </button>
      </div>

      <div className="lyrics-library-toolbar">
        <div className="lyrics-library-tabs" role="tablist" aria-label="Estado de letras">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'missing'}
            className={tab === 'missing' ? 'active' : ''}
            onClick={() => setTab('missing')}
          >
            Faltan letras <span>{counts.missingLyrics.toLocaleString()}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'with'}
            className={tab === 'with' ? 'active' : ''}
            onClick={() => setTab('with')}
          >
            Con letras <span>{counts.withLyrics.toLocaleString()}</span>
          </button>
        </div>
        <div className="lyrics-library-search">
          <Icon name="search" size={13} />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar canción, artista o álbum" />
        </div>
      </div>

      {tab === 'missing' && (
        <div className="lyrics-library-actions">
          <button className="btn" type="button" disabled={visibleMissingIds.length === 0 || running} onClick={toggleVisible}>
            {allVisibleSelected ? 'Quitar visibles' : 'Seleccionar visibles'}
          </button>
          <button className="btn primary" type="button" disabled={selected.size === 0 || running} onClick={() => void runSearch()}>
            <Icon name="lyrics" size={13} /> Buscar seleccionadas ({selected.size})
          </button>
          {running && progress && (
            <span className="lyrics-library-progress">
              {progress.done}/{progress.total} · {progress.found} encontradas{waitText ? ` · ${waitText}` : ''}
            </span>
          )}
        </div>
      )}

      {error && <div className="device-error inline">{error}</div>}

      <div className="lyrics-library-list">
        {loading ? (
          <div className="lyrics-library-empty">
            {scanProgress
              ? `Analizando biblioteca… ${scanProgress.done.toLocaleString()}/${scanProgress.total.toLocaleString()}`
              : 'Cargando biblioteca…'}
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="lyrics-library-empty">Sin canciones para mostrar.</div>
        ) : (
          <LyricsLibraryRows items={visibleItems} tab={tab} selected={selected} onToggle={toggleSelected} />
        )}
      </div>
    </div>
  )
}

// Windowed list: only the rows overlapping the viewport are mounted, so the
// panel stays responsive with a multi-thousand-track library. Reuses the same
// dependency-free virtualization hook as the main track table.
function LyricsLibraryRows({
  items,
  tab,
  selected,
  onToggle,
}: {
  items: LyricsLibraryOverview['items']
  tab: LyricsLibraryTab
  selected: Set<number>
  onToggle: (trackId: number) => void
}) {
  const [measuredRowH, setMeasuredRowH] = useState(0)
  const rowHeight = measuredRowH || 43
  const { setBody, window: vwin } = useVirtualRows(items.length, rowHeight)
  const measureRow = useCallback((el: HTMLElement | null) => {
    if (!el) return
    const h = el.offsetHeight
    if (h > 0) setMeasuredRowH(prev => (prev === h ? prev : h))
  }, [])
  return (
    <div ref={setBody}>
      {vwin.padTop > 0 && <div aria-hidden style={{ height: vwin.padTop }} />}
      {items.slice(vwin.start, vwin.end).map((item, k) => (
        <div className="lyrics-library-row" key={item.trackId} ref={k === 0 ? measureRow : undefined}>
          {tab === 'missing' ? (
            <input
              type="checkbox"
              checked={selected.has(item.trackId)}
              onChange={() => onToggle(item.trackId)}
              aria-label={`Seleccionar ${item.title}`}
            />
          ) : (
            <Icon name={item.embeddedInFile ? 'song' : 'lyrics'} size={14} />
          )}
          <span>
            <strong>{item.title}</strong>
            <em>{item.artist}{item.album ? ` · ${item.album}` : ''}</em>
          </span>
          <b>{lyricsItemStatusLabel(item)}</b>
          <code>{fmtTime(item.duration)}</code>
        </div>
      ))}
      {vwin.padBottom > 0 && <div aria-hidden style={{ height: vwin.padBottom }} />}
    </div>
  )
}

function lyricsItemStatusLabel(item: LyricsLibraryOverview['items'][number]): string {
  if (item.status === 'instrumental') return 'Instrumental'
  if (item.sidecarWritten) return item.status === 'found_synced' ? 'LRC' : 'Texto'
  if (item.embeddedInFile) return 'Embebida'
  if (item.hasLyrics) return item.status === 'found_synced' ? 'Sincronizada' : 'Texto'
  if (item.status === 'failed_provider') return 'Error'
  if (item.status === 'not_found') return 'Sin resultado'
  return 'Falta'
}

function LibrariesSection({
  tweak,
  setTweak,
  libraryLogOpen,
  setLibraryLogOpen,
  onConnectDevice,
}: {
  tweak: Tweak
  setTweak: <K extends keyof Tweak>(key: K, value: Tweak[K]) => void
  libraryLogOpen: boolean
  setLibraryLogOpen: (value: boolean | ((value: boolean) => boolean)) => void
  onConnectDevice: (target: DeviceConnectTarget) => void
}) {
  return (
    <>
      <LibraryFoldersPanel />
      <LibraryVolumeClassificationPanel onConnectDevice={onConnectDevice} />
      <section className="set-section">
        <h2>Respaldo y registro</h2>
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
      </section>
      {libraryLogOpen && (
        <ModalShell title="Registro de biblioteca" onClose={() => setLibraryLogOpen(false)}>
          <div className="library-log-modal">
            <LibraryScanLogPanel tweak={tweak} setTweak={setTweak} />
          </div>
        </ModalShell>
      )}
    </>
  )
}

const UPDATE_STATUS_LABEL: Record<AppUpdateState['status'], string> = {
  idle: 'Sin comprobar',
  checking: 'Buscando',
  available: 'Disponible',
  'not-available': 'Al día',
  downloading: 'Descargando',
  downloaded: 'Lista',
  error: 'Error',
  unsupported: 'No disponible',
}

function formatUpdateDate(value: string | number | null): string {
  if (!value) return 'Nunca'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Sin fecha'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function formatUpdateBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / 1024 / 1024
  if (mb < 1024) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`
  const gb = mb / 1024
  return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`
}

function updateSummary(state: AppUpdateState): string {
  if (state.status === 'unsupported') return state.error ?? 'Solo disponible en builds empaquetadas.'
  if (state.status === 'checking') return 'Consultando GitHub Releases.'
  if (state.status === 'available') return `Crate ${state.updateVersion ?? 'nuevo'} está disponible.`
  if (state.status === 'downloading') return 'Descargando la actualización en segundo plano.'
  if (state.status === 'downloaded') return 'La actualización está lista para instalarse al reiniciar.'
  if (state.status === 'not-available') return 'Tenés la última versión publicada.'
  if (state.status === 'error') return state.error ?? 'No se pudo comprobar la actualización.'
  return 'Comprobá manualmente o esperá el chequeo automático al abrir la app.'
}

function UpdatesSection() {
  const [state, setState] = useState<AppUpdateState | null>(null)
  const [action, setAction] = useState<'check' | 'download' | 'install' | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.updates.getState()
      .then(next => {
        if (!cancelled) setState(next)
      })
      .catch(err => {
        if (!cancelled) {
          setState({
            currentVersion: 'unknown',
            status: 'error',
            updateVersion: null,
            releaseName: null,
            releaseDate: null,
            releaseNotes: null,
            progress: null,
            error: err instanceof Error ? err.message : String(err),
            lastCheckedAt: null,
            canCheck: false,
            canDownload: false,
            canInstall: false,
          })
        }
      })
    const off = window.api.updates.onStateChanged(next => {
      if (!cancelled) setState(next)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const run = async (nextAction: 'check' | 'download' | 'install') => {
    setAction(nextAction)
    try {
      if (nextAction === 'check') setState(await window.api.updates.checkNow())
      if (nextAction === 'download') setState(await window.api.updates.download())
      if (nextAction === 'install') await window.api.updates.install()
    } finally {
      setAction(null)
    }
  }

  const current = state ?? {
    currentVersion: '...',
    status: 'idle',
    updateVersion: null,
    releaseName: null,
    releaseDate: null,
    releaseNotes: null,
    progress: null,
    error: null,
    lastCheckedAt: null,
    canCheck: false,
    canDownload: false,
    canInstall: false,
  } satisfies AppUpdateState
  const progress = current.progress?.percent ?? 0
  const transferred = current.progress
    ? `${formatUpdateBytes(current.progress.transferred)} / ${formatUpdateBytes(current.progress.total)}`
    : null

  return (
    <section className="set-section">
      <h2>Actualizaciones</h2>
      <div className="set-card">
        <div className="set-row">
          <div>
            <div className="lbl">GitHub Releases</div>
            <div className="sub">{updateSummary(current)}</div>
          </div>
          <span className={`update-status-badge ${current.status}`}>{UPDATE_STATUS_LABEL[current.status]}</span>
        </div>

        <div className="set-row">
          <div>
            <div className="lbl">Versión instalada</div>
            <div className="sub">Último chequeo {formatUpdateDate(current.lastCheckedAt)}</div>
          </div>
          <span className="update-value">{current.currentVersion}</span>
        </div>

        {current.updateVersion && (
          <div className="set-row">
            <div>
              <div className="lbl">Nueva versión</div>
              {current.releaseDate && (
                <div className="sub">Publicado {formatUpdateDate(current.releaseDate)}</div>
              )}
            </div>
            <span className="update-value">{current.updateVersion}</span>
          </div>
        )}

        {current.status === 'downloading' && (
          <div className="set-row">
            <div>
              <div className="lbl">Descargando</div>
              <div className="sub">{Math.round(progress)}%{transferred ? ` · ${transferred}` : ''}</div>
            </div>
            <div className="update-progress-meter" style={{ width: 160 }} aria-label={`Descarga ${Math.round(progress)}%`}>
              <i style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {current.releaseNotes && (
          <div className="set-row update-notes-row">
            <div className="update-notes-wrap">
              <div className="lbl">Notas de la versión</div>
              <div className="update-release-notes">{current.releaseNotes}</div>
            </div>
          </div>
        )}

        {current.error && current.status !== 'unsupported' && (
          <div className="set-row update-notes-row">
            <div className="update-notes-wrap">
              <div className="lbl">Error</div>
              <div className="device-error inline">{current.error}</div>
            </div>
          </div>
        )}

        <div className="set-row">
          <div>
            <div className="lbl">Gestión</div>
            <div className="sub">Buscar, descargar e instalar nuevas versiones.</div>
          </div>
          <div className="update-actions">
            <button className="btn" type="button" disabled={!current.canCheck || action != null} onClick={() => { void run('check') }}>
              <Icon name="rotate" size={13} /> {action === 'check' ? 'Buscando' : 'Buscar ahora'}
            </button>
            <button className="btn primary" type="button" disabled={!current.canDownload || action != null} onClick={() => { void run('download') }}>
              <Icon name="download" size={13} /> {action === 'download' ? 'Descargando' : 'Descargar'}
            </button>
            <button className="btn" type="button" disabled={!current.canInstall || action != null} onClick={() => { void run('install') }}>
              <Icon name="sync" size={13} /> Reiniciar e instalar
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

export function SettingsView({ tweak, setTweak, activeTab, playbackSubTab, onConnectDevice }: SettingsViewProps) {
  const [libraryLogOpen, setLibraryLogOpen] = useState(false)

  return (
    <div className="settings">
      <h1>Preferences</h1>
      <div id="settings-content">
        {activeTab === 'apariencia' ? (
          <AppearanceSection tweak={tweak} setTweak={setTweak} />
        ) : activeTab === 'reproduccion' ? (
          <div className="settings-tab-content">
            {playbackSubTab === 'general' ? (
              <PlaybackGeneralSection tweak={tweak} setTweak={setTweak} />
            ) : playbackSubTab === 'eq' ? (
              <PlaybackEqSection />
            ) : (
              <PlaybackLyricsSection tweak={tweak} setTweak={setTweak} />
            )}
          </div>
        ) : activeTab === 'bibliotecas' ? (
          <>
            <LibrariesSection
              tweak={tweak}
              setTweak={setTweak}
              libraryLogOpen={libraryLogOpen}
              setLibraryLogOpen={setLibraryLogOpen}
              onConnectDevice={onConnectDevice}
            />
            <CloudSettingsPanel />
          </>
        ) : (
          <UpdatesSection />
        )}
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
  orphan_lrc_removed: 'Letra huérfana eliminada',
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
  const audioApi = typeof window === 'undefined' ? null : window.api?.audio
  const unavailable = !audioApi

  const loadStats = async () => {
    if (!audioApi) {
      setStatus('Cache disponible solo en la app de escritorio')
      return
    }
    const next = await audioApi.getPlaybackCacheStats()
    setStats(next)
    setLimitMb(String(cacheLimitMb(next)))
  }

  useEffect(() => {
    if (!audioApi) {
      setStatus('Cache disponible solo en la app de escritorio')
      return
    }
    let cancelled = false
    void audioApi.getPlaybackCacheStats()
      .then(next => {
        if (cancelled) return
        setStats(next)
        setLimitMb(String(cacheLimitMb(next)))
      })
      .catch(() => { /* main not ready */ })

    const off = audioApi.onPlaybackCacheChanged(next => {
      if (cancelled) return
      setStats(next)
      setLimitMb(String(cacheLimitMb(next)))
    })
    return () => {
      cancelled = true
      off()
    }
  }, [audioApi])

  const saveLimit = async () => {
    if (!audioApi) {
      setStatus('Cache disponible solo en la app de escritorio')
      return
    }
    const mb = Math.max(64, Math.floor(Number(limitMb) || 1024))
    setBusy(true)
    setStatus(null)
    try {
      const next = await audioApi.setPlaybackCacheLimit(mb * 1024 * 1024)
      setStats(next)
      setLimitMb(String(cacheLimitMb(next)))
      setStatus('Límite actualizado')
    } finally {
      setBusy(false)
    }
  }

  const clearCache = async () => {
    if (!audioApi) {
      setStatus('Cache disponible solo en la app de escritorio')
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      const next = await audioApi.clearPlaybackCache()
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
            disabled={busy || unavailable}
            onChange={e => setLimitMb(e.target.value)}
            aria-label="Playback cache limit in MB"
          />
          <span>MB</span>
          <button className="btn ghost" disabled={busy || unavailable} onClick={saveLimit}>Guardar</button>
        </div>
      </div>
      <div className="set-row">
        <div>
          <div className="lbl">Gestión</div>
          <div className="sub">{status ?? `Límite actual: ${formatCacheBytes(max)}`}</div>
        </div>
        <div className="cache-limit-controls">
          <button className="btn ghost" disabled={busy || unavailable} onClick={() => { void loadStats() }}>Actualizar</button>
          <button className="btn danger" disabled={busy || unavailable || used <= 0} onClick={clearCache}>Limpiar cache</button>
        </div>
      </div>
    </div>
  )
}

function EqPanel() {
  const enabled = useEqStore(s => s.enabled)
  const preset = useEqStore(s => s.preset)
  const bands = useEqStore(s => s.bands)
  const bandCount = useEqStore(s => s.bandCount)
  const presetNames = useEqStore(s => s.presetNames)
  const setEnabled = useEqStore(s => s.setEnabled)
  const setBand = useEqStore(s => s.setBand)
  const setPreset = useEqStore(s => s.setPreset)
  const setBandCount = useEqStore(s => s.setBandCount)
  const playbackStatus = usePlaybackStore(s => s.status)
  const hasTrack = usePlaybackStore(s => s.currentTrack != null)
  const selectedPreset = presetNames.includes(preset) ? preset : 'Custom'
  const isPlaying = playbackStatus === 'playing'

  // The band-count slider commits on release (each change reattaches every
  // PEAKEQ instance, so we don't want to thrash that on every drag tick).
  const [countDraft, setCountDraft] = useState(bandCount)
  useEffect(() => { setCountDraft(bandCount) }, [bandCount])
  const commitCount = (count: number) => { void setBandCount(count) }

  const labels = useMemo(() => eqBandLabels(bandCount), [bandCount])
  // Keep the frequency axis readable as the count grows: show at most ~13 ticks.
  const labelStep = Math.max(1, Math.ceil(bandCount / 13))

  return (
    <>
      <div className="set-card" style={{ marginBottom: 12 }}>
        <div className="set-row">
          <div>
            <div className="lbl">Enable equalizer</div>
            <div className="sub">{bandCount}-band peaking EQ applied to the BASS playback chain.</div>
          </div>
          <div
            className={`toggle ${enabled ? 'on' : ''}`}
            onClick={() => { void setEnabled(!enabled) }}
            role="switch"
            aria-checked={enabled}
            tabIndex={0}
          />
        </div>
        <div className="set-row eq-bandcount-row">
          <div>
            <div className="lbl">Bands</div>
            <div className="sub">Hasta {EQ_MAX_BAND_COUNT} barras configurables. Actual: {bandCount}.</div>
          </div>
          <div className="eq-bandcount-control">
            <div className="eq-bandcount-presets">
              {EQ_BAND_COUNT_PRESETS.map(count => (
                <button
                  key={count}
                  type="button"
                  className={`eq-bandcount-chip ${bandCount === count ? 'active' : ''}`}
                  onClick={() => commitCount(count)}
                >
                  {count}
                </button>
              ))}
            </div>
            <div className="eq-bandcount-slider">
              <input
                type="range"
                min={EQ_MIN_BAND_COUNT}
                max={EQ_MAX_BAND_COUNT}
                step={1}
                value={countDraft}
                onChange={e => setCountDraft(Number(e.target.value))}
                onPointerUp={() => commitCount(countDraft)}
                onKeyUp={() => commitCount(countDraft)}
                aria-label="Number of EQ bands"
              />
              <span className="eq-bandcount-value">{countDraft}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="eq-graph" style={{ opacity: enabled ? 1 : 0.45 }}>
        {/* Unified surface: live spectrum + EQ-response curve, with the sliders
            exposing only their thumbs until drag darkens the spectrum. */}
        <EqGraph
          enabled={enabled}
          bands={bands}
          bandCount={bandCount}
          labels={labels}
          labelStep={labelStep}
          playing={isPlaying}
          hasTrack={hasTrack}
          onSetBand={(i, g) => { void setBand(i, g) }}
        />
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
