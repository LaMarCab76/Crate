import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

interface StatResult {
  isDirectory(): boolean
}

export type LocalTrashStat = (path: string) => Promise<StatResult>

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error != null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '') || null
    : null
}

/**
 * Signals whether a successful Trash call may already have moved the file even
 * though Crate could not prove the final storage state. Those cases must retain
 * a planned journal row so startup recovery can finish them safely.
 */
export class LocalTrashConfirmationError extends Error {
  readonly keepJournalPlanned: boolean

  constructor(message: string, keepJournalPlanned: boolean, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'LocalTrashConfirmationError'
    this.keepJournalPlanned = keepJournalPlanned
  }
}

function uncertain(message: string, cause?: unknown): LocalTrashConfirmationError {
  return new LocalTrashConfirmationError(message, true, cause)
}

/**
 * `shell.trashItem()` resolving is not itself proof that the source path
 * disappeared. Confirm both that the registered root is still available and
 * that the original audio path is absent before allowing the SQLite commit.
 */
export async function confirmLocalTrashAbsence(
  rootPath: string,
  audioPath: string,
  statPath: LocalTrashStat = stat,
): Promise<void> {
  const root = resolve(rootPath)
  const audio = resolve(audioPath)

  try {
    const rootResult = await statPath(root)
    if (!rootResult.isDirectory()) {
      throw uncertain('No se pudo confirmar la Papelera porque la raíz registrada ya no es una carpeta.')
    }
  } catch (error) {
    if (error instanceof LocalTrashConfirmationError) throw error
    throw uncertain(
      'La Papelera respondió, pero la biblioteca dejó de estar accesible antes de confirmar el resultado.',
      error,
    )
  }

  try {
    await statPath(audio)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw uncertain(
      'La Papelera respondió, pero no se pudo confirmar que el archivo original haya desaparecido.',
      error,
    )
  }

  throw new LocalTrashConfirmationError(
    'La Papelera informó éxito, pero el archivo original todavía existe. No se modificó el catálogo.',
    false,
  )
}
