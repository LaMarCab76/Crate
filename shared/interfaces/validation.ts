import type { InterfaceManifest, InterfaceNode, InterfacePackage } from '../types/interfaces'
import { INTERFACE_CAPABILITIES } from '../types/interfaces'

export const MAX_INTERFACE_BYTES = 16 * 1024 * 1024
export const MAX_INTERFACE_FILES = 256
const IDENTIFIER = /^[a-z][a-z0-9-]{1,79}$/
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => FORBIDDEN_KEYS.has(key))) throw new Error(`${label} contains a reserved key`)
  return result
}

function text(value: unknown, label: string, maximum = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new Error(`${label} must contain 1–${maximum} characters`)
  }
  return value
}

export function assertInterfaceId(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error('Invalid interface identifier; use lowercase letters, numbers and hyphens')
  return value
}

export function assertInterfaceRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw new Error('Invalid interface revision')
  return value
}

export function assertInterfaceAssetPath(value: unknown): string {
  const path = text(value, 'Asset path', 240)
  if (path.startsWith('/') || path.includes('\\') || path.includes('%') || path.includes('?') || path.includes('#') || path.includes(':') || path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error(`Invalid interface asset path: ${path}`)
  }
  if (!/^[a-zA-Z0-9_./ -]+$/.test(path)) throw new Error(`Unsupported interface asset path: ${path}`)
  return path
}

export function validateInterfacePackage(input: unknown): InterfacePackage {
  let serialized: string
  try { serialized = JSON.stringify(input) } catch { throw new Error('Interface package must be serializable JSON') }
  if (!serialized || new TextEncoder().encode(serialized).length > MAX_INTERFACE_BYTES) throw new Error('Interface package exceeds the 16 MiB limit')
  const data = object(JSON.parse(serialized), 'Interface package')
  const manifest = object(data.manifest, 'Manifest')
  if (manifest.schemaVersion !== 1) throw new Error('This interface needs an unsupported schema version')
  assertInterfaceId(manifest.id)
  text(manifest.name, 'Interface name')
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)) throw new Error('Interface version must use major.minor.patch')
  if (manifest.description != null) text(manifest.description, 'Description', 2000)
  if (manifest.kind !== 'code' && manifest.kind !== 'declarative') throw new Error('Invalid interface kind')
  if (manifest.base !== 'glass' && manifest.base !== 'classic') throw new Error('Invalid base interface')
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length > INTERFACE_CAPABILITIES.length || manifest.capabilities.some(capability => !INTERFACE_CAPABILITIES.includes(capability as typeof INTERFACE_CAPABILITIES[number])) || new Set(manifest.capabilities).size !== manifest.capabilities.length) {
    throw new Error(`Unknown or duplicate capabilities; supported: ${INTERFACE_CAPABILITIES.join(', ')}`)
  }
  if (manifest.theme != null) {
    const tokens = object(manifest.theme, 'Theme')
    if (Object.keys(tokens).length > 64) throw new Error('Too many theme tokens')
    for (const [key, value] of Object.entries(tokens)) {
      if (!/^(?:--)?[a-z][a-zA-Z0-9-]{0,79}$/.test(key)) throw new Error(`Invalid theme token: ${key}`)
      if (typeof value !== 'string' || value.length > 160 || /[;{}<>]|url\s*\(|@import|expression\s*\(/i.test(value)) throw new Error(`Invalid theme value: ${key}`)
    }
  }
  const nodeIds = new Set<string>()
  let nodeCount = 0
  function node(value: unknown, depth: number): void {
    if (depth > 20 || ++nodeCount > 1000) throw new Error('Interface exceeds the component or nesting limit')
    const item = object(value, 'Component')
    const id = text(item.id, 'Component identifier', 100)
    if (nodeIds.has(id)) throw new Error(`Duplicate component identifier: ${id}`)
    nodeIds.add(id)
    if (typeof item.type !== 'string' || !/^[a-z][a-zA-Z0-9.-]{0,79}$/.test(item.type)) throw new Error('Invalid component type')
    if (item.props != null) {
      const props = object(item.props, 'Component properties')
      if (Object.keys(props).length > 64) throw new Error('Too many component properties')
      for (const [key, value] of Object.entries(props)) {
        if (key.length > 80 || !['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)) || (typeof value === 'string' && value.length > 5000)) throw new Error(`Invalid component property: ${key}`)
      }
    }
    if (item.children != null) {
      if (!Array.isArray(item.children) || item.children.length > 100) throw new Error('Invalid component children')
      item.children.forEach(child => node(child, depth + 1))
    }
  }
  const screenIds = new Set<string>()
  if (manifest.screens != null) {
    if (!Array.isArray(manifest.screens) || manifest.screens.length > 32) throw new Error('An interface supports at most 32 screens')
    for (const value of manifest.screens) {
      const screen = object(value, 'Screen')
      const id = text(screen.id, 'Screen identifier', 100)
      if (screenIds.has(id)) throw new Error(`Duplicate screen identifier: ${id}`)
      screenIds.add(id)
      text(screen.title, 'Screen title')
      node(screen.root, 0)
    }
  }
  if (manifest.navigation != null) {
    if (!Array.isArray(manifest.navigation) || manifest.navigation.length > 32) throw new Error('Invalid navigation')
    const ids = new Set<string>()
    for (const value of manifest.navigation) {
      const nav = object(value, 'Navigation item')
      const id = text(nav.id, 'Navigation identifier', 100)
      if (ids.has(id)) throw new Error(`Duplicate navigation identifier: ${id}`)
      ids.add(id)
      text(nav.label, 'Navigation label')
      if (!screenIds.has(String(nav.screenId))) throw new Error('Navigation references a missing screen')
    }
  }
  const files = data.files ?? []
  if (!Array.isArray(files) || files.length > MAX_INTERFACE_FILES) throw new Error(`An interface supports at most ${MAX_INTERFACE_FILES} files`)
  const paths = new Set<string>()
  for (const value of files) {
    const file = object(value, 'Asset')
    const path = assertInterfaceAssetPath(file.path)
    if (paths.has(path.toLowerCase())) throw new Error(`Duplicate asset path: ${path}`)
    paths.add(path.toLowerCase())
    if (file.encoding !== 'utf8' && file.encoding !== 'base64') throw new Error('Unsupported asset encoding')
    if (typeof file.content !== 'string') throw new Error('Asset content must be a string')
    if (file.encoding === 'base64' && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content))) throw new Error('Invalid base64 asset')
  }
  if (manifest.kind === 'code') {
    const entry = assertInterfaceAssetPath(manifest.entry)
    if (!entry.endsWith('.html') || !files.some(value => (value as { path: string }).path === entry)) throw new Error('A programmed interface requires an included HTML entry file')
  } else if (manifest.entry != null) {
    throw new Error('Declarative interfaces cannot execute an entry file')
  }
  return data as unknown as InterfacePackage
}

export function builtinInterfacePackages(): InterfacePackage[] {
  return [
    { manifest: { schemaVersion: 1, id: 'crate-glass', name: 'Crate Glass', version: '1.0.0', description: 'Floating glass toolbar and sidebar.', kind: 'declarative', base: 'glass', capabilities: [] } },
    { manifest: { schemaVersion: 1, id: 'crate-classic', name: 'Crate Classic', version: '1.0.0', description: 'The previous integrated toolbar, sidebar and player.', kind: 'declarative', base: 'classic', capabilities: [] } },
  ]
}

export type { InterfaceManifest, InterfaceNode }
