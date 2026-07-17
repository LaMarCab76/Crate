import { useEffect, useState } from 'react'
import type {
  LibraryMigrationState,
  LibraryMigrationTarget,
  UnifiedBackupChoice,
} from '@shared/types/library-locations'
import { useLibraryLocationsStore, type LibraryLocation, type OneDriveFolderEntry } from '@renderer/stores/libraryLocationsStore'
import { useMigrationStore } from '@renderer/stores/migrationStore'
import { Icon } from './Icon'
import { ModalShell } from './ModalShell'

interface RootChoiceLocal {
  provider: 'local'
  token: string
  label: string
}

interface RootChoiceCloud {
  provider: 'onedrive'
  driveId: string
  itemId: string
  name: string
  remotePath: string
  label: string
}

type RootChoice = RootChoiceLocal | RootChoiceCloud

function targetFromRoot(root: RootChoice): LibraryMigrationTarget {
  return root.provider === 'local'
    ? { kind: 'new-local', token: root.token }
    : {
        kind: 'new-onedrive',
        driveId: root.driveId,
        itemId: root.itemId,
        name: root.name,
        remotePath: root.remotePath,
      }
}

function backupFromRoot(root: RootChoice): UnifiedBackupChoice {
  return root.provider === 'local'
    ? { kind: 'new-local', token: root.token }
    : {
        kind: 'new-onedrive',
        driveId: root.driveId,
        itemId: root.itemId,
        name: root.name,
        remotePath: root.remotePath,
      }
}

function RemoteRootPicker({ onChoose }: { onChoose: (choice: RootChoiceCloud) => void }) {
  const oneDrive = useLibraryLocationsStore(state => state.oneDrive)
  const connect = useLibraryLocationsStore(state => state.connectOneDrive)
  const listFolders = useLibraryLocationsStore(state => state.listOneDriveFolders)
  const busy = useLibraryLocationsStore(state => state.pickerBusy)
  const [stack, setStack] = useState<Array<{ driveId: string | null; itemId: string | null; name: string }>>([
    { driveId: null, itemId: null, name: 'OneDrive' },
  ])
  const [entries, setEntries] = useState<OneDriveFolderEntry[]>([])
  const [loading, setLoading] = useState(false)
  const current = stack[stack.length - 1]

  useEffect(() => {
    if (!oneDrive?.connected) return
    setLoading(true)
    void listFolders(current.driveId, current.itemId).then(next => {
      setEntries(next)
      setLoading(false)
    })
  }, [current.driveId, current.itemId, listFolders, oneDrive?.connected])

  if (oneDrive?.clientIdConfigured === false) {
    return <div className="loc-picker-empty">Configurá el Application ID de Microsoft en esta misma sección antes de elegir OneDrive.</div>
  }
  if (!oneDrive?.connected) {
    return (
      <button className="btn primary" type="button" disabled={busy} onClick={() => { void connect() }}>
        <Icon name="cloud" size={13} /> Conectar OneDrive
      </button>
    )
  }
  return (
    <div className="migration-remote-picker">
      <nav className="loc-breadcrumbs" aria-label="Ruta del destino OneDrive">
        {stack.map((level, index) => (
          <span key={`${level.itemId ?? 'root'}-${index}`}>
            {index > 0 && <Icon name="chevR" size={10} />}
            <button type="button" onClick={() => setStack(previous => previous.slice(0, index + 1))}>{level.name}</button>
          </span>
        ))}
      </nav>
      <div className="loc-remote-list">
        {loading ? (
          <div className="loc-picker-empty"><Icon name="loader" size={14} className="loc-spin" /> Cargando…</div>
        ) : entries.length === 0 ? (
          <div className="loc-picker-empty">Esta ubicación no tiene subcarpetas.</div>
        ) : entries.map(entry => (
          <div className="loc-remote-row" key={`${entry.driveId}-${entry.itemId}`}>
            <button
              className="loc-remote-open"
              type="button"
              onClick={() => setStack(previous => [...previous, {
                driveId: entry.driveId,
                itemId: entry.itemId,
                name: entry.name,
              }])}
            >
              <Icon name="folder" size={15} />
              <span><strong>{entry.name}</strong><small>{entry.path}</small></span>
              <Icon name="chevR" size={11} />
            </button>
            <button className="btn sm" type="button" onClick={() => onChoose({
              provider: 'onedrive',
              driveId: entry.driveId,
              itemId: entry.itemId,
              name: entry.name,
              remotePath: entry.path,
              label: entry.path,
            })}>Elegir</button>
          </div>
        ))}
      </div>
    </div>
  )
}

function NewRootPicker({ choice, onChange }: { choice: RootChoice | null; onChange: (choice: RootChoice) => void }) {
  const [provider, setProvider] = useState<'local' | 'onedrive'>(choice?.provider ?? 'local')
  const pickLocal = async () => {
    const result = await window.api.libraryLocations.pickLocal()
    if (!result.canceled && result.token && result.displayPath) {
      onChange({ provider: 'local', token: result.token, label: result.displayPath })
    }
  }
  return (
    <div className="migration-new-root">
      <div className="loc-provider-choice compact" role="group" aria-label="Proveedor del destino">
        {(['local', 'onedrive'] as const).map(item => (
          <button
            className={`loc-provider-option ${provider === item ? 'selected' : ''}`}
            type="button"
            key={item}
            onClick={() => setProvider(item)}
            aria-pressed={provider === item}
          >
            <span className={`loc-provider-icon ${item}`}><Icon name={item === 'local' ? 'folder' : 'cloud'} size={16} /></span>
            <span><strong>{item === 'local' ? 'Carpeta local' : 'OneDrive'}</strong></span>
            <Icon name="check" size={12} className="loc-provider-check" />
          </button>
        ))}
      </div>
      {provider === 'local' ? (
        <button className="btn" type="button" onClick={() => { void pickLocal() }}>
          <Icon name="folder" size={13} /> {choice?.provider === 'local' ? 'Cambiar carpeta' : 'Elegir carpeta'}
        </button>
      ) : (
        <RemoteRootPicker onChoose={onChange} />
      )}
      {choice && <div className="migration-selected-root"><Icon name="check" size={12} /><span>{choice.label}</span></div>}
    </div>
  )
}

export function MigrationPlanReview({ run }: { run: LibraryMigrationState }) {
  return (
    <div className="migration-plan-review">
      <div className="loc-diff-summary">
        <span><b>{run.filesToTransfer}</b> archivos</span>
        <span><b>{run.directoriesToCreate}</b> carpetas</span>
        <span><b>{run.identicalFiles}</b> idénticos</span>
        <span className="conflict"><b>{run.renamedFiles}</b> renombrados</span>
      </div>
      <div className="migration-plan-size">
        <Icon name="sync" size={13} /> {run.bytesToTransfer.toLocaleString('es-AR')} bytes a transferir
      </div>
      {run.warnings.length > 0 && (
        <div className="loc-inline-error warning">
          <Icon name="info" size={13} />
          <span>{run.warnings.length} entradas se omitirán o requieren atención.</span>
        </div>
      )}
      {run.conflicts.length > 0 && (
        <div className="loc-diff-list">
          {run.conflicts.map(conflict => (
            <div className={`loc-diff-row ${conflict.resolution === 'rename' ? 'update' : 'create'}`} key={`${conflict.sourcePath}-${conflict.destinationPath}`}>
              <span>{conflict.resolution === 'rename' ? 'Renombrar' : 'Deduplicar'}</span>
              <code>{conflict.sourcePath}</code>
              <small>→ {conflict.destinationPath}</small>
            </div>
          ))}
        </div>
      )}
      <p className="modal-copy">El catálogo cambia recién después de transferir y verificar todo. La fuente nunca se modifica durante la migración.</p>
    </div>
  )
}

export function LibraryMigrationWizard({
  source,
  locations,
  onClose,
  onChanged,
}: {
  source: LibraryLocation
  locations: LibraryLocation[]
  onClose: () => void
  onChanged: () => void | Promise<void>
}) {
  const create = useMigrationStore(state => state.create)
  const approve = useMigrationStore(state => state.approve)
  const cancel = useMigrationStore(state => state.cancel)
  const storeError = useMigrationStore(state => state.error)
  const clearError = useMigrationStore(state => state.clearError)
  const [migrationMode, setMigrationMode] = useState<'relocate' | 'merge'>(source.role === 'backup' ? 'relocate' : 'relocate')
  const [root, setRoot] = useState<RootChoice | null>(null)
  const [targetFolderId, setTargetFolderId] = useState<number | null>(null)
  const [targetName, setTargetName] = useState(source.name)
  const [sourceDisposition, setSourceDisposition] = useState<'keep' | 'trash'>('keep')
  const [backupChoice, setBackupChoice] = useState<string>('none')
  const [newBackupRoot, setNewBackupRoot] = useState<RootChoice | null>(null)
  const [migrateLinkedBackup, setMigrateLinkedBackup] = useState(false)
  const [linkedBackupRoot, setLinkedBackupRoot] = useState<RootChoice | null>(null)
  const [plan, setPlan] = useState<LibraryMigrationState | null>(null)
  const [linkedBackupPlan, setLinkedBackupPlan] = useState<LibraryMigrationState | null>(null)
  const [busy, setBusy] = useState(false)

  const libraries = locations.filter(location => location.role === 'library' && location.id !== source.id)
  const target = targetFolderId == null ? null : locations.find(location => location.id === targetFolderId) ?? null
  const sourceBackup = locations.find(location => location.role === 'backup' && location.backupSourceFolderId === source.id)
  const targetBackup = target == null
    ? null
    : locations.find(location => location.role === 'backup' && location.backupSourceFolderId === target.id)
  const protectedRoot = source.provider === 'local'
    ? /^\/?$/.test(source.path)
    : source.remotePath === '/'

  useEffect(() => {
    clearError()
  }, [clearError])

  useEffect(() => {
    if (migrationMode !== 'merge' || !target) return
    setTargetName(target.name)
    setBackupChoice(targetBackup ? `existing:${targetBackup.id}` : sourceBackup ? `existing:${sourceBackup.id}` : 'none')
  }, [migrationMode, sourceBackup, target, targetBackup])

  const close = async () => {
    for (const pending of [plan, linkedBackupPlan]) {
      if (pending?.status !== 'awaiting_approval') continue
      try { await cancel(pending.runId) } catch { /* the row retains the recoverable run */ }
    }
    onClose()
  }

  const unifiedBackup = (): UnifiedBackupChoice | undefined => {
    if (migrationMode !== 'merge') return undefined
    if (backupChoice === 'none') return { kind: 'none' }
    if (backupChoice.startsWith('existing:')) return { kind: 'existing', folderId: Number(backupChoice.slice(9)) }
    if (backupChoice === 'new' && newBackupRoot) return backupFromRoot(newBackupRoot)
    return { kind: 'none' }
  }

  const canPlan = (migrationMode === 'merge' ? targetFolderId != null : root != null)
    && !(migrationMode === 'merge' && backupChoice === 'new' && newBackupRoot == null)
    && !(migrationMode === 'relocate' && migrateLinkedBackup && linkedBackupRoot == null)
  const buildPlan = async () => {
    if (!canPlan) return
    setBusy(true)
    let primary: LibraryMigrationState | null = null
    let backup: LibraryMigrationState | null = null
    try {
      const targetRequest: LibraryMigrationTarget = migrationMode === 'merge'
        ? { kind: 'existing-library', folderId: targetFolderId! }
        : targetFromRoot(root!)
      primary = await create({
        sourceFolderId: source.id,
        mode: migrationMode,
        target: targetRequest,
        sourceDisposition,
        unifiedBackup: unifiedBackup(),
        targetDisplayName: targetName.trim() || source.name,
      })
      if (migrationMode === 'relocate' && migrateLinkedBackup && sourceBackup && linkedBackupRoot) {
        backup = await create({
          sourceFolderId: sourceBackup.id,
          mode: 'relocate',
          target: targetFromRoot(linkedBackupRoot),
          sourceDisposition: 'keep',
          targetDisplayName: sourceBackup.name,
        })
      }
      setPlan(primary)
      setLinkedBackupPlan(backup)
    } catch {
      for (const pending of [backup, primary]) {
        if (pending?.status !== 'awaiting_approval') continue
        try { await cancel(pending.runId) } catch { /* keep the original planning error */ }
      }
    } finally {
      setBusy(false)
    }
  }

  const start = async () => {
    if (!plan) return
    setBusy(true)
    try {
      await Promise.all([
        approve(plan.runId),
        ...(linkedBackupPlan ? [approve(linkedBackupPlan.runId)] : []),
      ])
      await onChanged()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell
      title={`Migrar ${source.name}`}
      onClose={() => { void close() }}
      footer={plan ? (
        <>
          <button className="btn ghost" type="button" disabled={busy} onClick={() => { void close() }}>Cancelar migración</button>
          <button className="btn primary" type="button" disabled={busy} onClick={() => { void start() }}>
            <Icon name="sync" size={13} /> {busy ? 'Iniciando…' : 'Transferir y verificar'}
          </button>
        </>
      ) : (
        <>
          <button className="btn ghost" type="button" disabled={busy} onClick={onClose}>Cerrar</button>
          <button className="btn primary" type="button" disabled={busy || !canPlan} onClick={() => { void buildPlan() }}>
            <Icon name="search" size={13} /> {busy ? 'Inventariando…' : 'Preparar preview'}
          </button>
        </>
      )}
    >
      {plan ? (
        <div className="migration-combined-plan">
          <MigrationPlanReview run={plan} />
          {linkedBackupPlan && (
            <section>
              <h3>Backup asociado</h3>
              <p className="modal-copy">Se relocalizará en la misma operación y conservará su relación con {targetName.trim() || source.name}.</p>
              <MigrationPlanReview run={linkedBackupPlan} />
            </section>
          )}
        </div>
      ) : (
        <div className="migration-wizard">
          {source.role === 'library' && (
            <div className="migration-mode-choice" role="group" aria-label="Modo de migración">
              <button className={migrationMode === 'relocate' ? 'selected' : ''} type="button" onClick={() => setMigrationMode('relocate')}>
                <Icon name="sync" size={16} /><span><strong>Relocalizar</strong><small>Mantiene IDs y mueve la biblioteca a una raíz nueva.</small></span>
              </button>
              <button className={migrationMode === 'merge' ? 'selected' : ''} type="button" disabled={libraries.length === 0} onClick={() => setMigrationMode('merge')}>
                <Icon name="library" size={16} /><span><strong>Fusionar</strong><small>Incorpora esta biblioteca dentro de otra registrada.</small></span>
              </button>
            </div>
          )}

          <label className="migration-field">
            <span>Nombre visible al terminar</span>
            <input className="settings-input" value={targetName} onChange={event => setTargetName(event.target.value)} />
          </label>

          {migrationMode === 'merge' ? (
            <div className="migration-field">
              <span>Biblioteca destino</span>
              <div className="migration-library-options">
                {libraries.map(location => (
                  <button className={targetFolderId === location.id ? 'selected' : ''} type="button" key={location.id} onClick={() => setTargetFolderId(location.id)}>
                    <Icon name={location.provider === 'onedrive' ? 'cloud' : 'folder'} size={14} />
                    <span><strong>{location.name}</strong><small>{location.path}</small></span>
                    {targetFolderId === location.id && <Icon name="check" size={13} />}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="migration-field">
              <span>Nueva raíz</span>
              <NewRootPicker choice={root} onChange={setRoot} />
              {source.role === 'backup' && <small>La relación con la biblioteca base se conserva y el snapshot se reasocia a la raíz verificada.</small>}
              {source.role === 'library' && sourceBackup && (
                <div className="migration-linked-backup">
                  <label>
                    <input
                      type="checkbox"
                      checked={migrateLinkedBackup}
                      onChange={event => setMigrateLinkedBackup(event.target.checked)}
                    />
                    Relocalizar también el backup “{sourceBackup.name}”
                  </label>
                  {migrateLinkedBackup ? (
                    <NewRootPicker choice={linkedBackupRoot} onChange={setLinkedBackupRoot} />
                  ) : (
                    <small>El backup actual se mantiene vinculado en su ubicación existente.</small>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="migration-field">
            <span>Original después del commit</span>
            <div className="migration-radio-row">
              <label><input type="radio" checked={sourceDisposition === 'keep'} onChange={() => setSourceDisposition('keep')} /> Conservar original</label>
              <label title={protectedRoot ? 'No se puede enviar una raíz de volumen o drive a la papelera' : undefined}>
                <input type="radio" disabled={protectedRoot} checked={sourceDisposition === 'trash'} onChange={() => setSourceDisposition('trash')} /> Enviar a la papelera
              </label>
            </div>
          </div>

          {migrationMode === 'merge' && target && (
            <div className="migration-field">
              <span>Backup de la biblioteca unificada</span>
              <select className="settings-select" value={backupChoice} onChange={event => setBackupChoice(event.target.value)}>
                <option value="none">Continuar sin backup</option>
                {targetBackup && <option value={`existing:${targetBackup.id}`}>Reutilizar {targetBackup.name}</option>}
                {sourceBackup && <option value={`existing:${sourceBackup.id}`}>Reutilizar {sourceBackup.name}</option>}
                <option value="new">Elegir uno nuevo</option>
              </select>
              {backupChoice === 'new' && <NewRootPicker choice={newBackupRoot} onChange={setNewBackupRoot} />}
            </div>
          )}

          {storeError && <div className="loc-inline-error" role="alert"><Icon name="info" size={13} /> {storeError}</div>}
        </div>
      )}
    </ModalShell>
  )
}

export function MigrationReviewDialog({
  run,
  onClose,
}: {
  run: LibraryMigrationState
  onClose: () => void
}) {
  const approve = useMigrationStore(state => state.approve)
  const cancel = useMigrationStore(state => state.cancel)
  const [busy, setBusy] = useState(false)
  const start = async () => {
    setBusy(true)
    try { await approve(run.runId); onClose() } finally { setBusy(false) }
  }
  const discard = async () => {
    setBusy(true)
    try { await cancel(run.runId); onClose() } finally { setBusy(false) }
  }
  return (
    <ModalShell
      title="Revisar migración"
      onClose={onClose}
      footer={(
        <>
          <button className="btn ghost" type="button" disabled={busy} onClick={() => { void discard() }}>Cancelar migración</button>
          <button className="btn primary" type="button" disabled={busy} onClick={() => { void start() }}><Icon name="sync" size={13} /> Iniciar</button>
        </>
      )}
    >
      <MigrationPlanReview run={run} />
    </ModalShell>
  )
}
