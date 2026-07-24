import test from 'node:test'
import assert from 'node:assert/strict'
import { computerTerms, desktopPlatform } from './computerTerms.ts'

test('uses Mac terminology only on macOS', () => {
  assert.equal(desktopPlatform('darwin'), 'macos')
  assert.deepEqual(computerTerms('macos'), {
    short: 'Mac',
    definite: 'la Mac',
    destination: 'a la Mac',
    library: 'Biblioteca Mac',
  })
})

test('keeps PC terminology on Windows and Linux', () => {
  assert.equal(desktopPlatform('win32'), 'windows')
  assert.equal(desktopPlatform('freebsd'), 'linux')
  assert.equal(computerTerms('windows').short, 'PC')
  assert.equal(computerTerms('linux').short, 'PC')
})
