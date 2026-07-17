import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { transferResponseToPart } from './DownloadTransfer.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'crate-download-transfer-'))
}

test('pipeline writes a complete response and reports byte-truth progress', async () => {
  const dir = tempDir()
  const partPath = join(dir, 'job.part')
  try {
    const seen: Array<[number, number | null]> = []
    const response = new Response(Buffer.from('audio-bytes'), {
      headers: { 'Content-Length': '11' },
    })
    const received = await transferResponseToPart({
      response,
      partPath,
      signal: new AbortController().signal,
      providerBytesTotal: 11,
      onProgress: (bytes, total) => seen.push([bytes, total]),
    })

    assert.equal(received, 11)
    assert.equal(readFileSync(partPath, 'utf8'), 'audio-bytes')
    assert.deepEqual(seen.at(-1), [11, 11])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pipeline removes the part file when the response stream errors early', async () => {
  const dir = tempDir()
  const partPath = join(dir, 'job.part')
  try {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.error(new Error('source stream failed'))
      },
    })
    const response = new Response(body)

    await assert.rejects(
      transferResponseToPart({
        response,
        partPath,
        signal: new AbortController().signal,
        providerBytesTotal: null,
      }),
      /source stream failed/,
    )
    assert.equal(existsSync(partPath), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('truncated Content-Length responses fail and leave no part file', async () => {
  const dir = tempDir()
  const partPath = join(dir, 'job.part')
  try {
    const response = new Response(Buffer.from('short'), {
      headers: { 'Content-Length': '12' },
    })

    await assert.rejects(
      transferResponseToPart({
        response,
        partPath,
        signal: new AbortController().signal,
        providerBytesTotal: null,
      }),
      /truncated/,
    )
    assert.equal(existsSync(partPath), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
