import { type DragEvent, useEffect, useRef, useState } from 'react'
import { LYRICS_OFFSET_LIMIT_MS, clampLyricsOffsetMs, isSyncedLrc, type LrcLine } from '@shared/lyrics/lrc'
import type { LyricsEmbedPreview } from '@shared/types/lyrics'
import { useLyricsStore } from '@renderer/stores/lyricsStore'
import { usePlaybackStore } from '@renderer/stores/playbackStore'
import { useQueueStore } from '@renderer/stores/queueStore'
import { useTweakStore } from '@renderer/stores/settingsStore'
import { Icon } from './Icon'
import { ModalShell } from './ModalShell'

interface LyricsPanelProps {
  variant: 'pane' | 'inline' | 'current' | 'side' | 'full' | 'subtitle'
  showActions?: boolean
  showInlineHeader?: boolean
  sidePaneOpen?: boolean
  onToggleSidePane?: () => void
}

type SyncedWindow = 'all' | 'preview' | 'current' | 'flow'

function windowForVariant(variant: LyricsPanelProps['variant']): SyncedWindow {
  if (variant === 'inline') return 'preview'
  if (variant === 'current' || variant === 'subtitle') return 'current'
  if (variant === 'side' || variant === 'full') return 'flow'
  return 'all'
}

function visibleSyncedLines(lines: LrcLine[], currentLineIndex: number, mode: SyncedWindow): Array<{ line: LrcLine; index: number }> {
  if (mode === 'all') return lines.map((line, index) => ({ line, index }))

  const activeIndex = currentLineIndex >= 0 ? currentLineIndex : 0
  const start = Math.max(0, activeIndex - (mode === 'current' ? 0 : 1))
  const end =
    mode === 'preview' ? Math.min(lines.length - 1, activeIndex + 2)
    : mode === 'current' ? activeIndex
    : lines.length - 1

  return lines.slice(start, end + 1).map((line, offset) => ({ line, index: start + offset }))
}

export function LyricsPanel({
  variant,
  showActions = true,
  showInlineHeader = true,
  sidePaneOpen = false,
  onToggleSidePane,
}: LyricsPanelProps) {
  const status = useLyricsStore(s => s.status)
  const parsed = useLyricsStore(s => s.parsed)
  const plainLines = useLyricsStore(s => s.plainLines)
  const currentLineIndex = useLyricsStore(s => s.currentLineIndex)
  const error = useLyricsStore(s => s.error)
  const view = useLyricsStore(s => s.view)
  const busy = useLyricsStore(s => s.busy)
  const searching = useLyricsStore(s => s.searching)
  const currentTrack = usePlaybackStore(s => s.currentTrack)
  const confirmBeforeWrite = useTweakStore(s => s.tweak.lyricsConfirmBeforeWrite)
  const globalOffsetMs = useTweakStore(s => s.tweak.lyricsGlobalOffsetMs)

  const [dragOver, setDragOver] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [embedOpen, setEmbedOpen] = useState(false)

  const activeLineRef = useRef<HTMLLIElement | null>(null)
  const lastUserScrollRef = useRef(0)
  const reducedMotionRef = useRef(false)
  const syncedWindow = windowForVariant(variant)
  const compactHeader = showInlineHeader && (variant === 'inline' || variant === 'current')

  useEffect(() => {
    reducedMotionRef.current = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  }, [])

  // Autoscroll the active line into view, unless the user scrolled recently.
  useEffect(() => {
    const el = activeLineRef.current
    if (!el || syncedWindow !== 'all') return
    if (Date.now() - lastUserScrollRef.current < 1200) return
    el.scrollIntoView({ block: 'center', behavior: reducedMotionRef.current ? 'auto' : 'smooth' })
  }, [currentLineIndex, syncedWindow])

  const hasTrack = currentTrack?.dbId != null
  const isFlac = currentTrack?.fmt === 'FLAC'
  const hasLyrics = status === 'found_synced' || status === 'found_plain' || status === 'low_confidence'
  const showSynced = !!parsed && (status === 'found_synced' || status === 'low_confidence')
  const showPlain = !showSynced && !!plainLines && (status === 'found_plain' || status === 'low_confidence')
  const subtitlePlainLine = variant === 'subtitle' ? plainLines?.find(line => line.trim().length > 0) : null
  const trackOffsetMs = parsed ? Math.round(parsed.meta.offsetSec * 1000) : 0

  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (!file || !/\.(lrc|txt)$/i.test(file.name)) return
    const text = await file.text()
    await useLyricsStore.getState().importFromText(text)
  }

  const onEmbedClick = () => {
    if (confirmBeforeWrite) setEmbedOpen(true)
    else void useLyricsStore.getState().embedInFile()
  }

  const seekToLine = (timeSec: number) => {
    const totalOffsetSec = (parsed?.meta.offsetSec ?? 0) + (clampLyricsOffsetMs(globalOffsetMs) / 1000)
    void useQueueStore.getState().seek(timeSec + totalOffsetSec)
  }

  const renderCompactHeader = () => {
    if (!compactHeader) return null
    return (
      <div className="lyr-inline-head">
        <span>Lyrics</span>
        {onToggleSidePane && (
          <button
            type="button"
            className={`tb-icon-btn ${sidePaneOpen ? 'active' : ''}`}
            title={sidePaneOpen ? 'Close lyrics sidebar' : 'Open lyrics sidebar'}
            aria-label={sidePaneOpen ? 'Close lyrics sidebar' : 'Open lyrics sidebar'}
            aria-pressed={sidePaneOpen}
            onClick={onToggleSidePane}
          >
            <Icon name="sidebarRight" size={13} />
          </button>
        )}
      </div>
    )
  }

  function renderBody() {
    if (!hasTrack) return <div className="lyr-empty"><div className="lyr-empty-title">Nada en reproducción</div></div>

    if (status === 'loading') {
      return (
        <div className="lyr-empty">
          <span className="lyr-spinner" aria-hidden="true" />
          <div className="lyr-empty-sub">Buscando letras…</div>
        </div>
      )
    }

    if (status === 'instrumental') {
      return (
        <div className="lyr-empty">
          <Icon name="note" size={26} />
          <div className="lyr-empty-title">Instrumental</div>
          {showActions && (
            <div className="lyr-empty-actions">
              <button type="button" className="btn sm" onClick={() => void useLyricsStore.getState().fetchOnline(true)}>Rebuscar</button>
            </div>
          )}
        </div>
      )
    }

    if (status === 'not_found' || status === 'none') {
      return (
        <div className="lyr-empty">
          <Icon name="lyrics" size={26} />
          <div className="lyr-empty-title">Sin letras</div>
          {showActions && (
            <div className="lyr-empty-actions">
              <button type="button" className="btn sm primary" disabled={searching} onClick={() => void useLyricsStore.getState().searchOnline()}>
                Buscar online
              </button>
              <button type="button" className="btn sm" disabled={busy} onClick={() => void useLyricsStore.getState().importFromFile()}>
                Importar .lrc
              </button>
            </div>
          )}
        </div>
      )
    }

    if (status === 'failed_provider' || status === 'error') {
      return (
        <div className="lyr-empty">
          <Icon name="info" size={24} />
          <div className="lyr-empty-title">{status === 'failed_provider' ? 'Proveedor no disponible' : 'Error'}</div>
          {error && <div className="lyr-empty-sub">{error}</div>}
          {showActions && (
            <div className="lyr-empty-actions">
              <button type="button" className="btn sm" onClick={() => void useLyricsStore.getState().fetchOnline(true)}>Reintentar</button>
            </div>
          )}
        </div>
      )
    }

    // found_synced / found_plain / low_confidence
    return (
      <>
        {status === 'low_confidence' && variant !== 'subtitle' && (
          <div className="lyr-warn">Coincidencia dudosa — ¿es la letra correcta?</div>
        )}
        {showSynced && parsed && (
          <ol className={`lyr-list ${syncedWindow === 'all' ? '' : 'lyr-list-window'}`} onWheel={() => { lastUserScrollRef.current = Date.now() }}>
            {visibleSyncedLines(parsed.lines, currentLineIndex, syncedWindow).map(({ line, index: i }) => {
              const isActive = i === currentLineIndex || (currentLineIndex < 0 && i === 0)
              const cls =
                isActive ? 'lyr-line lyr-line-active'
                : i < currentLineIndex ? 'lyr-line lyr-line-past'
                : 'lyr-line lyr-line-future'
              if (!line.text) return <li key={i} className="lyr-line-gap" aria-hidden="true" />
              return (
                <li
                  key={i}
                  ref={isActive ? activeLineRef : undefined}
                  className={cls}
                  onClick={() => seekToLine(line.timeSec)}
                >
                  {line.text}
                </li>
              )
            })}
          </ol>
        )}
        {showPlain && plainLines && (
          variant === 'subtitle' ? (
            <div className="lyr-plain lyr-plain-subtitle">
              <p className="lyr-plain-line">{subtitlePlainLine || ' '}</p>
            </div>
          ) : (
            <div className="lyr-plain">
              {plainLines.map((l, i) => <p key={i} className="lyr-plain-line">{l || ' '}</p>)}
            </div>
          )
        )}
      </>
    )
  }

  return (
    <div
      className={`lyr-panel lyr-${variant} lyr-status-${status}`}
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => { void onDrop(e) }}
    >
      {dragOver && <div className="lyr-dropzone">Suelta el .lrc aquí</div>}

      {renderCompactHeader()}
      <div className="lyr-body">{renderBody()}</div>

      {showActions && hasTrack && showSynced && parsed && (
        <LyricsOffsetControl
          trackOffsetMs={trackOffsetMs}
          globalOffsetMs={globalOffsetMs}
          busy={busy}
        />
      )}

      {showActions && hasTrack && hasLyrics && (
        <div className="lyr-actions">
          <button type="button" className="tb-icon-btn" title="Buscar online" disabled={searching} onClick={() => void useLyricsStore.getState().searchOnline()}>
            <Icon name="search" size={14} />
          </button>
          <button type="button" className="tb-icon-btn" title="Rebuscar" onClick={() => void useLyricsStore.getState().fetchOnline(true)}>
            <Icon name="rotate" size={14} />
          </button>
          <button type="button" className="tb-icon-btn" title="Importar .lrc" disabled={busy} onClick={() => void useLyricsStore.getState().importFromFile()}>
            <Icon name="download" size={14} />
          </button>
          <button type="button" className="tb-icon-btn" title="Editar" onClick={() => setEditorOpen(true)}>
            <Icon name="edit" size={14} />
          </button>
          <button type="button" className="tb-icon-btn" title="Exportar .lrc" disabled={busy} onClick={() => void useLyricsStore.getState().exportToFile()}>
            <Icon name="save" size={14} />
          </button>
          <button type="button" className="tb-icon-btn" title={isFlac ? 'Inyectar en el archivo FLAC' : 'Solo disponible para FLAC'} disabled={!isFlac || busy} onClick={onEmbedClick}>
            <Icon name="embed" size={14} />
          </button>
          <button type="button" className="tb-icon-btn" title="Quitar letras" disabled={busy} onClick={() => void useLyricsStore.getState().remove()}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      )}

      {error && hasLyrics && <div className="lyr-error">{error}</div>}

      {editorOpen && (
        <LyricsEditor
          initial={view?.syncedLyricsLrc ?? view?.plainLyrics ?? ''}
          onClose={() => setEditorOpen(false)}
        />
      )}
      {embedOpen && currentTrack?.dbId != null && (
        <EmbedConfirm trackId={currentTrack.dbId} onClose={() => setEmbedOpen(false)} />
      )}
    </div>
  )
}

function formatOffsetMs(value: number): string {
  return `${value > 0 ? '+' : ''}${value} ms`
}

function LyricsOffsetControl({
  trackOffsetMs,
  globalOffsetMs,
  busy,
}: {
  trackOffsetMs: number
  globalOffsetMs: number
  busy: boolean
}) {
  const [draft, setDraft] = useState(String(trackOffsetMs))
  const effectiveOffsetMs = trackOffsetMs + clampLyricsOffsetMs(globalOffsetMs)

  useEffect(() => {
    setDraft(String(trackOffsetMs))
  }, [trackOffsetMs])

  const commit = (nextValue?: number) => {
    if (nextValue == null && draft.trim() === '') {
      setDraft(String(trackOffsetMs))
      return
    }
    const next = clampLyricsOffsetMs(nextValue ?? Number(draft))
    setDraft(String(next))
    void useLyricsStore.getState().setTrackOffset(next)
  }

  return (
    <div className="lyr-offset">
      <div className="lyr-offset-readout">
        <span>Canción</span>
        <strong>{formatOffsetMs(trackOffsetMs)}</strong>
        <span>Total</span>
        <strong>{formatOffsetMs(effectiveOffsetMs)}</strong>
      </div>
      <div className="lyr-offset-controls">
        <button type="button" className="btn sm" title="Adelantar letra 250 ms" disabled={busy} onClick={() => commit(trackOffsetMs - 250)}>-250</button>
        <input
          type="number"
          className="number-input lyr-offset-input"
          min={-LYRICS_OFFSET_LIMIT_MS}
          max={LYRICS_OFFSET_LIMIT_MS}
          step={50}
          value={draft}
          disabled={busy}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setDraft(String(trackOffsetMs))
              e.currentTarget.blur()
            }
          }}
          aria-label="Desfasaje de esta canción en milisegundos"
        />
        <button type="button" className="btn sm" title="Retrasar letra 250 ms" disabled={busy} onClick={() => commit(trackOffsetMs + 250)}>+250</button>
        <button type="button" className="btn sm ghost" title="Resetear desfasaje de esta canción" disabled={busy || trackOffsetMs === 0} onClick={() => commit(0)}>0</button>
      </div>
    </div>
  )
}

function LyricsEditor({ initial, onClose }: { initial: string; onClose: () => void }) {
  const [text, setText] = useState(initial)
  const [saving, setSaving] = useState(false)

  const onSave = async () => {
    setSaving(true)
    const synced = isSyncedLrc(text)
    await useLyricsStore.getState().saveEdited(synced ? null : text, synced ? text : null)
    setSaving(false)
    onClose()
  }

  return (
    <ModalShell
      title="Editar letras"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancelar</button>
          <button type="button" className="btn primary" onClick={() => { void onSave() }} disabled={saving}>Guardar</button>
        </>
      )}
    >
      <textarea
        className="lyr-editor-area"
        value={text}
        onChange={e => setText(e.target.value)}
        spellCheck={false}
        placeholder={'Pegá la letra. Para sincronizada, usá líneas tipo [00:12.00]texto'}
      />
    </ModalShell>
  )
}

function EmbedConfirm({ trackId, onClose }: { trackId: number; onClose: () => void }) {
  const [preview, setPreview] = useState<LyricsEmbedPreview | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api?.lyrics?.previewEmbed(trackId).then(p => { if (!cancelled) setPreview(p) }).catch(() => {})
    return () => { cancelled = true }
  }, [trackId])

  const blocked = preview?.blocked ?? null

  const onConfirm = async () => {
    setWorking(true)
    const result = await useLyricsStore.getState().embedInFile()
    setWorking(false)
    if (result.ok) onClose()
  }

  return (
    <ModalShell
      title="Inyectar letras en el archivo"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={working}>Cancelar</button>
          <button type="button" className="btn primary" onClick={() => { void onConfirm() }} disabled={working || blocked != null}>
            Inyectar
          </button>
        </>
      )}
    >
      <p className="modal-copy">
        Se escribirán las letras dentro del archivo FLAC (Vorbis Comments).
        {preview?.willBackup ? ' Se creará un backup (.cratebak) antes de modificar.' : ''}
      </p>
      {preview?.hasExistingLyrics && (
        <p className="modal-muted">El archivo ya tiene letras embebidas.</p>
      )}
      {blocked === 'existing_lyrics' && (
        <div className="modal-error">El archivo ya tiene letras. Activá "Sobrescribir letras existentes" en Ajustes para reemplazarlas.</div>
      )}
      {blocked === 'not_flac' && <div className="modal-error">Solo se puede inyectar en archivos FLAC.</div>}
      {blocked === 'missing_metadata' && <div className="modal-error">No hay letras para inyectar.</div>}
    </ModalShell>
  )
}
