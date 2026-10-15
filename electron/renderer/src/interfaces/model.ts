import type { InterfaceManifest, InterfaceNode, InterfacePackage } from '@shared/types/interfaces'
import { validateInterfacePackage } from '@shared/interfaces/validation'

export const NODE_TYPES = ['row', 'column', 'grid', 'panel', 'tabs', 'stack', 'text', 'button', 'search', 'tracks', 'albums', 'artists', 'player', 'queue', 'lyrics', 'host-view', 'spacer'] as const
export const CONTAINERS = new Set(['row', 'column', 'grid', 'panel', 'tabs', 'stack'])
export const DRAFT_KEY = 'crate.interfaces.drafts.v1'
export const BRIEF_KEY = 'crate.interfaces.briefs.v1'
export const MAX_DRAFT_BYTES = 2_000_000
export const MAX_BRIEF_BYTES = 64_000
export const MAX_HISTORY = 50
export const MAX_HISTORY_BYTES = 4_000_000

export function pushHistory(history: InterfacePackage[], pkg: InterfacePackage): InterfacePackage[] {
  const next = [...history.slice(-(MAX_HISTORY - 1)), pkg]
  let bytes = 0
  for (let index = next.length - 1; index >= 0; index--) {
    bytes += JSON.stringify(next[index]).length
    if (bytes > MAX_HISTORY_BYTES) return next.slice(index + 1)
  }
  return next
}

export function newId(prefix = 'node'): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

export function makeNode(type: string): InterfaceNode {
  return {
    id: newId(), type,
    props: type === 'text' ? { text: 'Tu música, a tu manera', fontSize: 28 } : type === 'button' ? { text: 'Biblioteca', action: 'navigate', target: 'library' } : type === 'host-view' ? { target: 'library' } : { gap: 16 },
    ...(CONTAINERS.has(type) ? { children: [] } : {}),
  }
}

export function createInterface(base: 'glass' | 'classic' = 'glass'): InterfacePackage {
  return {
    manifest: {
      schemaVersion: 1, id: newId('personal'), name: 'Mi interfaz', version: '1.0.0',
      description: 'Una composición propia de Crate.', kind: 'declarative', base,
      capabilities: ['library.read', 'playback.control', 'queue.control', 'navigation'],
      theme: {},
      screens: [{ id: 'home', title: 'Inicio', root: {
        id: newId(), type: 'column', props: { padding: 24, gap: 24 }, children: [
          { ...makeNode('text'), props: { text: 'Tu colección', fontSize: 32 } },
          makeNode('player'), makeNode('albums'),
        ],
      } }],
      navigation: [{ id: 'home-link', label: 'Inicio', screenId: 'home' }],
    },
  }
}

export function duplicatePackage(pkg: InterfacePackage, name = `${pkg.manifest.name} — copia`): InterfacePackage {
  return { ...structuredClone(pkg), manifest: { ...structuredClone(pkg.manifest), id: newId('personal'), name, version: '1.0.0' } }
}

export function findNode(root: InterfaceNode, id: string): InterfaceNode | undefined {
  if (root.id === id) return root
  for (const child of root.children ?? []) {
    const found = findNode(child, id)
    if (found) return found
  }
  return undefined
}

export function updateNode(root: InterfaceNode, id: string, change: (node: InterfaceNode) => InterfaceNode): InterfaceNode {
  if (root.id === id) return change(root)
  return { ...root, ...(root.children ? { children: root.children.map(child => updateNode(child, id, change)) } : {}) }
}

export function removeNode(root: InterfaceNode, id: string): InterfaceNode {
  return { ...root, ...(root.children ? { children: root.children.filter(child => child.id !== id).map(child => removeNode(child, id)) } : {}) }
}

export function moveNode(root: InterfaceNode, id: string, direction: -1 | 1): InterfaceNode {
  if (!root.children) return root
  const index = root.children.findIndex(child => child.id === id)
  if (index >= 0) {
    const next = index + direction
    if (next < 0 || next >= root.children.length) return root
    const children = [...root.children]
    ;[children[index], children[next]] = [children[next], children[index]]
    return { ...root, children }
  }
  return { ...root, children: root.children.map(child => moveNode(child, id, direction)) }
}

export function reparentNode(root: InterfaceNode, id: string, parentId: string): InterfaceNode {
  const item = findNode(root, id)
  const destination = findNode(root, parentId)
  if (!item || !destination || root.id === id || findNode(item, parentId) || !CONTAINERS.has(destination.type)) return root
  const pruned = removeNode(root, id)
  return updateNode(pruned, parentId, parent => ({ ...parent, children: [...(parent.children ?? []), item] }))
}

export function removeScreen(manifest: InterfaceManifest, id: string): InterfaceManifest {
  if ((manifest.screens?.length ?? 0) < 2) return manifest
  return { ...manifest, screens: manifest.screens?.filter(screen => screen.id !== id), navigation: manifest.navigation?.filter(item => item.screenId !== id) }
}

// Drafts are deliberately separate from installed revisions. Invalid or oversized
// local storage never prevents startup, and a draft cannot activate itself.
export function readDrafts(storage: Pick<Storage, 'getItem'>): Record<string, InterfacePackage> {
  try {
    const raw = storage.getItem(DRAFT_KEY)
    if (!raw || raw.length > MAX_DRAFT_BYTES) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: Record<string, InterfacePackage> = {}
    for (const [key, value] of Object.entries(parsed).slice(-20)) {
      if (!value || typeof value !== 'object') continue
      const pkg = value as InterfacePackage
      if (pkg.manifest?.schemaVersion !== 1 || pkg.manifest.id !== key || !['code', 'declarative'].includes(pkg.manifest.kind)) continue
      if (pkg.manifest.kind === 'declarative' && (!Array.isArray(pkg.manifest.screens) || !pkg.manifest.screens.every(screen => screen?.root && typeof screen.root.type === 'string'))) continue
      try {
        // A temporarily empty label or unfinished semver is a legitimate draft.
        // Validate its structure with placeholder form values, then retain the
        // original text so reopening does not silently discard unfinished work.
        const candidate = structuredClone(pkg)
        candidate.manifest.name = candidate.manifest.name || 'Borrador sin nombre'
        if (typeof candidate.manifest.version === 'string' && !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(candidate.manifest.version)) candidate.manifest.version = '0.0.0'
        candidate.manifest.screens = candidate.manifest.screens?.map(screen => ({ ...screen, title: screen.title || 'Pantalla' }))
        candidate.manifest.navigation = candidate.manifest.navigation?.map(item => ({ ...item, label: item.label || 'Enlace' }))
        validateInterfacePackage(candidate)
        result[key] = pkg
      } catch { /* damaged drafts do not enter the editor */ }
    }
    return result
  } catch { return {} }
}

export function writeDraft(storage: Pick<Storage, 'getItem' | 'setItem'>, pkg: InterfacePackage): void {
  const drafts = readDrafts(storage)
  delete drafts[pkg.manifest.id]
  drafts[pkg.manifest.id] = pkg
  const entries = Object.entries(drafts).slice(-20)
  let encoded = JSON.stringify(Object.fromEntries(entries))
  while (encoded.length > MAX_DRAFT_BYTES && entries.length > 1) {
    entries.shift()
    encoded = JSON.stringify(Object.fromEntries(entries))
  }
  if (encoded.length > MAX_DRAFT_BYTES) throw new Error('El borrador supera el límite de 2 MB. Exportá el paquete antes de seguir.')
  storage.setItem(DRAFT_KEY, encoded)
}

export function readBriefs(storage: Pick<Storage, 'getItem'>): Record<string, string> {
  try {
    const raw = storage.getItem(BRIEF_KEY)
    if (!raw || new TextEncoder().encode(raw).length > MAX_BRIEF_BYTES) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => /^[a-z][a-z0-9-]{1,79}$/.test(key) && typeof value === 'string').slice(-20))
  } catch { return {} }
}

export function writeBrief(storage: Pick<Storage, 'getItem' | 'setItem'>, id: string, brief: string): void {
  const briefs = readBriefs(storage)
  delete briefs[id]
  briefs[id] = brief
  const entries = Object.entries(briefs).slice(-20)
  let encoded = JSON.stringify(Object.fromEntries(entries))
  while (new TextEncoder().encode(encoded).length > MAX_BRIEF_BYTES && entries.length > 1) {
    entries.shift()
    encoded = JSON.stringify(Object.fromEntries(entries))
  }
  if (new TextEncoder().encode(encoded).length > MAX_BRIEF_BYTES) throw new Error('Las instrucciones superan el límite de 64 KB. Copiá el texto antes de cerrar.')
  storage.setItem(BRIEF_KEY, encoded)
}
