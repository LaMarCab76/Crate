import { useEffect, useMemo, useRef, useState } from 'react'
import type { InterfaceNode, InterfacePackage } from '@shared/types/interfaces'
import { validateInterfacePackage } from '@shared/interfaces/validation'
import { ModalShell } from '@renderer/components/ModalShell'
import { DeclarativeInterface } from './DeclarativeInterface'
import { CONTAINERS, NODE_TYPES, findNode, makeNode, moveNode, newId, pushHistory, readBriefs, readDrafts, removeNode, removeScreen, reparentNode, updateNode, writeBrief, writeDraft } from './model'
import { useInterfaceStore } from './interfaceStore'

const LABELS: Record<string, string> = { row: 'Fila', column: 'Columna', grid: 'Grilla', panel: 'Panel', tabs: 'Pestañas', stack: 'Capas', text: 'Texto', button: 'Botón', search: 'Búsqueda', tracks: 'Canciones', albums: 'Álbumes', artists: 'Artistas', player: 'Reproductor', queue: 'Cola', lyrics: 'Letras', 'host-view': 'Pantalla de Crate', spacer: 'Espacio' }
const PROP_FIELDS: { key: string; label: string; type?: 'number' }[] = [
  { key: 'text', label: 'Texto' }, { key: 'title', label: 'Título' }, { key: 'target', label: 'Destino' },
  { key: 'gap', label: 'Separación', type: 'number' }, { key: 'padding', label: 'Margen interno', type: 'number' },
  { key: 'width', label: 'Ancho fijo (px)', type: 'number' }, { key: 'height', label: 'Alto fijo (px)', type: 'number' },
  { key: 'minWidth', label: 'Ancho mínimo', type: 'number' }, { key: 'columns', label: 'Columnas', type: 'number' },
  { key: 'fontSize', label: 'Tamaño de texto', type: 'number' }, { key: 'fontWeight', label: 'Peso de texto', type: 'number' },
  { key: 'radius', label: 'Radio', type: 'number' }, { key: 'limit', label: 'Resultados por página', type: 'number' },
  { key: 'color', label: 'Color de texto' }, { key: 'background', label: 'Fondo' }, { key: 'emptyText', label: 'Estado vacío' },
]

function ComponentTree({ node, selected, onSelect, depth = 0 }: { node: InterfaceNode; selected?: string; onSelect: (id: string) => void; depth?: number }) {
  return <><button type="button" className={`if-tree-item${selected === node.id ? ' is-selected' : ''}`} style={{ paddingLeft: 10 + depth * 14 }} onClick={() => onSelect(node.id)}><span aria-hidden="true">{CONTAINERS.has(node.type) ? '▤' : '·'}</span> {LABELS[node.type] ?? node.type}<small>{String(node.props?.text ?? node.props?.title ?? '').slice(0, 24)}</small></button>{node.children?.map(child => <ComponentTree key={child.id} node={child} selected={selected} onSelect={onSelect} depth={depth + 1} />)}</>
}

export function InterfaceEditor({ initialPackage, onClose, onSaved }: { initialPackage: InterfacePackage; onClose: () => void; onSaved?: () => void }) {
  const [pkg, setPackage] = useState<InterfacePackage>(() => {
    const draft = readDrafts(window.localStorage)[initialPackage.manifest.id]
    return draft ?? structuredClone(initialPackage)
  })
  const [screenId, setScreenId] = useState(pkg.manifest.screens?.[0]?.id)
  const [selected, setSelected] = useState(pkg.manifest.screens?.[0]?.root.id)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [previewMode, setPreviewMode] = useState(false)
  const [canvasWidth, setCanvasWidth] = useState('100%')
  const [previewState, setPreviewState] = useState<'ready' | 'empty' | 'loading' | 'error'>('ready')
  const [componentType, setComponentType] = useState<string>('text')
  const [fileIndex, setFileIndex] = useState(0)
  const [json, setJson] = useState<string | null>(null)
  const [brief, setBrief] = useState(() => readBriefs(window.localStorage)[initialPackage.manifest.id] ?? 'Objetivo:\nReferencias visuales:\nPantallas y navegación:\nComponentes nuevos:\nColores y tipografía:\nVentana mínima: 900 × 600\nCarga, vacío y error:\nAccesibilidad y teclado:\nCriterios de aceptación:\n')
  const undo = useRef<InterfacePackage[]>([])
  const redo = useRef<InterfacePackage[]>([])
  const [, historyVersion] = useState(0)
  const latest = useRef(pkg)
  latest.current = pkg
  const latestBrief = useRef(brief)
  latestBrief.current = brief
  const screens = pkg.manifest.screens ?? []
  const screen = screens.find(item => item.id === screenId) ?? screens[0]
  const node = screen && selected ? findNode(screen.root, selected) : undefined
  const containers = useMemo(() => {
    const items: InterfaceNode[] = []
    const walk = (item: InterfaceNode) => { if (CONTAINERS.has(item.type)) items.push(item); item.children?.forEach(walk) }
    if (screen) walk(screen.root)
    return items
  }, [screen])

  function change(next: InterfacePackage) {
    undo.current = pushHistory(undo.current, pkg)
    redo.current = []
    setPackage(next)
    setMessage(null)
  }
  function history(direction: 'undo' | 'redo') {
    const source = direction === 'undo' ? undo : redo
    const dest = direction === 'undo' ? redo : undo
    const previous = source.current.pop()
    if (!previous) return
    dest.current = pushHistory(dest.current, pkg)
    setPackage(previous)
    historyVersion(value => value + 1)
  }
  function manifest(changeManifest: Partial<InterfacePackage['manifest']>) { change({ ...pkg, manifest: { ...pkg.manifest, ...changeManifest } }) }
  function root(next: InterfaceNode) { manifest({ screens: screens.map(item => item.id === screen?.id ? { ...item, root: next } : item) }) }
  function property(key: string, value: string | number | boolean | undefined) {
    if (!node || !screen) return
    root(updateNode(screen.root, node.id, item => {
      const props = { ...item.props }
      if (value === undefined) delete props[key]
      else props[key] = value
      return { ...item, props }
    }))
  }
  function closeEditor() {
    try { writeDraft(window.localStorage, latest.current); writeBrief(window.localStorage, pkg.manifest.id, brief) } catch { /* autoguardado ya informa el error; la revisión instalada sigue disponible */ }
    onClose()
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try { writeDraft(window.localStorage, pkg) }
      catch (error) { setMessage(`No se pudo autoguardar: ${String(error)}`) }
    }, 350)
    return () => window.clearTimeout(timer)
  }, [pkg])
  useEffect(() => {
    const timer = window.setTimeout(() => { try { writeBrief(window.localStorage, pkg.manifest.id, brief) } catch (error) { setMessage(`No se pudieron autoguardar las instrucciones: ${String(error)}`) } }, 350)
    return () => window.clearTimeout(timer)
  }, [brief, pkg.manifest.id])
  useEffect(() => () => { try { writeDraft(window.localStorage, latest.current); writeBrief(window.localStorage, latest.current.manifest.id, latestBrief.current) } catch { /* displayed on next save */ } }, [])

  async function save(activate = false) {
    setBusy(true)
    try {
      const valid = validateInterfacePackage(pkg)
      const saved = await useInterfaceStore.getState().save(valid)
      if (activate) await useInterfaceStore.getState().activate(saved.manifest.id, saved.revision)
      setMessage(activate ? 'Interfaz instalada y activada en prueba. Confirmá con Conservar.' : 'Revisión instalada. Tu borrador sigue disponible.')
      onSaved?.()
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const addComponent = () => {
    if (!screen) return
    const item = makeNode(componentType)
    const parent = node && CONTAINERS.has(node.type) ? node : screen.root
    if (!CONTAINERS.has(parent.type)) { setMessage('La raíz debe ser una fila, columna, grilla o panel para agregar componentes.'); return }
    root(updateNode(screen.root, parent.id, current => ({ ...current, children: [...(current.children ?? []), item] })))
    setSelected(item.id)
  }
  const addScreen = () => {
    const id = newId('screen')
    const screen = { id, title: `Pantalla ${screens.length + 1}`, root: makeNode('column') }
    manifest({ screens: [...screens, screen], navigation: [...(pkg.manifest.navigation ?? []), { id: newId('nav'), label: screen.title, screenId: id }] })
    setScreenId(id); setSelected(screen.root.id)
  }

  return <ModalShell title={`Editor de interfaces · ${pkg.manifest.name || 'Borrador sin nombre'}`} onClose={closeEditor} footer={<><span className="if-muted">Borrador local · hasta 50 pasos de historial</span><button type="button" className="if-button" disabled={busy} onClick={() => void save()}>Instalar revisión</button><button type="button" className="if-button if-primary" disabled={busy} onClick={() => void save(true)}>{busy ? 'Guardando…' : 'Instalar y probar'}</button></>}>
    <div className="if-editor" onKeyDown={event => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      event.preventDefault(); history(event.shiftKey ? 'redo' : 'undo')
    }}>
      <div className="if-editor-toolbar"><button type="button" className="if-button" disabled={!undo.current.length} onClick={() => history('undo')}>↶ Deshacer</button><button type="button" className="if-button" disabled={!redo.current.length} onClick={() => history('redo')}>↷ Rehacer</button><button type="button" className="if-button" onClick={() => setJson(JSON.stringify(pkg, null, 2))}>Editar paquete JSON</button><button type="button" className="if-button" onClick={() => setPreviewMode(value => !value)}>{previewMode ? 'Seleccionar componentes' : 'Probar navegación'}</button><label className="if-inline-label">Estado <select value={previewState} onChange={event => setPreviewState(event.target.value as typeof previewState)}><option value="ready">Con música</option><option value="empty">Vacío</option><option value="loading">Cargando</option><option value="error">Error</option></select></label><label className="if-inline-label">Lienzo <select value={canvasWidth} onChange={event => setCanvasWidth(event.target.value)}><option value="100%">Ajustar</option><option value="900px">900 px</option><option value="1280px">1280 px</option><option value="480px">480 px</option></select></label></div>
      {message && <div className="if-notice" role="status">{message}</div>}
      <div className="if-editor-layout">
        <aside className="if-editor-tree">
          <h3>Pantallas</h3>
          {screens.map((item, index) => <div className="if-screen-row" key={item.id}><button type="button" className={`if-tree-item${item.id === screen?.id ? ' is-selected' : ''}`} onClick={() => { setScreenId(item.id); setSelected(item.root.id) }}>{item.title}</button><button type="button" className="if-small-button" aria-label={`Subir ${item.title}`} disabled={index === 0} onClick={() => { const next = [...screens]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; manifest({ screens: next }) }}>↑</button></div>)}
          {pkg.manifest.kind === 'declarative' && <button type="button" className="if-button" disabled={screens.length >= 32} onClick={addScreen}>+ Pantalla</button>}
          <h3>Componentes</h3>
          {screen && <ComponentTree node={screen.root} selected={selected} onSelect={setSelected} />}
          {pkg.manifest.kind === 'declarative' && <div className="if-add-component"><select aria-label="Tipo de componente" value={componentType} onChange={event => setComponentType(event.target.value)}>{NODE_TYPES.map(type => <option key={type} value={type}>{LABELS[type]}</option>)}</select><button type="button" className="if-button" onClick={addComponent}>+ Agregar</button></div>}
          <h3>Navegación</h3>
          {(pkg.manifest.navigation ?? []).map((item, index, items) => <div className="if-navigation-item" key={item.id}><input aria-label={`Etiqueta de navegación ${index + 1}`} value={item.label} onChange={event => manifest({ navigation: items.map(current => current.id === item.id ? { ...current, label: event.target.value } : current) })} /><select aria-label={`Pantalla de navegación ${index + 1}`} value={item.screenId} onChange={event => manifest({ navigation: items.map(current => current.id === item.id ? { ...current, screenId: event.target.value } : current) })}>{screens.map(screen => <option key={screen.id} value={screen.id}>{screen.title}</option>)}</select><div className="if-button-row"><button type="button" className="if-small-button" disabled={index === 0} aria-label={`Subir navegación ${index + 1}`} onClick={() => { const next = [...items]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; manifest({ navigation: next }) }}>↑</button><button type="button" className="if-small-button" aria-label={`Eliminar navegación ${index + 1}`} onClick={() => manifest({ navigation: items.filter(current => current.id !== item.id) })}>Eliminar</button></div></div>)}
          {screen && <button type="button" className="if-button" onClick={() => manifest({ navigation: [...(pkg.manifest.navigation ?? []), { id: newId('nav'), label: screen.title, screenId: screen.id }] })}>+ Enlace a esta pantalla</button>}
        </aside>
        <main className="if-editor-canvas"><div className="if-canvas-label">{pkg.manifest.kind === 'code' ? 'Código del paquete' : `${previewMode ? 'Vista previa interactiva' : 'Seleccioná un componente'} · datos de muestra`}</div>
          {pkg.manifest.kind === 'declarative' ? <div className="if-canvas-size" style={{ width: canvasWidth }}><DeclarativeInterface manifest={pkg.manifest} preview previewState={previewState} screenId={screen?.id} onScreenChange={id => { setScreenId(id); setSelected(screens.find(item => item.id === id)?.root.id) }} selectedNodeId={previewMode ? undefined : selected} onSelectNode={previewMode ? undefined : setSelected} /></div> : <div className="if-code-editor"><p>Las pantallas programadas se ejecutan en un entorno aislado al probar la revisión. Su código no se transforma automáticamente en un árbol visual.</p><div className="if-button-row"><select aria-label="Archivo del paquete" value={fileIndex} onChange={event => setFileIndex(Number(event.target.value))}>{pkg.files?.map((file, i) => <option key={file.path} value={i}>{file.path}</option>)}</select><button type="button" className="if-button" onClick={() => { const files = [...(pkg.files ?? []), { path: `component-${Date.now()}.js`, content: '// Nuevo componente\n', encoding: 'utf8' as const }]; change({ ...pkg, files }); setFileIndex(files.length - 1) }}>+ Archivo</button></div>{pkg.files?.[fileIndex] && <><label className="if-field">Ruta<input value={pkg.files[fileIndex].path} onChange={event => change({ ...pkg, files: pkg.files?.map((file, i) => i === fileIndex ? { ...file, path: event.target.value } : file) })} /></label>{pkg.files[fileIndex].encoding === 'utf8' ? <textarea className="if-source-editor" aria-label={`Código de ${pkg.files[fileIndex].path}`} spellCheck={false} value={pkg.files[fileIndex].content} onChange={event => change({ ...pkg, files: pkg.files?.map((file, i) => i === fileIndex ? { ...file, content: event.target.value } : file) })} /> : <p>Recurso binario. Reemplazalo mediante el paquete JSON o importá una nueva revisión.</p>}</>}</div>}
        </main>
        <aside className="if-editor-inspector">
          <h3>Interfaz</h3><label className="if-field">Nombre<input value={pkg.manifest.name} onChange={event => manifest({ name: event.target.value })} /></label><label className="if-field">Versión<input value={pkg.manifest.version} onChange={event => manifest({ version: event.target.value })} placeholder="1.0.0" /></label><label className="if-field">Base<select value={pkg.manifest.base} onChange={event => manifest({ base: event.target.value as 'glass' | 'classic' })}><option value="glass">Glass</option><option value="classic">Clásica</option></select></label>
          <details><summary>Colores y tipografía</summary>{[['background', 'Fondo'], ['surface', 'Paneles'], ['text', 'Texto'], ['muted', 'Texto secundario'], ['accent', 'Acento'], ['font-family', 'Familia tipográfica']].map(([key, label]) => <label className="if-field" key={key}>{label}<input placeholder={key === 'font-family' ? 'Helvetica, sans-serif' : '#253548'} value={pkg.manifest.theme?.[key] ?? ''} onChange={event => { const theme = { ...pkg.manifest.theme }; if (event.target.value) theme[key] = event.target.value; else delete theme[key]; manifest({ theme }) }} /></label>)}</details>
          {screen && <><h3>Pantalla</h3><label className="if-field">Título<input value={screen.title} onChange={event => manifest({ screens: screens.map(item => item.id === screen.id ? { ...item, title: event.target.value } : item) })} /></label><button type="button" className="if-button" disabled={screens.length < 2} onClick={() => { change({ ...pkg, manifest: removeScreen(pkg.manifest, screen.id) }); setScreenId(screens.find(item => item.id !== screen.id)?.id) }}>Eliminar pantalla</button></>}
          {node && screen && <><h3>{LABELS[node.type] ?? node.type}</h3><div className="if-button-row"><button className="if-small-button" type="button" disabled={node.id === screen.root.id} onClick={() => root(moveNode(screen.root, node.id, -1))}>↑ Subir</button><button className="if-small-button" type="button" disabled={node.id === screen.root.id} onClick={() => root(moveNode(screen.root, node.id, 1))}>↓ Bajar</button><button className="if-small-button" type="button" disabled={node.id === screen.root.id} onClick={() => { root(removeNode(screen.root, node.id)); setSelected(screen.root.id) }}>Eliminar</button></div><label className="if-field">Mover a<select value="" disabled={node.id === screen.root.id} onChange={event => root(reparentNode(screen.root, node.id, event.target.value))}><option value="">Elegí un contenedor…</option>{containers.filter(item => !findNode(node, item.id)).map(item => <option key={item.id} value={item.id}>{LABELS[item.type]} · {item.id.slice(-6)}</option>)}</select></label>
          {PROP_FIELDS.filter(field => !['text', 'target', 'columns', 'limit', 'emptyText'].includes(field.key) || field.key === 'text' && ['button', 'text'].includes(node.type) || field.key === 'target' && ['button', 'host-view'].includes(node.type) || field.key === 'columns' && node.type === 'grid' || ['limit', 'emptyText'].includes(field.key) && ['tracks', 'queue', 'albums', 'artists'].includes(node.type)).map(field => <label className="if-field" key={`${node.id}-${field.key}`}>{field.label}<input type={field.type ?? 'text'} value={String(node.props?.[field.key] ?? '')} onChange={event => property(field.key, event.target.value === '' ? undefined : field.type === 'number' ? Number(event.target.value) : event.target.value)} /></label>)}
          {node.type === 'button' && <label className="if-field">Acción<select value={String(node.props?.action ?? 'navigate')} onChange={event => property('action', event.target.value)}><option value="navigate">Navegar</option><option value="togglePlay">Reproducir / pausar</option><option value="next">Siguiente</option><option value="previous">Anterior</option></select><small>Destino: library, albums, artists, settings, devices o screen:ID.</small></label>}
          {node.type === 'tracks' && <label className="if-field">Datos<select value={String(node.props?.data ?? 'library')} onChange={event => property('data', event.target.value)}><option value="library">Biblioteca</option><option value="favorites">Favoritos</option></select></label>}
          <label className="if-field">Alineación<select value={String(node.props?.align ?? 'stretch')} onChange={event => property('align', event.target.value)}>{['stretch', 'start', 'center', 'end'].map(value => <option key={value}>{value}</option>)}</select></label><label className="if-field">Distribución<select value={String(node.props?.justify ?? 'start')} onChange={event => property('justify', event.target.value)}>{['start', 'center', 'end', 'space-between', 'space-around'].map(value => <option key={value}>{value}</option>)}</select></label><label className="if-check"><input type="checkbox" checked={Boolean(node.props?.hideBelow)} onChange={event => property('hideBelow', event.target.checked ? 640 : undefined)} />Ocultar en lienzos menores a 640 px</label><label className="if-check"><input type="checkbox" checked={Boolean(node.props?.compact)} onChange={event => property('compact', event.target.checked)} />Presentación compacta</label></>}
          <details className="if-brief"><summary>Crear con instrucciones</summary><p>Completá este brief y pedile a tu desarrollador o IA que use el SDK de Crate documentado en docs/interfaces.md. Importá el paquete generado para probarlo.</p><textarea aria-label="Requisitos de diseño" value={brief} onChange={event => setBrief(event.target.value)} /><button type="button" className="if-button" onClick={() => void navigator.clipboard.writeText(`${brief}\nEntrega: paquete JSON .crate-interface schemaVersion 1. Usar el SDK y ejemplos de docs/interfaces.md. No acceder a window.api ni Node. Incluir estados vacíos, carga, errores y teclado.\n`).then(() => setMessage('Requisitos copiados.')).catch(() => setMessage('No se pudo copiar. Seleccioná y copiá el texto del brief.'))}>Copiar instrucciones</button></details>
        </aside>
      </div>
      {json !== null && <div className="if-json-panel"><h3>Paquete JSON</h3><p>Los cambios se validan antes de aplicarse al borrador.</p><textarea aria-label="JSON del paquete de interfaz" spellCheck={false} value={json} onChange={event => setJson(event.target.value)} /><div className="if-button-row"><button type="button" className="if-button" onClick={() => setJson(null)}>Cancelar</button><button type="button" className="if-button if-primary" onClick={() => { try { const valid = validateInterfacePackage(JSON.parse(json)); if (valid.manifest.id !== pkg.manifest.id) throw new Error('Conservá el ID del borrador. Para otro ID, importá el paquete.'); change(valid); setJson(null) } catch (error) { setMessage(String(error)) } }}>Validar y aplicar</button></div></div>}
    </div>
  </ModalShell>
}
