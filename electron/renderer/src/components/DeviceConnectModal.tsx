import { useEffect, useMemo, useState } from 'react'
import { useFolders } from '@renderer/stores/libraryStore'
import { useDeviceStore } from '@renderer/stores/deviceStore'
import { basenameForPath, isValidDeviceMusicRoot, normalizeDeviceMusicRoot } from '@renderer/utils/devicePaths'
import { isLocalLibraryDestination } from '@renderer/utils/libraryDestinations'
import type { DeviceRecord } from '@shared/types/device-sync'
import type { DbFolder } from '@shared/types/db'
import { computerTerms } from '@shared/utils/computerTerms'
import { Icon } from './Icon'
import { ModalShell } from './ModalShell'

const COMPUTER = computerTerms(window.api.meta.platform)

export interface DeviceConnectTarget {
  token: string
  displayPath: string
  name?: string
  hasCrateState?: boolean
}

interface DeviceConnectModalProps {
  target: DeviceConnectTarget
  artworkMaxEdge: number
  onClose: () => void
  onConnected?: (device: DeviceRecord) => void
}

function folderLabel(folder: DbFolder): string {
  return folder.name || basenameForPath(folder.path)
}

export function DeviceConnectModal({
  target,
  artworkMaxEdge,
  onClose,
  onConnected,
}: DeviceConnectModalProps) {
  const folders = useFolders()
  const destinationFolders = useMemo(
    () => folders.filter(isLocalLibraryDestination),
    [folders],
  )
  const connect = useDeviceStore(s => s.connect)
  const loading = useDeviceStore(s => s.loading)
  const [musicRoot, setMusicRoot] = useState('.')
  const [resetDeviceState, setResetDeviceState] = useState(false)
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(
    destinationFolders.length === 1 ? destinationFolders[0].id : null,
  )
  const [localError, setLocalError] = useState<string | null>(null)
  const selectedFolder = destinationFolders.find(folder => folder.id === selectedFolderId) ?? null
  const musicRootValid = isValidDeviceMusicRoot(musicRoot)
  const canConnect = !loading && musicRootValid && selectedFolder != null
  const targetName = target.name ?? basenameForPath(target.displayPath)

  useEffect(() => {
    setSelectedFolderId(current => {
      if (current != null && destinationFolders.some(folder => folder.id === current)) return current
      return destinationFolders.length === 1 ? destinationFolders[0].id : null
    })
  }, [destinationFolders])
  useEffect(() => {
    setResetDeviceState(false)
  }, [target.token])

  const pickMusicRoot = async () => {
    setLocalError(null)
    try {
      const picked = await window.api.devices.pickMusicRoot(
        { token: target.token },
        normalizeDeviceMusicRoot(musicRoot),
      )
      if (!picked.canceled && picked.musicRoot) setMusicRoot(picked.musicRoot)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
    }
  }

  const connectDevice = async () => {
    if (!selectedFolder) return
    setLocalError(null)
    try {
      const device = await connect({
        token: target.token,
        name: targetName,
        musicRoot: normalizeDeviceMusicRoot(musicRoot),
        pcTargetPath: selectedFolder.path,
        sourceLibraryIds: [selectedFolder.id],
        artworkMaxEdge,
        resetDeviceState: target.hasCrateState === true && resetDeviceState,
      })
      onConnected?.(device)
      onClose()
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <ModalShell
      title="Conectar MP3/DAP"
      onClose={onClose}
      footer={(
        <>
          <button className="btn ghost" type="button" disabled={loading} onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" type="button" disabled={!canConnect} onClick={() => void connectDevice()}>
            <Icon name="device" size={13} />
            Conectar
          </button>
        </>
      )}
    >
      <div className="device-connect-modal">
        <div className="device-connect-target">
          <Icon name="device" size={15} />
          <span>
            <strong>{targetName}</strong>
            <em>{target.displayPath}</em>
          </span>
        </div>

        <label className="device-field">
          <span>Carpeta en MP3</span>
          <div className="device-path-control">
            <input
              value={musicRoot}
              onChange={event => setMusicRoot(event.target.value)}
              placeholder="."
              aria-invalid={!musicRootValid}
            />
            <button className="btn icon" type="button" disabled={loading} title="Elegir carpeta en el MP3" onClick={() => void pickMusicRoot()}>
              <Icon name="folder" size={13} />
            </button>
          </div>
        </label>
        {!musicRootValid && (
          <div className="device-error inline">La carpeta del MP3 no puede usar segmentos ..</div>
        )}
        {target.hasCrateState && (
          <div className="device-state-mode">
            <span>Estado encontrado en el dispositivo</span>
            <div className="migration-radio-row">
              <label>
                <input
                  type="radio"
                  name={`crate-state-mode-${target.token}`}
                  checked={!resetDeviceState}
                  onChange={() => setResetDeviceState(false)}
                />
                Usar configuración existente
              </label>
              <label>
                <input
                  type="radio"
                  name={`crate-state-mode-${target.token}`}
                  checked={resetDeviceState}
                  onChange={() => setResetDeviceState(true)}
                />
                Arrancar desde cero
              </label>
            </div>
          </div>
        )}
        {localError && <div className="device-error inline">{localError}</div>}

        <div className="device-connect-library-head">
          <span>{COMPUTER.library}</span>
          <strong>{selectedFolder?.path ?? 'Seleccioná una biblioteca'}</strong>
        </div>
        <div className="device-library-list device-connect-library-list">
          {destinationFolders.length === 0 ? (
            <div className="device-empty compact">Agregá una biblioteca local antes de conectar el dispositivo.</div>
          ) : (
            destinationFolders.map(folder => (
              <label className="device-library-row" key={folder.id} title={folder.path}>
                <input
                  type="radio"
                  name="device-connect-library"
                  checked={selectedFolderId === folder.id}
                  disabled={loading}
                  onChange={() => setSelectedFolderId(folder.id)}
                />
                <span className="device-library-name">{folderLabel(folder)}</span>
                <span className="mono">{folder.track_count}</span>
              </label>
            ))
          )}
        </div>
      </div>
    </ModalShell>
  )
}
