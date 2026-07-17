import type { LibraryProvider } from '@shared/types/library-locations'
import type {
  MirrorDivergence,
  MirrorEntry,
  MirrorPlan,
  MirrorPlannedAction,
  MirrorSnapshotEntry,
} from './types.ts'

function entryMap(entries: readonly MirrorEntry[]): Map<string, MirrorEntry> {
  return new Map(entries.map(entry => [entry.relativePath, entry]))
}

function snapshotMap(entries: readonly MirrorSnapshotEntry[]): Map<string, MirrorSnapshotEntry> {
  return new Map(entries.map(entry => [entry.relativePath, entry]))
}

export function entriesHaveSameContent(
  left: MirrorEntry | null | undefined,
  right: MirrorEntry | null | undefined,
  sourceProvider: LibraryProvider,
  backupProvider: LibraryProvider,
): boolean {
  if (!left || !right) return left === right
  if (left.kind !== right.kind) return false
  if (left.kind === 'directory') return true
  if (left.size !== right.size) return false
  if (sourceProvider === 'local' && backupProvider === 'local') {
    return left.sha256 !== null && right.sha256 !== null && left.sha256 === right.sha256
  }
  return left.quickXorHash !== null
    && right.quickXorHash !== null
    && left.quickXorHash === right.quickXorHash
}

function depth(path: string): number {
  return path.split('/').length
}

function actionForDifference(source: MirrorEntry | undefined, destination: MirrorEntry | undefined): MirrorPlannedAction[] {
  if (!source && !destination) return []
  if (!source && destination) {
    return [{
      kind: destination.kind === 'directory' ? 'delete_directory' : 'delete_file',
      relativePath: destination.relativePath,
      source: null,
      destinationBefore: destination,
      bytesTotal: 0,
      phase: destination.kind === 'directory' ? 4 : 3,
      requiresApproval: false,
    }]
  }
  if (!source) return []
  if (!destination) {
    return [{
      kind: source.kind === 'directory' ? 'create_directory' : 'copy_file',
      relativePath: source.relativePath,
      source,
      destinationBefore: null,
      bytesTotal: source.kind === 'file' ? source.size : 0,
      phase: source.kind === 'directory' ? 1 : 2,
      requiresApproval: false,
    }]
  }
  if (source.kind === 'directory' && destination.kind === 'file') {
    return [
      { kind: 'delete_file', relativePath: destination.relativePath, source: null, destinationBefore: destination, bytesTotal: 0, phase: 0, requiresApproval: false },
      { kind: 'create_directory', relativePath: source.relativePath, source, destinationBefore: null, bytesTotal: 0, phase: 1, requiresApproval: false },
    ]
  }
  if (source.kind === 'file' && destination.kind === 'directory') {
    return [
      { kind: 'delete_directory', relativePath: destination.relativePath, source: null, destinationBefore: destination, bytesTotal: 0, phase: 0, requiresApproval: false },
      { kind: 'copy_file', relativePath: source.relativePath, source, destinationBefore: null, bytesTotal: source.size, phase: 2, requiresApproval: false },
    ]
  }
  if (source.kind === 'file') {
    return [{
      kind: 'copy_file',
      relativePath: source.relativePath,
      source,
      destinationBefore: destination,
      bytesTotal: source.size,
      phase: 2,
      requiresApproval: false,
    }]
  }
  return []
}

function compareActions(left: MirrorPlannedAction, right: MirrorPlannedAction): number {
  if (left.phase !== right.phase) return left.phase - right.phase
  if (left.phase === 1) return depth(left.relativePath) - depth(right.relativePath) || left.relativePath.localeCompare(right.relativePath)
  if (left.phase === 4 || left.phase === 0) {
    return depth(right.relativePath) - depth(left.relativePath) || right.relativePath.localeCompare(left.relativePath)
  }
  return left.relativePath.localeCompare(right.relativePath)
}

export function planMirror(args: {
  source: readonly MirrorEntry[]
  destination: readonly MirrorEntry[]
  snapshot: readonly MirrorSnapshotEntry[]
  hasBaseline?: boolean
  sourceProvider: LibraryProvider
  backupProvider: LibraryProvider
}): MirrorPlan {
  const source = entryMap(args.source)
  const destination = entryMap(args.destination)
  const snapshot = snapshotMap(args.snapshot)
  const paths = [...new Set([...source.keys(), ...destination.keys(), ...snapshot.keys()])].sort()
  const divergences: MirrorDivergence[] = []
  const actions: MirrorPlannedAction[] = []

  const hasBaseline = args.hasBaseline ?? snapshot.size > 0
  if (!hasBaseline && destination.size > 0) {
    divergences.push({
      relativePath: '*',
      reason: 'initial_destination_not_empty',
      source: null,
      destination: null,
      previous: null,
    })
  }

  for (const path of paths) {
    const sourceEntry = source.get(path)
    const destinationEntry = destination.get(path)
    const previous = snapshot.get(path)
    const sourceEqualsDestination = entriesHaveSameContent(
      sourceEntry,
      destinationEntry,
      args.sourceProvider,
      args.backupProvider,
    )
    const destinationEqualsPrevious = entriesHaveSameContent(
      destinationEntry,
      previous,
      args.sourceProvider,
      args.backupProvider,
    )

    if (hasBaseline && !destinationEqualsPrevious && !sourceEqualsDestination) {
      divergences.push({
        relativePath: path,
        reason: !previous && destinationEntry
          ? 'destination_added'
          : previous && !destinationEntry
            ? 'destination_deleted'
            : 'destination_modified',
        source: sourceEntry ?? null,
        destination: destinationEntry ?? null,
        previous: previous ?? null,
      })
    }

    if (!sourceEqualsDestination) actions.push(...actionForDifference(sourceEntry, destinationEntry))
  }

  const requiresApproval = divergences.length > 0
  // Replacing a destination directory with a source file necessarily removes
  // that subtree before the file can be published. Pull every descendant
  // deletion into the same guarded pre-copy phase and order deepest-first;
  // adapters still refuse to remove a non-empty directory, so a late foreign
  // child pauses the run instead of being deleted recursively.
  const structuralDirectoryDeletes = actions
    .filter(action => action.phase === 0 && action.kind === 'delete_directory')
    .map(action => action.relativePath)
  return {
    actions: actions
      .map(action => ({
        ...action,
        phase: structuralDirectoryDeletes.some(root => action.relativePath.startsWith(`${root}/`))
          && (action.kind === 'delete_file' || action.kind === 'delete_directory')
          ? 0 as const
          : action.phase,
        requiresApproval,
      }))
      .sort(compareActions),
    divergences,
  }
}
