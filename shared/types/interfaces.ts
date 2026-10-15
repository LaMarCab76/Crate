/** Public, versioned interface SDK. Imported code never receives window.api. */
export const INTERFACE_CAPABILITIES = ['library.read', 'playback.control', 'queue.control', 'navigation'] as const
export type InterfaceCapability = typeof INTERFACE_CAPABILITIES[number]
export const BUILTIN_INTERFACE_IDS = ['crate-glass', 'crate-classic'] as const

export interface InterfaceNode {
  id: string
  type: string
  props?: Record<string, string | number | boolean>
  children?: InterfaceNode[]
}

export interface InterfaceScreen {
  id: string
  title: string
  root: InterfaceNode
}

export interface InterfaceManifest {
  schemaVersion: 1
  id: string
  name: string
  version: string
  description?: string
  kind: 'declarative' | 'code'
  base: 'glass' | 'classic'
  capabilities: string[]
  theme?: Record<string, string>
  screens?: InterfaceScreen[]
  navigation?: { id: string; label: string; screenId: string }[]
  entry?: string
}

export interface InterfacePackage {
  manifest: InterfaceManifest
  files?: { path: string; content: string; encoding: 'utf8' | 'base64' }[]
}

export interface InstalledInterface {
  manifest: InterfaceManifest
  revision: string
  installedAt: string
}

export interface InterfaceSelection {
  activeId: string
  activeRevision?: string
  previousId?: string
  previousRevision?: string
  trial: boolean
  reason?: string
}

export interface InterfaceGuestRequest {
  requestId: string
  method: string
  params?: unknown
}

export interface InterfaceGuestResponse {
  requestId: string
  result?: unknown
  error?: string
}

export interface InterfacesApi {
  list(): Promise<InstalledInterface[]>
  read(id: string, revision?: string): Promise<InterfacePackage>
  save(pkg: InterfacePackage): Promise<InstalledInterface>
  importPackage(): Promise<InstalledInterface | null>
  exportPackage(id: string, revision?: string): Promise<boolean>
  remove(id: string): Promise<void>
  getSelection(): Promise<InterfaceSelection>
  activate(id: string, revision?: string): Promise<InterfaceSelection>
  confirm(): Promise<InterfaceSelection>
  revert(): Promise<InterfaceSelection>
  onSelectionChanged(handler: (selection: InterfaceSelection) => void): () => void
  setGuestVisible(visible: boolean): Promise<void>
  setChrome(base: 'glass' | 'classic'): Promise<void>
  onRequest(handler: (request: InterfaceGuestRequest) => void): () => void
  respond(response: InterfaceGuestResponse): Promise<void>
  updateGuestState(snapshot: unknown): Promise<void>
}

export interface CrateInterfaceSdk {
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  onState(handler: (snapshot: unknown) => void): () => void
}

declare global {
  interface Window {
    crateInterface: CrateInterfaceSdk
  }
}
