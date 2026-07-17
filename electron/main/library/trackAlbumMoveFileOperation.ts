import { randomUUID } from 'node:crypto'
import { constants as fsConstants, existsSync } from 'node:fs'
import { copyFile, mkdir, rename, rm, unlink } from 'node:fs/promises'
import { dirname, extname, join, parse } from 'node:path'

export function albumMoveSidecarPathFor(audioPath: string): string {
  const p = parse(audioPath)
  return join(dirname(audioPath), `${p.name}.lrc`)
}

export interface AlbumMoveReplacementStage {
  audioBackupPath: string
  sidecarBackupPath: string | null
  rollback(): Promise<void>
  retire(retireItem: (path: string) => Promise<void>): Promise<void>
}

// Temporarily moves an occupied destination out of the way on the same
// filesystem. The caller can restore it if metadata/files/DB fail, or retire it
// only after the new track and DB transaction have both committed.
export async function stageAlbumMoveReplacement(
  audioPath: string,
  id: () => string = randomUUID,
): Promise<AlbumMoveReplacementStage> {
  const sidecarPath = albumMoveSidecarPathFor(audioPath)
  const audioBackupPath = join(dirname(audioPath), `.${parse(audioPath).base}.crate-replaced-${id()}`)
  const sidecarBackupPath = existsSync(sidecarPath)
    ? join(dirname(sidecarPath), `.${parse(sidecarPath).base}.crate-replaced-${id()}`)
    : null
  let audioStaged = false
  let sidecarStaged = false

  try {
    await rename(audioPath, audioBackupPath)
    audioStaged = true
    if (sidecarBackupPath) {
      await rename(sidecarPath, sidecarBackupPath)
      sidecarStaged = true
    }
  } catch (err) {
    if (sidecarStaged && sidecarBackupPath && !existsSync(sidecarPath)) {
      await rename(sidecarBackupPath, sidecarPath).catch(() => undefined)
    }
    if (audioStaged && !existsSync(audioPath)) {
      await rename(audioBackupPath, audioPath).catch(() => undefined)
    }
    throw err
  }

  return {
    audioBackupPath,
    sidecarBackupPath,
    async rollback() {
      if (sidecarBackupPath && existsSync(sidecarBackupPath) && !existsSync(sidecarPath)) {
        await rename(sidecarBackupPath, sidecarPath)
      }
      if (existsSync(audioBackupPath) && !existsSync(audioPath)) {
        await rename(audioBackupPath, audioPath)
      }
    },
    async retire(retireItem) {
      await retireItem(audioBackupPath)
      if (sidecarBackupPath && existsSync(sidecarBackupPath)) await retireItem(sidecarBackupPath)
    },
  }
}

export async function applyAlbumMoveFileOperation(args: {
  sourcePath: string
  destinationPath: string
  writeTempMetadata: (tempPath: string) => void | Promise<void>
  afterFilesMoved?: () => void | Promise<void>
  id?: () => string
}): Promise<void> {
  const id = args.id ?? randomUUID
  const tempPath = join(dirname(args.destinationPath), `.crate-album-move-${id()}${extname(args.destinationPath) || '.tmp'}`)
  const oldAudioBackup = `${args.sourcePath}.crate-moving-${id()}`
  const oldSidecar = albumMoveSidecarPathFor(args.sourcePath)
  const newSidecar = albumMoveSidecarPathFor(args.destinationPath)
  const oldSidecarBackup = `${oldSidecar}.crate-moving-${id()}`
  let destinationWritten = false
  let sidecarWritten = false
  let oldAudioMoved = false
  let oldSidecarMoved = false

  try {
    await mkdir(dirname(args.destinationPath), { recursive: true })
    await copyFile(args.sourcePath, tempPath, fsConstants.COPYFILE_EXCL)
    await args.writeTempMetadata(tempPath)
    await copyFile(tempPath, args.destinationPath, fsConstants.COPYFILE_EXCL)
    destinationWritten = true

    if (existsSync(oldSidecar)) {
      await copyFile(oldSidecar, newSidecar, fsConstants.COPYFILE_EXCL)
      sidecarWritten = true
    }

    await rename(args.sourcePath, oldAudioBackup)
    oldAudioMoved = true
    if (existsSync(oldSidecar)) {
      await rename(oldSidecar, oldSidecarBackup)
      oldSidecarMoved = true
    }

    await args.afterFilesMoved?.()

    await unlink(oldAudioBackup).catch(err => {
      console.warn(`[album-move] could not remove old audio ${oldAudioBackup}:`, err instanceof Error ? err.message : String(err))
    })
    if (oldSidecarMoved) {
      await unlink(oldSidecarBackup).catch(err => {
        console.warn(`[album-move] could not remove old lyrics ${oldSidecarBackup}:`, err instanceof Error ? err.message : String(err))
      })
    }
    await unlink(tempPath).catch(() => undefined)
  } catch (err) {
    if (oldAudioMoved && !existsSync(args.sourcePath)) {
      await rename(oldAudioBackup, args.sourcePath).catch(() => undefined)
    }
    if (oldSidecarMoved && !existsSync(oldSidecar)) {
      await rename(oldSidecarBackup, oldSidecar).catch(() => undefined)
    }
    if (destinationWritten) await rm(args.destinationPath, { force: true }).catch(() => undefined)
    if (sidecarWritten) await rm(newSidecar, { force: true }).catch(() => undefined)
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw err
  }
}
