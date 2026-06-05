import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@renderer/components/Icon'
import { ModalShell } from '@renderer/components/ModalShell'
import { useCloudStore } from '@renderer/stores/cloudStore'
import { useFolders } from '@renderer/stores/libraryStore'
import type { CloudMoveDisposition, RemoteFolderEntry } from '@shared/types/cloud'

const DISPOSITION_OPTIONS: Array<{ value: CloudMoveDisposition; label: string }> = [
  { value: 'trash', label: 'Mandar a la papelera' },
  { value: 'keep', label: 'Conservar el original' },
  { value: 'delete', label: 'Borrado permanente' },
  { value: 'ask', label: 'Preguntar cada vez' },
]

interface BrowseLevel {
  driveId: string | null
  itemId: string | null
  name: string
}

function RemoteFolderBrowser({ onClose }: { onClose: () => void }) {
  const listRemoteFolders = useCloudStore(s => s.listRemoteFolders)
  const addFolder = useCloudStore(s => s.addFolder)
  const [stack, setStack] = useState<BrowseLevel[]>([{ driveId: null, itemId: null, name: 'OneDrive' }])
  const [entries, setEntries] = useState<RemoteFolderEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [addingId, setAddingId] = useState<string | null>(null)

  const current = stack[stack.length - 1]

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void listRemoteFolders(current.driveId, current.itemId).then(list => {
      if (!cancelled) {
        setEntries(list)
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [current.driveId, current.itemId, listRemoteFolders])

  const drillInto = (entry: RemoteFolderEntry): void => {
    setStack(prev => [...prev, { driveId: entry.driveId, itemId: entry.itemId, name: entry.name }])
  }

  const goUp = (): void => {
    setStack(prev => (prev.length > 1 ? prev.slice(0, -1) : prev))
  }

  const register = async (entry: RemoteFolderEntry): Promise<void> => {
    setAddingId(entry.itemId)
    await addFolder(entry.driveId, entry.itemId, entry.name)
    setAddingId(null)
    onClose()
  }

  return (
    <ModalShell title="Elegir carpeta de OneDrive" onClose={onClose}>
      <div className="set-section-head">
        <button className="btn ghost sm" type="button" disabled={stack.length <= 1} onClick={goUp}>
          <Icon name="back" size={12} /> Subir
        </button>
        <span className="sub">{stack.map(l => l.name).join(' / ')}</span>
      </div>
      <div className="set-card">
        {loading ? (
          <div className="library-empty">Cargando…</div>
        ) : entries.length === 0 ? (
          <div className="library-empty">No hay subcarpetas aquí.</div>
        ) : (
          entries.map(entry => (
            <div className="set-row library-row" key={entry.itemId}>
              <button
                className="library-row-main"
                type="button"
                style={{ background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                onClick={() => drillInto(entry)}
              >
                <Icon name="folder" size={16} />
                <div className="library-row-text">
                  <div className="lbl">{entry.name}</div>
                  <div className="sub">{entry.childCount} elementos</div>
                </div>
              </button>
              <div className="library-row-side">
                <button
                  className="btn sm"
                  type="button"
                  disabled={addingId === entry.itemId}
                  onClick={() => { void register(entry) }}
                >
                  {addingId === entry.itemId ? 'Agregando…' : 'Agregar'}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </ModalShell>
  )
}

export function CloudSettingsPanel() {
  const account = useCloudStore(s => s.account)
  const prefs = useCloudStore(s => s.prefs)
  const busy = useCloudStore(s => s.busy)
  const error = useCloudStore(s => s.error)
  const syncProgress = useCloudStore(s => s.syncProgress)
  const load = useCloudStore(s => s.load)
  const connect = useCloudStore(s => s.connect)
  const disconnect = useCloudStore(s => s.disconnect)
  const setClientId = useCloudStore(s => s.setClientId)
  const setPrefs = useCloudStore(s => s.setPrefs)
  const syncFolder = useCloudStore(s => s.syncFolder)

  const folders = useFolders()
  const cloudFolders = useMemo(() => folders.filter(f => f.source === 'onedrive'), [folders])

  const [clientIdInput, setClientIdInput] = useState('')
  const [browsing, setBrowsing] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section className="set-section">
      <div className="set-section-head">
        <h2>OneDrive</h2>
        {account?.connected && (
          <button className="btn sm" type="button" disabled={busy} onClick={() => setBrowsing(true)}>
            <Icon name="plus" size={12} /> Agregar carpeta
          </button>
        )}
      </div>
      <p className="set-section-sub">
        Reproducí canciones directo desde OneDrive sin guardarlas en el disco. El audio se carga en RAM al
        reproducir; solo el índice vive en la base de datos local.
      </p>
      {error && <pre className="modal-error library-folders-error">{error}</pre>}

      <div className="set-card">
        {!account?.clientIdConfigured ? (
          <div className="set-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <div>
              <div className="lbl">Falta el Application (client) ID de Azure</div>
              <div className="sub">
                Registrá una app pública en Microsoft Entra (gratis, sirve Azure for Students) con redirect URI
                http://localhost y permisos Files.ReadWrite, User.Read, offline_access. Pegá su clientId acá.
              </div>
            </div>
            <div className="rule-row" style={{ gap: 8, margin: 0 }}>
              <input
                className="settings-input"
                placeholder="00000000-0000-0000-0000-000000000000"
                value={clientIdInput}
                onChange={e => setClientIdInput(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                className="btn sm"
                type="button"
                disabled={busy || clientIdInput.trim().length === 0}
                onClick={() => { void setClientId(clientIdInput.trim()) }}
              >
                Guardar
              </button>
            </div>
          </div>
        ) : account.connected ? (
          <div className="set-row">
            <div className="library-row-main">
              <Icon name="cloud" size={16} />
              <div className="library-row-text">
                <div className="lbl">{account.displayName ?? 'Cuenta conectada'}</div>
                <div className="sub">{account.email ?? 'OneDrive personal'}</div>
              </div>
            </div>
            <div className="library-row-side">
              <button className="btn ghost sm" type="button" disabled={busy} onClick={() => { void disconnect() }}>
                Desconectar
              </button>
            </div>
          </div>
        ) : (
          <div className="set-row">
            <div>
              <div className="lbl">Cuenta no conectada</div>
              <div className="sub">Conectá tu cuenta Microsoft personal para empezar a indexar.</div>
            </div>
            <button className="btn sm" type="button" disabled={busy} onClick={() => { void connect() }}>
              {busy ? 'Conectando…' : 'Conectar OneDrive'}
            </button>
          </div>
        )}
      </div>

      {account?.connected && (
        <>
          <div className="set-section-head" style={{ marginTop: 16 }}>
            <h2 style={{ fontSize: '0.95rem' }}>Al mover una canción local a OneDrive</h2>
          </div>
          <div className="set-card">
            <div className="set-row">
              <div>
                <div className="lbl">Archivo original</div>
                <div className="sub">Qué hacer con el archivo en disco tras subirlo.</div>
              </div>
              <select
                className="settings-select"
                value={prefs?.moveDisposition ?? 'trash'}
                onChange={e => { void setPrefs({ moveDisposition: e.target.value as CloudMoveDisposition }) }}
              >
                {DISPOSITION_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="set-section-head" style={{ marginTop: 16 }}>
            <h2 style={{ fontSize: '0.95rem' }}>Carpetas de OneDrive</h2>
          </div>
          <div className="set-card">
            {cloudFolders.length === 0 ? (
              <div className="library-empty">No agregaste carpetas de OneDrive todavía.</div>
            ) : (
              cloudFolders.map(folder => {
                const syncing = syncProgress?.folderId === folder.id && syncProgress.phase !== 'done' && syncProgress.phase !== 'error'
                return (
                  <div className="set-row library-row" key={folder.id}>
                    <div className="library-row-main">
                      <Icon name="cloud" size={16} />
                      <div className="library-row-text">
                        <div className="lbl">{folder.name}</div>
                        <div className="sub">
                          {syncing
                            ? `Sincronizando… ${syncProgress?.imported ?? 0} temas`
                            : `${folder.track_count} temas`}
                        </div>
                      </div>
                    </div>
                    <div className="library-row-side">
                      <button
                        className="btn ghost sm"
                        type="button"
                        disabled={syncing}
                        onClick={() => { void syncFolder(folder.id) }}
                      >
                        {syncing ? 'Sincronizando' : 'Sincronizar'}
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </>
      )}

      {browsing && <RemoteFolderBrowser onClose={() => setBrowsing(false)} />}
    </section>
  )
}
