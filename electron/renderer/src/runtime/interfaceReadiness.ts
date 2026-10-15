interface InterfaceLibraryState {
  loaded: boolean
  error: string | null
  refresh(): Promise<void>
}

/** A guest may query before the host has finished its first library load. */
export async function readyInterfaceLibrary<T extends InterfaceLibraryState>(read: () => T): Promise<T> {
  const initial = read()
  if (initial.loaded) return initial
  // refresh() shares the store's in-flight load. Read again after awaiting it;
  // the initial Zustand snapshot still contains the empty startup collection.
  await initial.refresh()
  const current = read()
  if (!current.loaded) throw new Error(current.error ?? 'La biblioteca todavía no está disponible. Volvé a intentar.')
  return current
}
