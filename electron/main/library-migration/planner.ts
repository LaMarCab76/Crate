import { extname, posix } from 'node:path'
import type { LibraryProvider } from '@shared/types/library-locations'
import { entriesHaveSameContent } from '../library-mirror/planner.ts'
import type { MirrorEntry, MirrorInventory } from '../library-mirror/types.ts'

export interface PlannedMigrationEntry {
  kind: MirrorEntry['kind']
  sourceRelativePath: string
  destinationRelativePath: string
  source: MirrorEntry
  destinationBefore: MirrorEntry | null
  conflict: 'renamed' | 'identical' | null
  needsTransfer: boolean
}

export interface MigrationPlan {
  entries: PlannedMigrationEntry[]
  warnings: string[]
}

function depth(value: string): number {
  return value.split('/').length
}

function pathKey(value: string, provider: LibraryProvider): string {
  return provider === 'onedrive' || process.platform === 'darwin' || process.platform === 'win32'
    ? value.normalize('NFC').toLocaleLowerCase('en-US')
    : value.normalize('NFC')
}

function safeLabel(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').slice(0, 48) || 'biblioteca'
}

function renamedPath(
  original: string,
  kind: MirrorEntry['kind'],
  sourceName: string,
  occupied: Set<string>,
  provider: LibraryProvider,
): string {
  const parent = posix.dirname(original) === '.' ? '' : posix.dirname(original)
  const leaf = posix.basename(original)
  const suffix = kind === 'file' ? extname(leaf) : ''
  const stem = suffix ? leaf.slice(0, -suffix.length) : leaf
  const label = safeLabel(sourceName)
  let attempt = 1
  while (true) {
    const qualifier = attempt === 1 ? ` (desde ${label})` : ` (desde ${label} ${attempt})`
    const candidateLeaf = `${stem}${qualifier}${suffix}`
    const candidate = parent ? `${parent}/${candidateLeaf}` : candidateLeaf
    if (!occupied.has(pathKey(candidate, provider))) return candidate
    attempt += 1
  }
}

function warningLines(prefix: string, inventory: MirrorInventory): string[] {
  return inventory.warnings.map(warning => `${prefix}:${warning.relativePath}: ${warning.message}`)
}

/** Build a deterministic, non-destructive mapping. Existing identical files
 * deduplicate; different content receives a stable source-qualified name. */
export function planLibraryMigration(args: {
  source: MirrorInventory
  target: MirrorInventory
  sourceProvider: LibraryProvider
  targetProvider: LibraryProvider
  sourceName: string
  mode: 'relocate' | 'merge'
}): MigrationPlan {
  const targetByKey = new Map(
    args.target.entries.map(entry => [pathKey(entry.relativePath, args.targetProvider), entry]),
  )
  const occupied = new Set(targetByKey.keys())
  const directoryMappings = new Map<string, string>()
  const sourceEntries = args.source.entries
    .filter(entry => !(args.mode === 'merge' && entry.relativePath === '.crate/library.yaml'))
    .slice()
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
      if (left.kind === 'directory') return depth(left.relativePath) - depth(right.relativePath)
      return left.relativePath.localeCompare(right.relativePath)
    })

  const planned: PlannedMigrationEntry[] = []
  for (const source of sourceEntries) {
    const sourceParent = posix.dirname(source.relativePath)
    const mappedParent = sourceParent === '.' ? '' : directoryMappings.get(sourceParent) ?? sourceParent
    let destinationPath = mappedParent
      ? `${mappedParent}/${posix.basename(source.relativePath)}`
      : posix.basename(source.relativePath)
    let observed = targetByKey.get(pathKey(destinationPath, args.targetProvider)) ?? null
    let conflict: PlannedMigrationEntry['conflict'] = null
    let needsTransfer = observed == null

    if (observed) {
      const identical = entriesHaveSameContent(
        source,
        observed,
        args.sourceProvider,
        args.targetProvider,
      )
      if (identical) {
        conflict = source.kind === 'file' ? 'identical' : null
        needsTransfer = false
      } else {
        destinationPath = renamedPath(
          destinationPath,
          source.kind,
          args.sourceName,
          occupied,
          args.targetProvider,
        )
        observed = null
        conflict = 'renamed'
        needsTransfer = true
      }
    }

    occupied.add(pathKey(destinationPath, args.targetProvider))
    if (source.kind === 'directory') directoryMappings.set(source.relativePath, destinationPath)
    planned.push({
      kind: source.kind,
      sourceRelativePath: source.relativePath,
      destinationRelativePath: destinationPath,
      source,
      destinationBefore: observed,
      conflict,
      needsTransfer,
    })
  }

  return {
    entries: planned,
    warnings: [
      ...warningLines('source', args.source),
      ...warningLines('target', args.target),
    ],
  }
}
