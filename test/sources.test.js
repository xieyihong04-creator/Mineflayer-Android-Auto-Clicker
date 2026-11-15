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
    screenOn: false,
    powerSave: true,
    source: 'mock'
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
  assert.equal(signals.screenOn, false)
  assert.equal(signals.powerSave, true)
})

test('a broken sysfs does not throw; battery becomes null and screen defaults to on', async () => {
  const fakeFs = {
    readFile: async () => { throw new Error('EACCES') },
    readdir: async () => { throw new Error('EACCES') }
  }
  const source = new AndroidSignalSource({ fs: fakeFs, exec: async () => null, env: {} })
  const signals = await source.read()
  assert.equal(signals.battery, null)
  assert.equal(signals.screenOn, true)
  assert.equal(signals.powerSave, false)
  assert.equal(signals.thermal, 0)
})

test('screen override is honoured (manual fallback when dumpsys is unavailable)', async () => {
  const source = new AndroidSignalSource({ exec: async () => null, env: {} })
  source.setScreenOverride(false)
  assert.equal(await source.readScreenOn(), false)
  source.setScreenOverride(null)
  assert.equal(await source.readScreenOn(), true)
})
