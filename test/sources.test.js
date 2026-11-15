'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { AndroidSignalSource, thermalStatusFromCelsius } = require('../src/power/sources')

test('thermal status approximates Android PowerManager constants', () => {
  assert.equal(thermalStatusFromCelsius(35), 0)
  assert.equal(thermalStatusFromCelsius(41), 1)
  assert.equal(thermalStatusFromCelsius(46), 2)
  assert.equal(thermalStatusFromCelsius(52), 3)
  assert.equal(thermalStatusFromCelsius(60), 4)
  assert.equal(thermalStatusFromCelsius(null), 0)
})

test('mock signals are used when MCBOT_MOCK_POWER is set (desktop / tests)', async () => {
  const source = new AndroidSignalSource({
    env: { MCBOT_MOCK_POWER: '{"battery":18,"charging":true,"thermal":2,"screenOn":false,"powerSave":true}' }
  })
  const signals = await source.read()
  assert.deepEqual(signals, {
    battery: 18,
    charging: true,
    thermal: 2,
    // Screen state is an event, not a sensor read; the mock value is only a
    // desktop hint for headless runs.
    screenHint: false,
    powerSave: true,
    source: 'mock',
    availability: { battery: 'mock', thermal: 'mock', powerSave: 'mock' }
  })
})

test('reads battery capacity and charging state from sysfs', async () => {
  const files = {
    '/sys/class/power_supply/battery/capacity': '42\n',
    '/sys/class/power_supply/battery/status': 'Charging\n',
    '/sys/class/thermal/thermal_zone0/temp': '38000\n',
    '/sys/class/thermal/thermal_zone1/temp': '46500\n'
  }
  const fakeFs = {
    readFile: async (p) => {
      if (files[p] === undefined) throw new Error('ENOENT')
      return files[p]
    },
    readdir: async (root) => (root === '/sys/class/thermal' ? ['thermal_zone0', 'thermal_zone1'] : [])
  }
  const exec = async (cmd) => {
    if (cmd === 'dumpsys') return 'mWakefulness=Asleep\n'
    if (cmd === 'settings') return '1\n'
    return null
  }
  const source = new AndroidSignalSource({ fs: fakeFs, exec, env: {} })
  const signals = await source.read()
  assert.equal(signals.battery, 42)
  assert.equal(signals.charging, true)
  assert.equal(signals.thermalCelsius, 46.5)
  assert.equal(signals.thermal, 2)
  assert.equal(signals.screenHint, null, 'screen state never comes from sysfs/dumpsys')
  assert.equal(signals.powerSave, true)
})

test('a broken sysfs does not throw; every signal degrades to its third state', async () => {
  const fakeFs = {
    readFile: async () => { throw new Error('EACCES') },
    readdir: async () => { throw new Error('EACCES') }
  }
  const source = new AndroidSignalSource({ fs: fakeFs, exec: async () => null, env: {} })
  const signals = await source.read()
  assert.equal(signals.battery, null, 'never a fake 100%')
  assert.equal(signals.screenHint, null)
  assert.equal(signals.powerSave, false)
  assert.equal(signals.thermal, null, 'unreadable thermal is null, not NONE=0')
  assert.equal(signals.availability.battery, 'unavailable')
  assert.equal(signals.availability.thermal, 'unavailable')
})

test('battery falls back to termux-battery-status when sysfs is denied', async () => {
  const fakeFs = {
    readFile: async () => { throw new Error('EACCES') },
    readdir: async () => { throw new Error('EACCES') }
  }
  const exec = async (cmd) => {
    if (cmd === 'termux-battery-status') {
      return JSON.stringify({ percentage: 37, plugged: 'PLUGGED_USB', status: 'CHARGING' })
    }
    if (cmd === 'settings') return '0\n'
    return null
  }
  const source = new AndroidSignalSource({ fs: fakeFs, exec, env: {} })
  const signals = await source.read()
  assert.equal(signals.battery, 37)
  assert.equal(signals.charging, true)
  assert.equal(signals.availability.battery, 'live(termux-api)')
})

test('termux-battery-status absent (Termux:API not installed) stays unavailable', async () => {
  const fakeFs = {
    readFile: async () => { throw new Error('ENOENT') },
    readdir: async () => { throw new Error('ENOENT') }
  }
  const exec = async (cmd) => {
    if (cmd === 'termux-battery-status') return null
    return null
  }
  const source = new AndroidSignalSource({ fs: fakeFs, exec, env: {} })
  const signals = await source.read()
  assert.equal(signals.battery, null)
  assert.equal(signals.charging, false)
  assert.equal(signals.availability.battery, 'unavailable')
})

test('thermal zone numbering is model-specific: one readable zone is enough', async () => {
  const fakeFs = {
    readFile: async (p) => {
      if (p.endsWith('thermal_zone7/temp')) return '51000\n'
      throw new Error('ENOENT')
    },
    readdir: async () => ['thermal_zone0', 'thermal_zone7', 'cooling_device0']
  }
  const source = new AndroidSignalSource({ fs: fakeFs, exec: async () => null, env: {} })
  const signals = await source.read()
  assert.equal(signals.thermalCelsius, 51)
  assert.equal(signals.thermal, 3)
  assert.equal(signals.availability.thermal, 'live')
})

test('dumpsys screen probing degrades to null instead of guessing "on"', async () => {
  const denied = new AndroidSignalSource({ exec: async () => null, env: {} })
  assert.equal(await denied.readScreenOn(), null)
  const asleep = new AndroidSignalSource({ exec: async () => 'mWakefulness=Asleep\n', env: {} })
  assert.equal(await asleep.readScreenOn(), false)
  const awake = new AndroidSignalSource({ exec: async () => 'mWakefulness=Awake\n', env: {} })
  assert.equal(await awake.readScreenOn(), true)
})
