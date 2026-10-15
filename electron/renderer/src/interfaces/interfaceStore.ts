import { create } from 'zustand'
import type { InstalledInterface, InterfacePackage, InterfaceSelection } from '@shared/types/interfaces'

interface InterfaceState {
  loaded: boolean
  loading: boolean
  error: string | null
  installed: InstalledInterface[]
  selection: InterfaceSelection
  activePackage: InterfacePackage | null
  load(): Promise<void>
  refresh(): Promise<void>
  activate(id: string, revision?: string): Promise<void>
  confirm(): Promise<void>
  revert(): Promise<void>
  save(pkg: InterfacePackage): Promise<InstalledInterface>
  importPackage(): Promise<InstalledInterface | null>
  exportPackage(id: string, revision?: string): Promise<boolean>
  remove(id: string): Promise<void>
  clearError(): void
}

let selectionGeneration = 0
let loadPromise: Promise<void> | null = null
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

async function receiveSelection(selection: InterfaceSelection): Promise<void> {
  const previous = useInterfaceStore.getState()
  if (previous.activePackage && previous.selection.activeId === selection.activeId && previous.selection.activeRevision === selection.activeRevision) {
    // Confirming a provisional selection changes recovery metadata only. Keep
    // the mounted interface, its screen, focus and scroll position intact.
    useInterfaceStore.setState({ selection, error: null })
    return
  }
  const generation = ++selectionGeneration
  useInterfaceStore.setState({ selection, activePackage: null, error: null })
  try {
    const pkg = await window.api.interfaces.read(selection.activeId, selection.activeRevision)
    if (selectionGeneration === generation) useInterfaceStore.setState({ activePackage: pkg })
  } catch (error) {
    if (selectionGeneration === generation) useInterfaceStore.setState({ error: message(error) })
  }
}

export const useInterfaceStore = create<InterfaceState>((set, get) => ({
  loaded: false, loading: false, error: null, installed: [], activePackage: null,
  selection: { activeId: 'crate-glass', trial: false },
  async load() {
    if (loadPromise) return loadPromise
    set({ loading: true })
    loadPromise = (async () => {
      const generation = selectionGeneration
      try {
        const [installed, selection] = await Promise.all([window.api.interfaces.list(), window.api.interfaces.getSelection()])
        set({ installed, loaded: true, error: null })
        if (generation === selectionGeneration) await receiveSelection(selection)
      } catch (error) { set({ error: message(error) }) }
      finally { set({ loading: false }) }
    })()
    try { await loadPromise } finally { loadPromise = null }
  },
  async refresh() {
    try { set({ installed: await window.api.interfaces.list(), error: null }) }
    catch (error) { set({ error: message(error) }); throw error }
  },
  async activate(id, revision) {
    try { await receiveSelection(await window.api.interfaces.activate(id, revision)) }
    catch (error) { set({ error: message(error) }); throw error }
  },
  async confirm() {
    try { await receiveSelection(await window.api.interfaces.confirm()) }
    catch (error) { set({ error: message(error) }); throw error }
  },
  async revert() {
    try { await receiveSelection(await window.api.interfaces.revert()) }
    catch (error) { set({ error: message(error) }); throw error }
  },
  async save(pkg) {
    const result = await window.api.interfaces.save(pkg)
    await get().refresh()
    return result
  },
  async importPackage() {
    const result = await window.api.interfaces.importPackage()
    if (result) await get().refresh()
    return result
  },
  exportPackage: (id, revision) => window.api.interfaces.exportPackage(id, revision),
  async remove(id) { await window.api.interfaces.remove(id); await get().refresh() },
  clearError: () => set({ error: null }),
}))

let listener: (() => void) | null = null
let consumers = 0
/** Ref-counted: App and the preferences gallery can share one subscription. */
export function initializeInterfaceStore(): () => void {
  consumers++
  if (!listener && window.api?.interfaces) {
    listener = window.api.interfaces.onSelectionChanged(selection => { void receiveSelection(selection) })
    void useInterfaceStore.getState().load()
  }
  let released = false
  return () => {
    if (released) return
    released = true
    consumers--
    if (consumers === 0) { listener?.(); listener = null }
  }
}
