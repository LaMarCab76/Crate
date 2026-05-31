import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseRockboxThemePreview } from './RockboxThemePreview.ts'

function tempRockbox() {
  const root = mkdtempSync(join(tmpdir(), 'crate-rockbox-preview-'))
  mkdirSync(join(root, 'wps', 'Foo'), { recursive: true })
  return root
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true })
}

function bmp(width, height) {
  const bytesPerPixel = 3
  const rowSize = Math.ceil((width * bytesPerPixel) / 4) * 4
  const imageSize = rowSize * height
  const buffer = Buffer.alloc(54 + imageSize)
  buffer.write('BM', 0, 'ascii')
  buffer.writeUInt32LE(buffer.length, 2)
  buffer.writeUInt32LE(54, 10)
  buffer.writeUInt32LE(40, 14)
  buffer.writeInt32LE(width, 18)
  buffer.writeInt32LE(height, 22)
  buffer.writeUInt16LE(1, 26)
  buffer.writeUInt16LE(24, 28)
  buffer.writeUInt32LE(imageSize, 34)
  return buffer
}

test('parses useful Rockbox WPS preview primitives', async () => {
  const root = tempRockbox()
  try {
    writeFileSync(join(root, 'wps', 'Foo.wps'), [
      '%wd',
      '%X(bg.bmp)',
      '%xl(I,status.bmp,8,9,4)',
      '%Vl(main,10,20,120,16,2)',
      '%Vf(ffcc00)',
      '%al%it',
      '%V(20,45,80,8,-)',
      '%pb(0,0,80,8)',
      '%Cl(30,60,90,90)',
      '%Cd',
      '%xd(Ic)',
      '%Vl(vol,40,170,100,10,-)',
      '%pv(0,0,100,6)',
    ].join('\n'))
    writeFileSync(join(root, 'wps', 'Foo', 'bg.bmp'), bmp(320, 240))
    writeFileSync(join(root, 'wps', 'Foo', 'status.bmp'), bmp(10, 40))

    const result = await parseRockboxThemePreview(root, 'Foo', 'wps/Foo.wps', {
      'foreground color': 'ffffff',
      'background color': '000000',
    })

    assert.equal(result.preview.width, 320)
    assert.equal(result.preview.height, 240)
    assert.ok(result.referencedPaths.includes('wps/Foo/bg.bmp'))
    assert.ok(result.referencedPaths.includes('wps/Foo/status.bmp'))

    const text = result.preview.layers.find(layer => layer.type === 'text')
    assert.equal(text?.type, 'text')
    assert.equal(text.template, '{{title}}')
    assert.equal(text.color, 'ffcc00')

    const image = result.preview.layers.find(layer => layer.type === 'image' && layer.path.endsWith('status.bmp'))
    assert.equal(image?.type, 'image')
    assert.equal(image.sourceY, 20)
    assert.equal(image.sourceHeight, 10)

    assert.ok(result.preview.layers.some(layer => layer.type === 'bar' && layer.kind === 'progress'))
    assert.ok(result.preview.layers.some(layer => layer.type === 'bar' && layer.kind === 'volume'))
    assert.ok(result.preview.layers.some(layer => layer.type === 'albumArt'))
  } finally {
    cleanup(root)
  }
})

test('rejects unsafe preview asset paths', async () => {
  const root = tempRockbox()
  try {
    writeFileSync(join(root, 'wps', 'Foo.wps'), [
      '%X(../../secret.bmp)',
      '%xl(A,._bad.bmp,0,0)',
      '%xd(A)',
    ].join('\n'))
    writeFileSync(join(root, 'wps', 'Foo', '._bad.bmp'), bmp(8, 8))

    const result = await parseRockboxThemePreview(root, 'Foo', 'wps/Foo.wps')

    assert.equal(result.preview.layers.length, 0)
    assert.deepEqual(result.referencedPaths, ['wps/Foo.wps'])
  } finally {
    cleanup(root)
  }
})
