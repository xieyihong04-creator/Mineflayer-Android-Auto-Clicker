'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  AndroidSignalSource,
  thermalStatusFromDelta,
  normalizeTemp,
  chargingFromApi
} = require('../src/power/sources')

function fakeFs (files, dirs = {}) {
  return {
    readFile: async (p) => {
      if (files[p] === undefined) {
        const err = new Error('ENOENT')
        err.code = 'ENOENT'
        throw err
      }
      return files[p]
    },
    readdir: async (root) => {
      if (dirs[root] === undefined) {
        const err = new Error('ENOENT')
        err.code = 'ENOENT'
        throw err
      }
      return dirs[root]
    }
  }
}

function deniedFs () {
  const err = new Error('EACCES: permission denied')
  err.code = 'EACCES'
  return {
    readFile: async () => { throw err },
    readdir: async () => { throw err }
  }
}

test('display status comes from the delta, not from an absolute Celsius value', () => {
  assert.equal(thermalStatusFromDelta(null), null)
  assert.equal(thermalStatusFromDelta(0), 0)
  assert.equal(thermalStatusFromDelta(4), 1)
  assert.equal(thermalStatusFromDelta(6), 2)
  assert.equal(thermalStatusFromDelta(10), 3)
  assert.equal(thermalStatusFromDelta(15), 4)
})

test('temperature normalisation drops the offline sentinel and implausible values', () => {
  assert.equal(normalizeTemp(43000), 43)
  assert.equal(normalizeTemp(43), 43)
  assert.equal(normalizeTemp(-273000), null, 'absolute zero = zone offline')
  assert.equal(normalizeTemp(0), null)
  assert.equal(normalizeTemp(95000), 95, 'plausible range passes; type whitelist is what rejects trips')
  assert.equal(normalizeTemp(NaN), null)
})

test('charging uses plugged + status; disagreement resolves to "not charging"', () => {
  assert.equal(chargingFromApi({ plugged: 'UNPLUGGED', status: 'DISCHARGING' }), false)
  assert.equal(chargingFromApi({ plugged: 'PLUGGED_USB', status: 'CHARGING' }), true)
  assert.equal(chargingFromApi({ plugged: 'PLUGGED_AC', status: 'FULL' }), true)
  assert.equal(chargingFromApi({ plugged: 'PLUGGED_AC', status: 'DISCHARGING' }), false, 'conflict -> safe side')
  assert.equal(chargingFromApi({ status: 'CHARGING' }), true, 'status alone is enough')
  assert.equal(chargingFromApi({ plugged: 'PLUGGED_WIRELESS' }), true)
  assert.equal(chargingFromApi({ plugged: 'UNPLUGGED' }), false)
  assert.equal(chargingFromApi({}), null, 'current sign must never be used')
})

test('mock signals are used when MCBOT_MOCK_POWER is set (desktop / tests)', async () => {
  const source = new AndroidSignalSource({
    env: { MCBOT_MOCK_POWER: '{"battery":18,"charging":true,"thermal":2,"screenOn":false,"powerSave":true}' }
  })
  const signals = await source.read()
  assert.equal(signals.battery, 18)
  assert.equal(signals.charging, true)
  assert.equal(signals.thermal, 2)
  assert.equal(signals.screenHint, false)
  assert.equal(signals.powerSave, true)
  assert.equal(signals.source, 'mock')
  assert.deepEqual(signals.availability, {
    battery: 'mock',
    charging: 'mock',
    thermal: 'mock',
    powerSave: 'mock'
  })
})

test('real-device shape: power_supply is EACCES, termux-api answers', async () => {
  const exec = async (cmd) => {
    if (cmd === 'termux-battery-status') {
      return JSON.stringify({
        present: true,
        technology: 'Li-poly',
        health: 'GOOD',
        plugged: 'UNPLUGGED',
        status: 'DISCHARGING',
        temperature: 38.0,
        voltage: 3977,
        current: 482000,
        percentage: 66,
        level: 66,
        scale: 100,
        charge_counter: 4704000,
        cycle: 196
      })
    }
    if (cmd === 'settings') return '0\n'
    return null
  }
  const source = new AndroidSignalSource({ fs: deniedFs(), exec, env: {} })
  const signals = await source.read()
  assert.equal(signals.battery, 66)
  assert.equal(signals.charging, false, 'UNPLUGGED + DISCHARGING, despite positive current')
  assert.equal(signals.availability.battery, 'live(termux-api)')
  assert.equal(signals.availability.charging, 'live(termux-api)')
  // Power = |V * I|: 3.977 V * 0.482 A.
  assert.equal(signals.telemetry.watts, 1.917)
  assert.equal(signals.telemetry.cycle, 196)
  assert.equal(signals.telemetry.fullMah, 7127.3)
  assert.equal(signals.telemetry.energyWh, 28.3)
})

test('sysfs denial is reported as unavailable(selinux), not as a generic failure', async () => {
  const source = new AndroidSignalSource({
    fs: deniedFs(),
    exec: async (cmd) => (cmd === 'settings' ? 'null\n' : null),
    env: {}
  })
  const signals = await source.read()
  assert.equal(signals.battery, null, 'never a fake 100%')
  assert.equal(signals.availability.battery, 'unavailable(selinux)')
  assert.equal(signals.availability.bridge, 'no-bridge', 'both facts are visible at once')
  assert.equal(signals.charging, null)
  assert.equal(signals.availability.charging, 'unavailable')
})

test('a missing Termux:API bridge is its own status when sysfs is merely empty', async () => {
  const source = new AndroidSignalSource({ fs: fakeFs({}), exec: async () => null, env: {} })
  const signals = await source.read()
  assert.equal(signals.availability.battery, 'unavailable(no-bridge)')
  assert.equal(signals.availability.bridge, 'no-bridge')
})

test('battery node name is discovered from power_supply/type, not hardcoded', async () => {
  const files = {
    '/sys/class/power_supply/BAT0/type': 'Battery\n',
    '/sys/class/power_supply/BAT0/capacity': '55\n',
    '/sys/class/power_supply/BAT0/status': 'Discharging\n'
  }
  const fs = fakeFs(files, { '/sys/class/power_supply': ['BAT0', 'usb'] })
  const source = new AndroidSignalSource({ fs, exec: async () => '0\n', env: {} })
  const signals = await source.read()
  assert.equal(signals.battery, 55)
  assert.equal(signals.charging, false)
  assert.equal(signals.availability.battery, 'live')
})

test('charging is its own third state: capacity readable, status denied', async () => {
  const files = { '/sys/class/power_supply/battery/capacity': '9\n' }
  const fs = fakeFs(files, { '/sys/class/power_supply': [] })
  const source = new AndroidSignalSource({ fs, exec: async () => '0\n', env: {} })
  const signals = await source.read()
  assert.equal(signals.battery, 9)
  assert.equal(signals.charging, null, 'unknown charging is not "not charging"')
  assert.equal(signals.availability.charging, 'unavailable')
})

test('thermal zones are selected by type, in whitelist order, never by zone number', async () => {
  const files = {
    '/sys/class/thermal/thermal_zone3/type': 'cpu-hw-trip\n',
    '/sys/class/thermal/thermal_zone3/temp': '95000\n',
    '/sys/class/thermal/thermal_zone40/type': 'battery\n',
    '/sys/class/thermal/thermal_zone40/temp': '38000\n',
    '/sys/class/thermal/thermal_zone71/type': 'quiet_therm\n',
    '/sys/class/thermal/thermal_zone71/temp': '42900\n',
    '/sys/class/thermal/thermal_zone5/type': 'vbat\n',
    '/sys/class/thermal/thermal_zone5/temp': '4017\n',
    '/sys/class/thermal/thermal_zone9/type': 'batt_temp\n',
    '/sys/class/thermal/thermal_zone9/temp': '-273000\n'
  }
  const zones = ['thermal_zone3', 'thermal_zone5', 'thermal_zone9', 'thermal_zone40', 'thermal_zone71']
  const source = new AndroidSignalSource({
    fs: fakeFs(files, { '/sys/class/thermal': zones }),
    exec: async () => '0\n',
    env: {}
  })
  const thermal = await source.readThermal()
  assert.equal(thermal.type, 'quiet_therm', 'whitelist priority, not the hottest zone')
  assert.equal(thermal.zone, 'thermal_zone71')
  assert.equal(thermal.celsius, 42.9)
  assert.equal(thermal.status, 'live')
  assert.equal(thermal.delta, null, 'baseline not ready on the first sample')
})

test('thermal baseline is the median of the first window; L0 follows the delta', async () => {
  let clock = 0
  let temp = 43000
  const files = {
    '/sys/class/thermal/thermal_zone0/type': 'quiet_therm\n',
    '/sys/class/thermal/thermal_zone0/temp': '43000\n'
  }
  const fs = {
    readFile: async (p) => {
      if (p.endsWith('/type')) return files[p]
      if (p.endsWith('/temp')) return `${temp}\n`
      throw new Error('ENOENT')
    },
    readdir: async () => ['thermal_zone0']
  }
  const source = new AndroidSignalSource({
    fs,
    exec: async () => '0\n',
    env: {},
    thermal: { baselineWindowMs: 1000, baselineMinSamples: 2 },
    now: () => clock
  })
  assert.equal((await source.readThermal()).delta, null, 't=0: window not elapsed')
  clock = 600
  assert.equal((await source.readThermal()).delta, null, 't=0.6s: still collecting')
  clock = 1100
  const ready = await source.readThermal()
  assert.equal(ready.baselineC, 43)
  assert.equal(ready.delta, 0)

  clock = 2000
  temp = 50000
  const hot = await source.readThermal()
  assert.equal(hot.celsius, 50)
  assert.equal(hot.delta, 7, 'exactly l0DeltaC')
  assert.equal(thermalStatusFromDelta(hot.delta), 2)
})

test('a zone with only trip points / voltages / sentinels is unavailable, not 95 C', async () => {
  const files = {
    '/sys/class/thermal/thermal_zone0/type': 'cpu-hw-trip-0\n',
    '/sys/class/thermal/thermal_zone0/temp': '95000\n',
    '/sys/class/thermal/thermal_zone1/type': 'vbat\n',
    '/sys/class/thermal/thermal_zone1/temp': '4017\n',
    '/sys/class/thermal/thermal_zone2/type': 'batt_temp\n',
    '/sys/class/thermal/thermal_zone2/temp': '-273000\n'
  }
  const source = new AndroidSignalSource({
    fs: fakeFs(files, { '/sys/class/thermal': ['thermal_zone0', 'thermal_zone1', 'thermal_zone2'] }),
    exec: async () => '0\n',
    env: {}
  })
  const signals = await source.read()
  assert.equal(signals.thermalCelsius, null)
  assert.equal(signals.thermal, null)
  assert.equal(signals.availability.thermal, 'unavailable(no-zone)')
})

test('SELinux on /sys/class/thermal is reported by reason', async () => {
  const source = new AndroidSignalSource({ fs: deniedFs(), exec: async () => '0\n', env: {} })
  const signals = await source.read()
  assert.equal(signals.availability.thermal, 'unavailable(selinux)')
})

test('power save that cannot be read is unavailable, not silently "off"', async () => {
  const off = new AndroidSignalSource({ fs: fakeFs({}), exec: async () => '0\n', env: {} })
  const a = await off.read()
  assert.equal(a.powerSave, false)
  assert.equal(a.availability.powerSave, 'live')

  const unset = new AndroidSignalSource({ fs: fakeFs({}), exec: async () => 'null\n', env: {} })
  const b = await unset.read()
  assert.equal(b.powerSave, null)
  assert.equal(b.availability.powerSave, 'unavailable')

  const broken = new AndroidSignalSource({ fs: fakeFs({}), exec: async () => null, env: {} })
  const c = await broken.read()
  assert.equal(c.powerSave, null)
  assert.equal(c.availability.powerSave, 'unavailable')
})

test('dumpsys screen probing degrades to null instead of guessing "on"', async () => {
  const denied = new AndroidSignalSource({ exec: async () => null, env: {} })
  assert.equal(await denied.readScreenOn(), null)
  const asleep = new AndroidSignalSource({ exec: async () => 'mWakefulness=Asleep\n', env: {} })
  assert.equal(await asleep.readScreenOn(), false)
  const awake = new AndroidSignalSource({ exec: async () => 'mWakefulness=Awake\n', env: {} })
  assert.equal(await awake.readScreenOn(), true)
})

test('termux-battery-status without plugged/status leaves charging unknown', async () => {
  const exec = async (cmd) => {
    if (cmd === 'termux-battery-status') return JSON.stringify({ percentage: 64 })
    return null
  }
  const source = new AndroidSignalSource({ fs: fakeFs({}), exec, env: {} })
  const signals = await source.read()
  assert.equal(signals.battery, 64)
  assert.equal(signals.charging, null)
  assert.equal(signals.availability.charging, 'unavailable')
})
