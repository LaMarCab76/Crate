import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InstalledInterface, InterfacePackage, InterfaceSelection } from '../../../shared/types/interfaces'
import { assertInterfaceId, assertInterfaceRevision, builtinInterfacePackages, MAX_INTERFACE_BYTES, validateInterfacePackage } from '../../../shared/interfaces/validation'

interface StoredRevision extends InstalledInterface { package: InterfacePackage }
const DEFAULT_ID = 'crate-glass'
const MAX_STORED_BYTES = 128 * 1024 * 1024

/** File-only persistence, independent of Electron so recovery can be tested directly. */
export class InterfaceRepository {
  private selection: InterfaceSelection
  private readonly revisionsPath: string
  private readonly selectionPath: string
  private readonly builtins = builtinInterfacePackages()

  constructor(private readonly directory: string) {
    this.revisionsPath = join(directory, 'revisions')
    this.selectionPath = join(directory, 'selection.json')
    mkdirSync(this.revisionsPath, { recursive: true })
    this.selection = this.restoreSelection()
  }

  private atomicWrite(path: string, value: unknown): void {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      renameSync(temporary, path)
    } finally { rmSync(temporary, { force: true }) }
  }

  private restoreSelection(): InterfaceSelection {
    if (!existsSync(this.selectionPath)) return { activeId: DEFAULT_ID, trial: false }
    try {
      if (statSync(this.selectionPath).size > 4096) throw new Error('Oversized selection')
      const persisted = JSON.parse(readFileSync(this.selectionPath, 'utf8')) as InterfaceSelection
      assertInterfaceId(persisted.activeId)
      if (persisted.activeRevision) assertInterfaceRevision(persisted.activeRevision)
      if (persisted.trial) {
        this.selection = persisted
        return this.revert('The previous interface was not confirmed before Crate closed.')
      }
      this.read(persisted.activeId, persisted.activeRevision)
      return { activeId: persisted.activeId, activeRevision: persisted.activeRevision, trial: false }
    } catch {
      const restored = { activeId: DEFAULT_ID, trial: false, reason: 'Crate restored its included interface because the saved selection was unavailable.' }
      this.atomicWrite(this.selectionPath, restored)
      return restored
    }
  }

  list(): InstalledInterface[] {
    const items: InstalledInterface[] = this.builtins.map(pkg => ({ manifest: pkg.manifest, revision: 'builtin', installedAt: '' }))
    for (const id of readdirSync(this.revisionsPath)) {
      if (!/^[a-z][a-z0-9-]{1,79}$/.test(id)) continue
      const location = join(this.revisionsPath, id)
      if (!statSync(location).isDirectory()) continue
      for (const file of readdirSync(location)) {
        if (!/^[a-f0-9]{32}\.json$/.test(file)) continue
        try {
          const revision = this.readStored(id, file.slice(0, -5))
          items.push({ manifest: revision.manifest, revision: revision.revision, installedAt: revision.installedAt })
        } catch { /* Incomplete/corrupt revisions remain available for manual recovery; never activate them. */ }
      }
    }
    return items.sort((a, b) => {
      if (a.revision === 'builtin' && b.revision !== 'builtin') return -1
      if (b.revision === 'builtin' && a.revision !== 'builtin') return 1
      return b.installedAt.localeCompare(a.installedAt) || a.manifest.name.localeCompare(b.manifest.name)
    })
  }

  private readStored(id: string, revision: string): StoredRevision {
    assertInterfaceId(id)
    assertInterfaceRevision(revision)
    const path = join(this.revisionsPath, id, `${revision}.json`)
    // StoredRevision includes the display manifest as well as the complete
    // package. A valid manifest-heavy package can therefore occupy nearly
    // twice the public package limit; validateInterfacePackage below still
    // enforces the original 16 MiB limit on its authoritative package.
    if (statSync(path).size > MAX_INTERFACE_BYTES * 2 + 100_000) throw new Error('Stored interface is too large')
    const stored = JSON.parse(readFileSync(path, 'utf8')) as StoredRevision
    const pkg = validateInterfacePackage(stored.package)
    if (pkg.manifest.id !== id || stored.revision !== revision || this.digest(pkg) !== revision) throw new Error('Interface revision integrity check failed')
    if (typeof stored.installedAt !== 'string') throw new Error('Invalid installation timestamp')
    return { manifest: pkg.manifest, revision, installedAt: stored.installedAt, package: pkg }
  }

  read(id: string, revision?: string): InterfacePackage {
    assertInterfaceId(id)
    const builtin = this.builtins.find(pkg => pkg.manifest.id === id)
    if (builtin) return structuredClone(builtin)
    const resolved = revision ?? this.list().find(item => item.manifest.id === id)?.revision
    if (!resolved) throw new Error('Interface is not installed')
    return this.readStored(id, resolved).package
  }

  private digest(pkg: InterfacePackage): string {
    return createHash('sha256').update(JSON.stringify(pkg)).digest('hex').slice(0, 32)
  }

  save(input: unknown): InstalledInterface {
    const pkg = validateInterfacePackage(input)
    if (this.builtins.some(builtin => builtin.manifest.id === pkg.manifest.id)) throw new Error('Duplicate an included interface before editing it')
    const revision = this.digest(pkg)
    const directory = join(this.revisionsPath, pkg.manifest.id)
    const path = join(directory, `${revision}.json`)
    if (existsSync(path)) {
      const existing = this.readStored(pkg.manifest.id, revision)
      return { manifest: existing.manifest, revision, installedAt: existing.installedAt }
    }
    let storedBytes = 0
    let latestTimestamp = 0
    for (const item of this.list()) {
      if (item.revision !== 'builtin') storedBytes += statSync(join(this.revisionsPath, item.manifest.id, `${item.revision}.json`)).size
      if (item.manifest.id === pkg.manifest.id) latestTimestamp = Math.max(latestTimestamp, Date.parse(item.installedAt) || 0)
    }
    const stored: StoredRevision = { package: pkg, manifest: pkg.manifest, revision, installedAt: new Date(Math.max(Date.now(), latestTimestamp + 1)).toISOString() }
    if (storedBytes + Buffer.byteLength(JSON.stringify(stored)) > MAX_STORED_BYTES) throw new Error('Interface storage exceeds 128 MiB. Export and remove unused interfaces first.')
    mkdirSync(directory, { recursive: true })
    this.atomicWrite(path, stored)
    return { manifest: pkg.manifest, revision, installedAt: stored.installedAt }
  }

  getSelection(): InterfaceSelection { return { ...this.selection } }

  activate(id: string, revision?: string): InterfaceSelection {
    const pkg = this.read(id, revision)
    const builtin = this.builtins.some(item => item.manifest.id === id)
    const resolved = builtin ? undefined : revision ?? this.list().find(item => item.manifest.id === id)?.revision
    if (this.selection.activeId === id && this.selection.activeRevision === resolved && !this.selection.trial) return this.getSelection()
    const previousId = this.selection.trial ? this.selection.previousId : this.selection.activeId
    const previousRevision = this.selection.trial ? this.selection.previousRevision : this.selection.activeRevision
    this.selection = { activeId: pkg.manifest.id, activeRevision: resolved, previousId, previousRevision, trial: !builtin }
    this.atomicWrite(this.selectionPath, this.selection)
    return this.getSelection()
  }

  confirm(): InterfaceSelection {
    this.selection = { activeId: this.selection.activeId, activeRevision: this.selection.activeRevision, trial: false }
    this.atomicWrite(this.selectionPath, this.selection)
    return this.getSelection()
  }

  revert(reason = 'The previous interface was restored.'): InterfaceSelection {
    let activeId = this.selection.previousId ?? DEFAULT_ID
    let activeRevision = this.selection.previousRevision
    try { this.read(activeId, activeRevision) } catch { activeId = DEFAULT_ID; activeRevision = undefined }
    this.selection = { activeId, activeRevision, trial: false, reason }
    this.atomicWrite(this.selectionPath, this.selection)
    return this.getSelection()
  }

  restoreIncluded(reason = 'The included interface was restored.'): InterfaceSelection {
    this.selection = { activeId: DEFAULT_ID, trial: false, reason }
    this.atomicWrite(this.selectionPath, this.selection)
    return this.getSelection()
  }

  remove(id: string): void {
    assertInterfaceId(id)
    if (this.builtins.some(item => item.manifest.id === id)) throw new Error('Included interfaces cannot be removed')
    if (this.selection.activeId === id || (this.selection.trial && this.selection.previousId === id)) throw new Error('Switch to another interface and confirm it before removing this one')
    rmSync(join(this.revisionsPath, id), { recursive: true, force: true })
  }
}
