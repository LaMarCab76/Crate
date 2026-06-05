import { useState } from 'react'
import { ModalShell } from './ModalShell'
import { useCloudStore } from '@renderer/stores/cloudStore'
import { useFolders } from '@renderer/stores/libraryStore'
import type { Track } from '@shared/types/library'
import type { CloudMoveDisposition } from '@shared/types/cloud'

const DISPOSITION_LABEL: Record<CloudMoveDisposition, string> = {
  trash: 'enviará a la papelera del sistema',
  keep: 'conservará en disco',
  delete: 'borrará permanentemente',
  ask: 'tratará según tu preferencia',
}

export function MoveToCloudModal({ track, onClose }: { track: Track; onClose: () => void }) {
  const folders = useFolders()
  const cloudFolders = folders.filter(f => f.source === 'onedrive')
  const prefs = useCloudStore(s => s.prefs)
  const moveProgress = useCloudStore(s => s.moveProgress)
  const moveToCloud = useCloudStore(s => s.moveToCloud)
  const [targetId, setTargetId] = useState<number | null>(cloudFolders[0]?.id ?? null)
  const [busy, setBusy] = useState(false)

  const disposition = prefs?.moveDisposition ?? 'trash'
  const inProgress = busy && moveProgress != null && moveProgress.trackId === track.dbId && moveProgress.phase !== 'done'
  const pct = moveProgress && moveProgress.total > 0
    ? Math.round((moveProgress.uploaded / moveProgress.total) * 100)
    : 0

  const run = async (): Promise<void> => {
    if (track.dbId == null || targetId == null) return
    setBusy(true)
    await moveToCloud({ trackId: track.dbId, targetFolderId: targetId })
    setBusy(false)
    onClose()
  }

  return (
    <ModalShell title="Mover a OneDrive" onClose={onClose}>
      <p className="set-section-sub">
        «{track.t}» se subirá a OneDrive y se reproducirá desde la nube. El archivo local se{' '}
        {DISPOSITION_LABEL[disposition]}.
      </p>
      {cloudFolders.length === 0 ? (
        <div className="library-empty">Primero agregá una carpeta de OneDrive en Ajustes › Bibliotecas.</div>
      ) : (
        <div className="rule-row" style={{ gap: 8, margin: '8px 0' }}>
          <select
            className="settings-select"
            value={targetId ?? ''}
            onChange={e => setTargetId(Number(e.target.value))}
            style={{ flex: 1 }}
          >
            {cloudFolders.map(f => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </div>
      )}
      {inProgress && (
        <div className="sub">
          {moveProgress?.phase === 'finalizing' ? 'Finalizando…' : `Subiendo… ${pct}%`}
        </div>
      )}
      <div className="rule-row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn ghost sm" type="button" onClick={onClose} disabled={busy}>Cancelar</button>
        <button
          className="btn sm"
          type="button"
          onClick={() => { void run() }}
          disabled={busy || targetId == null}
        >
          {busy ? 'Moviendo…' : 'Mover'}
        </button>
      </div>
    </ModalShell>
  )
}
