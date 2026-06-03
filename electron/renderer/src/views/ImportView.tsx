import { useState } from 'react'
import { Icon } from '@renderer/components/Icon'
import { FolderRemovalConfirmModal } from '@renderer/components/FolderRemovalConfirmModal'
import { useFolders, useImporting, useLibraryStore, useMetadataCompletionPrompt } from '@renderer/stores/libraryStore'
import { useNavIntentStore } from '@renderer/stores/navIntentStore'
import type { DbFolder } from '@shared/types/db'

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div
      style={{
        position: 'relative',
        height: 4,
        background: 'var(--bg-active)',
        borderRadius: 'var(--r-pill)',
        overflow: 'hidden',
        flex: 1,
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          width: `${pct}%`,
          background: 'var(--text-primary)',
          borderRadius: 'var(--r-pill)',
        }}
      />
    </div>
  )
}

export function ImportView() {
  const folders = useFolders()
  const importing = useImporting()
  const metadataPrompt = useMetadataCompletionPrompt()
  const dismissMetadataPrompt = useLibraryStore(s => s.dismissMetadataCompletionPrompt)
  const pickFolder = useLibraryStore(s => s.pickFolder)
  const addFolder = useLibraryStore(s => s.addFolder)
  const requestMetadataFix = useNavIntentStore(s => s.requestMetadataFix)
  const [removeTarget, setRemoveTarget] = useState<DbFolder | null>(null)
  const pickAndAdd = async () => {
    const picked = await pickFolder()
    if (picked) await addFolder(picked)
  }

  return (
    <div>
      <div className="lib-head">
        <div>
          <h1>Library Sources</h1>
          <div className="sub">Folders Crate watches for new files.</div>
        </div>
        <div className="actions">
          <button className="btn" onClick={pickAndAdd}>
            <Icon name="plus" size={12} /> Add Folder…
          </button>
        </div>
      </div>

      {importing && (
        <div
          style={{
            margin: '0 24px 16px',
            padding: '12px 16px',
            background: 'var(--bg-panel)',
            border: '0.5px solid var(--divider)',
            borderRadius: 10,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              fontSize: 13,
              color: 'var(--text-secondary)',
            }}
          >
            <Icon name="rotate" size={14} />
            <span style={{ color: 'var(--text-primary)' }}>
              {importing.phase === 'discovering'
                ? 'Discovering files…'
                : importing.phase === 'scanning'
                ? `Reading metadata… ${importing.scanned}/${importing.total}`
                : `Writing to library… ${importing.imported} tracks`}
            </span>
            <ProgressBar value={importing.scanned} max={Math.max(importing.total, 1)} />
            <span className="mono tiny" style={{ color: 'var(--text-tertiary)', minWidth: 50, textAlign: 'right' }}>
              {importing.total > 0 ? `${Math.round((importing.scanned / importing.total) * 100)}%` : '…'}
            </span>
          </div>
        </div>
      )}

      {metadataPrompt && (
        <div className="metadata-import-banner">
          <div className="metadata-import-icon"><Icon name="sparkle" size={16} /></div>
          <div className="metadata-import-main">
            <strong>Metadatos incompletos detectados</strong>
            <span>{metadataPrompt.trackIds.length} archivos tienen campos faltantes después de la importación.</span>
          </div>
          <button type="button" className="btn sm" onClick={() => requestMetadataFix(metadataPrompt.trackIds, undefined, metadataPrompt.trackIds.length)}>
            Revisar
          </button>
          <button type="button" className="tb-icon-btn" title="Descartar" onClick={dismissMetadataPrompt}>
            <Icon name="close" size={13} />
          </button>
        </div>
      )}

      <div className="import-drop" onClick={pickAndAdd} role="button" tabIndex={0}>
        <div className="ic"><Icon name="drop" size={32} stroke={1.3} /></div>
        <h3>Drop audio files here</h3>
        <p>FLAC, ALAC, AAC, MP3, AIFF, WAV · or use Add Folder above</p>
      </div>

      <div style={{ padding: '0 24px 24px' }}>
        <div className="set-section">
          <h2>Watched Folders</h2>
          <div className="set-card">
            {folders.length === 0 ? (
              <div style={{ padding: 16, color: 'var(--text-secondary)', fontSize: 13 }}>
                No folders added yet. Click "Add Folder…" above to import your music.
              </div>
            ) : (
              folders.map(f => (
                <div key={f.id} className="folder-row">
                  <Icon name="folder" />
                  <div className="path">{f.path}</div>
                  <div className="stat">{f.track_count} tracks</div>
                  <button className="btn ghost sm" onClick={() => setRemoveTarget(f)}>
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="set-section">
          <h2>Import Settings</h2>
          <div className="set-card">
            <div className="set-row">
              <div>
                <div className="lbl">Read tags & artwork on import</div>
                <div className="sub">ID3v2 / Vorbis / iXML metadata.</div>
              </div>
              <div className="toggle on" />
            </div>
            <div className="set-row">
              <div>
                <div className="lbl">Auto-fetch missing artwork</div>
                <div className="sub">From MusicBrainz when albums are unidentified.</div>
              </div>
              <div className="toggle" />
            </div>
            <div className="set-row">
              <div>
                <div className="lbl">Keep files in original location</div>
                <div className="sub">Don't copy into the library folder.</div>
              </div>
              <div className="toggle on" />
            </div>
          </div>
        </div>
      </div>

      {removeTarget && (
        <FolderRemovalConfirmModal folder={removeTarget} onClose={() => setRemoveTarget(null)} />
      )}
    </div>
  )
}
