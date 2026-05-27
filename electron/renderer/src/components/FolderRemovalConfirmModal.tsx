import { useState } from 'react'
import type { DbFolder } from '@shared/types/db'
import { useLibraryStore } from '@renderer/stores/libraryStore'
import { ModalShell } from './ModalShell'

export function FolderRemovalConfirmModal({
  folder,
  onClose,
  onRemoved,
}: {
  folder: DbFolder
  onClose: () => void
  onRemoved?: () => void
}) {
  const removeFolder = useLibraryStore(s => s.removeFolder)
  const [working, setWorking] = useState<'unlink' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const confirm = async (deleteMusic: boolean) => {
    setWorking(deleteMusic ? 'delete' : 'unlink')
    setError(null)
    try {
      await removeFolder(folder.id, { deleteMusic })
      onRemoved?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(null)
    }
  }

  return (
    <ModalShell
      title="Eliminar carpeta"
      onClose={working ? () => undefined : onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={working != null}>Cancelar</button>
          <button type="button" className="btn ghost" disabled={working != null} onClick={() => { void confirm(false) }}>
            {working === 'unlink' ? 'Quitando...' : 'Solo quitar conexión'}
          </button>
          <button type="button" className="btn danger" disabled={working != null} onClick={() => { void confirm(true) }}>
            {working === 'delete' ? 'Moviendo...' : 'Mover carpeta a Papelera'}
          </button>
        </>
      )}
    >
      <p className="modal-copy">
        Elegí si Crate solo deja de mirar esta carpeta o si también mueve la carpeta completa a Papelera.
      </p>
      <div className="folder-remove-target">
        <strong>{folder.name}</strong>
        <span>{folder.path}</span>
        <em>{folder.track_count} temas vinculados</em>
      </div>
      {error && <pre className="modal-error">{error}</pre>}
    </ModalShell>
  )
}
