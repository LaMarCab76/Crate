import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('./DownloadManager.ts', import.meta.url), 'utf8')
const importSource = readFileSync(new URL('../library/ImportService.ts', import.meta.url), 'utf8')

test('downloads revalidate their current DB destination at publish and import boundaries', () => {
  assert.match(
    source,
    /verifyDownloadedFile\(partPath[\s\S]*?requireCurrentDownloadDestination\(jobId, job\.folderId, finalPath\)[\s\S]*?link\(partPath, finalPath\)/,
  )
  assert.match(
    source,
    /updateStatus\(jobId, 'importing'\)[\s\S]*?requireCurrentDownloadDestination\(jobId, job\.folderId, finalPath\)[\s\S]*?importFile\(importJob\.folderId!, finalPath\)/,
  )
  assert.match(
    source,
    /private async importExistingIfNeeded[\s\S]*?requireCurrentDownloadDestination[\s\S]*?getImportService\(\)\.importFile/,
  )
  assert.match(
    importSource,
    /const md = await readTrackMetadata\(filePath\)[\s\S]*?requireImportFileAuthority\(expectedFolder, filePath\)[\s\S]*?tracks\.insert\(row\)/,
  )
  assert.match(
    source,
    /let publishedPath[\s\S]*?publishedPath = finalPath[\s\S]*?!this\.isJobPathAllowed\(job, publishedPath\)[\s\S]*?unlink\(publishedPath\)/,
  )
})
