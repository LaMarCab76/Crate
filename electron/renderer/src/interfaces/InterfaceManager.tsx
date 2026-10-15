import { useEffect, useState } from 'react'
import type { InstalledInterface, InterfacePackage } from '@shared/types/interfaces'
import { ModalShell } from '@renderer/components/ModalShell'
import { Icon } from '@renderer/components/Icon'
import { InterfaceEditor } from './InterfaceEditor'
import { DeclarativeInterface } from './DeclarativeInterface'
import { createInterface, duplicatePackage, readDrafts } from './model'
import { initializeInterfaceStore, useInterfaceStore } from './interfaceStore'
import './interfaces.css'

function builtinComposition(item: InstalledInterface): InterfacePackage {
  const pkg = createInterface(item.manifest.base)
  const classic = item.manifest.base === 'classic'
  pkg.manifest.name = `${item.manifest.name} — personal`
  pkg.manifest.description = `Composición editable inspirada en ${item.manifest.name}.`
  pkg.manifest.screens = [{ id: 'home', title: 'Colección', root: {
    id: 'home-root', type: classic ? 'row' : 'column', props: { gap: 24, padding: 24 }, children: classic ? [
      { id: 'sidebar', type: 'column', props: { width: 220, gap: 12 }, children: [
        { id: 'heading', type: 'text', props: { text: 'Mi colección', fontSize: 26 } },
        ...[['library', 'Canciones'], ['albums', 'Álbumes'], ['artists', 'Artistas'], ['settings', 'Preferencias']].map(([target, text]) => ({ id: `nav-${target}`, type: 'button', props: { action: 'navigate', target, text } })),
        { id: 'player', type: 'player', props: { compact: true } },
      ] },
      { id: 'collection', type: 'column', props: { gap: 20 }, children: [{ id: 'search', type: 'search' }, { id: 'tracks', type: 'tracks', props: { title: 'Canciones', limit: 30 } }] },
    ] : [
      { id: 'heading', type: 'text', props: { text: 'Tu música, en primer plano', fontSize: 32 } },
      { id: 'player', type: 'player' }, { id: 'search', type: 'search' }, { id: 'albums', type: 'albums', props: { title: 'Álbumes', minWidth: 140 } },
    ],
  } }]
  pkg.manifest.navigation = [{ id: 'home-nav', label: 'Colección', screenId: 'home' }]
  return pkg
}

function Miniature({ base, custom = false }: { base: string; custom?: boolean }) {
  return <div className={`if-miniature if-miniature-${base}${custom ? ' if-miniature-custom' : ''}`} aria-hidden="true"><div className="if-mini-sidebar"><i /><i /><i /><i /></div><div className="if-mini-content"><div className="if-mini-toolbar" /><div className="if-mini-albums"><i /><i /><i /></div><div className="if-mini-lines"><i /><i /><i /></div></div><div className="if-mini-player"><i /><span>◀　▶　▶</span></div>{custom && <div className="if-mini-custom-badge">{custom ? 'TU DISEÑO' : ''}</div>}</div>
}

export function InterfaceManager() {
  const installed = useInterfaceStore(s => s.installed)
  const selection = useInterfaceStore(s => s.selection)
  const loading = useInterfaceStore(s => s.loading)
  const error = useInterfaceStore(s => s.error)
  const [editing, setEditing] = useState<InterfacePackage | null>(null)
  const [preview, setPreview] = useState<InterfacePackage | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [versions, setVersions] = useState<Record<string, string>>({})
  const [drafts, setDrafts] = useState(() => readDrafts(window.localStorage))
  const [inspecting, setInspecting] = useState<InstalledInterface | null>(null)
  useEffect(() => initializeInterfaceStore(), [])
  const groups = new Map<string, InstalledInterface[]>()
  for (const item of installed) groups.set(item.manifest.id, [...(groups.get(item.manifest.id) ?? []), item])
  const cards = [...groups.values()].map(items => ({ items: items.sort((a, b) => b.installedAt.localeCompare(a.installedAt)), selected: items.find(item => item.revision === versions[item.manifest.id]) ?? items[0] }))

  async function run(job: () => Promise<unknown>, success?: string) {
    setBusy(true); setNotice(null)
    try { await job(); if (success) setNotice(success) }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const isBuiltin = (id: string) => id === 'crate-glass' || id === 'crate-classic'
  async function open(item: InstalledInterface, duplicate: boolean) {
    const pkg = isBuiltin(item.manifest.id) ? builtinComposition(item) : await window.api.interfaces.read(item.manifest.id, item.revision)
    setEditing(duplicate && !isBuiltin(item.manifest.id) ? duplicatePackage(pkg) : pkg)
  }

  return <section className="if-manager" aria-label="Interfaces de Crate">
    <div className="if-manager-heading"><div><h3>Interfaz</h3><p>Elegí una composición completa o creá la tuya. La reproducción y tu colección siguen en el mismo lugar.</p></div><div className="if-button-row"><button type="button" className="if-button" disabled={busy} onClick={() => void run(async () => { const item = await useInterfaceStore.getState().importPackage(); if (item) { setInspecting(item); setNotice('Paquete importado. Revisá sus capacidades y probalo antes de conservarlo.') } })}><Icon name="upload" size={14} /> Importar</button><button type="button" className="if-button if-primary" disabled={busy} onClick={() => setEditing(createInterface())}><Icon name="plus" size={14} /> Crear interfaz</button></div></div>
    {(error || notice) && <div className="if-notice" role="status">{notice ?? error}</div>}
    {loading && <p role="status" className="if-muted">Cargando interfaces…</p>}
    <div className="if-gallery">{cards.map(({ items, selected: item }) => {
      const id = item.manifest.id
      const builtin = isBuiltin(id)
      const active = selection.activeId === id && (!selection.activeRevision || selection.activeRevision === item.revision)
      return <article className={`if-card${active ? ' is-active' : ''}`} key={id}><Miniature base={item.manifest.base} custom={!builtin} /><div className="if-card-body"><div className="if-card-title"><h4>{item.manifest.name}</h4>{active && <span className="if-badge">{selection.trial ? 'En prueba' : 'Activa'}</span>}</div><p>{item.manifest.description ?? (builtin ? item.manifest.base === 'classic' ? 'El diseño anterior, con navegación y paneles clásicos.' : 'El diseño actual, con paneles flotantes y superficies Glass.' : 'Interfaz personal de Crate.')}</p><div className="if-card-meta"><span>{builtin ? 'Incluida en Crate' : item.manifest.kind === 'code' ? 'Código aislado' : 'Editor visual'}</span><span>v{item.manifest.version}</span></div>{items.length > 1 && <label className="if-field">Revisión<select value={item.revision} onChange={event => setVersions(previous => ({ ...previous, [id]: event.target.value }))}>{items.map(revision => <option key={revision.revision} value={revision.revision}>v{revision.manifest.version} · {new Date(revision.installedAt).toLocaleString()} · {revision.revision.slice(0, 6)}</option>)}</select></label>}<div className="if-button-row"><button type="button" className="if-button if-primary" disabled={busy || active} onClick={() => builtin ? void run(() => useInterfaceStore.getState().activate(id, item.revision)) : setInspecting(item)}>{active ? 'Seleccionada' : builtin ? 'Usar diseño' : 'Probar diseño'}</button>{!builtin && item.manifest.kind === 'declarative' && <button type="button" className="if-button" disabled={busy} onClick={() => void run(async () => setPreview(await window.api.interfaces.read(id, item.revision)))}>Vista previa</button>}<button type="button" className="if-button" disabled={busy} onClick={() => void run(() => open(item, builtin))}>{builtin ? 'Crear una copia' : 'Editar'}</button></div>{!builtin && <div className="if-button-row if-card-secondary"><button type="button" className="if-link-button" disabled={busy} onClick={() => void run(() => open(item, true))}>Duplicar</button><button type="button" className="if-link-button" disabled={busy} onClick={() => void run(() => useInterfaceStore.getState().exportPackage(id, item.revision))}>Exportar</button><button type="button" className="if-link-button" disabled={busy || selection.activeId === id} onClick={() => setRemoveId(id)}>Eliminar</button></div>}</div></article>
    })}</div>
    {Object.keys(drafts).length > 0 && <details className="if-drafts"><summary>Borradores recuperables ({Object.keys(drafts).length})</summary><p>Se guardan localmente al editar, aunque cierres el editor antes de instalar.</p>{Object.values(drafts).map(pkg => <div className="if-draft-row" key={pkg.manifest.id}><span>{pkg.manifest.name}</span><button type="button" className="if-button" onClick={() => setEditing(pkg)}>Continuar</button></div>)}</details>}
    <details className="if-help"><summary>Crear con instrucciones o componentes programados</summary><p>El editor permite componer pantallas y navegación con los componentes de Crate. Para crear componentes nuevos, un desarrollador o una IA puede entregar un paquete programable con HTML, CSS y JavaScript.</p><p>En el editor, abrí «Crear con instrucciones» para copiar un brief con tus requisitos. El contrato, los métodos del SDK y ejemplos importables están en <code>docs/interfaces.md</code> y <code>examples/interfaces/</code>.</p><p>Al importar, revisás las capacidades solicitadas y activás una prueba reversible. Las interfaces de código conservan su propio código fuente y no se convierten automáticamente al editor visual.</p></details>
    {editing && <InterfaceEditor key={editing.manifest.id} initialPackage={editing} onClose={() => { setEditing(null); setDrafts(readDrafts(window.localStorage)) }} onSaved={() => { void useInterfaceStore.getState().refresh(); setDrafts(readDrafts(window.localStorage)) }} />}
    {preview && <ModalShell title={`Vista previa · ${preview.manifest.name}`} onClose={() => setPreview(null)} footer={<button type="button" className="if-button" onClick={() => setPreview(null)}>Cerrar vista previa</button>}><div className="if-package-preview"><p className="if-muted">Datos de muestra. Los controles no modifican el audio ni tu biblioteca.</p><DeclarativeInterface manifest={preview.manifest} preview /></div></ModalShell>}
    {inspecting && <ModalShell title={`Probar ${inspecting.manifest.name}`} onClose={() => setInspecting(null)} footer={<><button type="button" className="if-button" onClick={() => setInspecting(null)}>Cancelar</button><button type="button" className="if-button if-primary" disabled={busy} onClick={() => void run(async () => { await useInterfaceStore.getState().activate(inspecting.manifest.id, inspecting.revision); setInspecting(null) })}>Activar en prueba</button></>}><div className="if-permissions"><p>{inspecting.manifest.description}</p><p>Esta interfaz solicita:</p><ul>{inspecting.manifest.capabilities.map(capability => <li key={capability}>{({ 'library.read': 'Consultar canciones, álbumes y artistas.', 'playback.control': 'Controlar reproducción, posición y volumen.', 'queue.control': 'Modificar la cola de reproducción.', navigation: 'Abrir pantallas de Crate.' } as Record<string, string>)[capability] ?? capability}</li>)}</ul>{inspecting.manifest.kind === 'code' && <p>Incluye código programado que se ejecutará en un entorno aislado al activar la prueba.</p>}<p>Tenés 60 segundos para usar Conservar y confirmar el diseño. Usá Revertir para regresar de inmediato. Si la prueba falla o reiniciás sin confirmar, Crate recupera la interfaz anterior.</p></div></ModalShell>}
    {removeId && <ModalShell title="Eliminar interfaz" onClose={() => setRemoveId(null)} footer={<><button type="button" className="if-button" onClick={() => setRemoveId(null)}>Cancelar</button><button type="button" className="if-button" disabled={busy} onClick={() => void run(async () => { await useInterfaceStore.getState().remove(removeId); setRemoveId(null) })}>Eliminar revisiones instaladas</button></>}><p>Se eliminarán todas las revisiones instaladas de esta interfaz. El borrador local se conserva.</p></ModalShell>}
  </section>
}
