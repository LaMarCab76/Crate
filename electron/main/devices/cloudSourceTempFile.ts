import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sanitizeSegment } from './cloudDeviceRelativePath.ts'

export interface CloudSourceMaterialization {
  sizeBytes: number
  filename: string
  dateModified: string | null
  downloadInto: (buffer: Buffer) => Promise<void>
  tempRoot?: string
}

/** Materializes a cloud object through a bounded caller-sized RAM buffer and keeps
 * its temporary directory alive only for the duration of the callback. */
export async function withCloudSourceTempFile<T>(
  source: CloudSourceMaterialization,
  run: (localPath: string) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 0) {
    throw new Error(`Invalid cloud source size: ${source.sizeBytes}`)
  }

  const buffer = Buffer.allocUnsafe(source.sizeBytes)
  await source.downloadInto(buffer)

  const tempDir = await mkdtemp(join(source.tempRoot ?? tmpdir(), 'crate-device-cloud-'))
  const safeFilename = sanitizeSegment(source.filename) || 'track'
  const tempPath = join(tempDir, safeFilename)
  try {
    await writeFile(tempPath, buffer, { flag: 'wx' })
    const modified = source.dateModified ? Date.parse(source.dateModified) : Number.NaN
    if (Number.isFinite(modified)) {
      const date = new Date(modified)
      await utimes(tempPath, date, date)
    }
    const info = await stat(tempPath)
    if (info.size !== source.sizeBytes) throw new Error('Cloud temporary file size does not match download')
    return await run(tempPath)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}
