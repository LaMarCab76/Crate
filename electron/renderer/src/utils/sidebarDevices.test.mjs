import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { visibleSidebarDevices } from './sidebarDevices.ts'

test('sidebar devices include connected devices and hide offline devices', () => {
  const devices = [
    { id: 'hifi-walker', isAvailable: true },
    { id: 'old-dap', isAvailable: false },
    { id: 'rockbox', isAvailable: true },
  ]

  assert.deepEqual(visibleSidebarDevices(devices).map(device => device.id), [
    'hifi-walker',
    'rockbox',
  ])
})

test('sidebar device list is empty when every linked device is offline', () => {
  const devices = [
    { id: 'old-dap', isAvailable: false },
    { id: 'backup-player', isAvailable: false },
  ]

  assert.deepEqual(visibleSidebarDevices(devices), [])
})
