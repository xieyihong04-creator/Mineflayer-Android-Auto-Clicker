'use strict'

const fsp = require('node:fs/promises')
const { execFile } = require('node:child_process')

function execFileAsync (cmd, args, timeout = 3000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout))
    })
  })
}

const BATTERY_DIRS = [
  '/sys/class/power_supply/battery',
  '/sys/class/power_supply/Battery',
  '/sys/class/power_supply/bms'
]
const THERMAL_ROOT = '/sys/class/thermal'

/** Approximate Android PowerManager thermal status from the hottest zone. */
function thermalStatusFromCelsius (celsius) {
  if (!Number.isFinite(celsius)) return 0
  if (celsius >= 55) return 4 // SEVERE+ (emergency territory)
  if (celsius >= 50) return 3 // SEVERE
  if (celsius >= 45) return 2 // MODERATE
  if (celsius >= 40) return 1 // LIGHT
  return 0 // NONE
}

/**
 * Reads battery/thermal/power-save signals for a Termux shell.
 *
 * M1 runs in Termux where BatteryManager/getCurrentThermalStatus do not exist,
 * so we read sysfs. Every read is best-effort: a failure yields `null`/safe
 * defaults instead of throwing.
 *
 * Screen state is deliberately NOT read here: `dumpsys power` needs the DUMP
 * permission that a normal app uid does not have, so its answer is unavailable
 * exactly when it matters. The UI reports visibility instead (see screen.js);
 * `screenHint` is only the MCBOT_MOCK_POWER override for desktop testing.
 */
class AndroidSignalSource {
  constructor ({ fs = fsp, exec = execFileAsync, env = process.env, batteryDirs = BATTERY_DIRS } = {}) {
    this.fs = fs
    this.exec = exec
    this.env = env
    this.batteryDirs = batteryDirs
    this.lastReadAt = 0
  }

  readMock () {
    const raw = this.env.MCBOT_MOCK_POWER
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  async readBattery () {
    for (const dir of this.batteryDirs) {
      try {
        const capacity = Number((await this.fs.readFile(`${dir}/capacity`, 'utf8')).trim())
        if (!Number.isFinite(capacity)) continue
        let charging = false
        try {
          const status = (await this.fs.readFile(`${dir}/status`, 'utf8')).trim().toLowerCase()
          charging = status === 'charging' || status === 'full'
        } catch {}
        return { battery: capacity, charging }
      } catch {}
    }
    return { battery: null, charging: false }
  }

  async readThermal () {
    let hottest = null
    try {
      const zones = await this.fs.readdir(THERMAL_ROOT)
      for (const zone of zones) {
        if (!zone.startsWith('thermal_zone')) continue
        try {
          const raw = Number((await this.fs.readFile(`${THERMAL_ROOT}/${zone}/temp`, 'utf8')).trim())
          if (!Number.isFinite(raw) || raw === 0) continue
          const celsius = raw > 1000 ? raw / 1000 : raw
          if (hottest === null || celsius > hottest) hottest = celsius
        } catch {}
      }
    } catch {}
    return { celsius: hottest, status: thermalStatusFromCelsius(hottest) }
  }

  async readScreenOn () {
    // Kept only as an explicit diagnostic: Termux usually has no DUMP access.
    const out = await this.exec('dumpsys', ['power'])
    if (!out) return null
    const wakefulness = /mWakefulness=(\w+)/.exec(out)
    if (wakefulness) return wakefulness[1] === 'Awake'
    if (/mScreenOn=true/.test(out)) return true
    if (/mScreenOn=false/.test(out)) return false
    const display = /Display Power: state=(\w+)/.exec(out)
    if (display) return display[1] === 'ON'
    return null
  }

  async readPowerSave () {
    const out = await this.exec('settings', ['get', 'global', 'low_power'])
    if (!out) return false
    return out.trim() === '1'
  }

  async read () {
    const mock = this.readMock()
    if (mock) {
      this.lastReadAt = Date.now()
      return {
        battery: Number.isFinite(mock.battery) ? mock.battery : null,
        charging: Boolean(mock.charging),
        thermal: Number.isFinite(mock.thermal) ? mock.thermal : (Number.isFinite(mock.thermalCelsius) ? thermalStatusFromCelsius(mock.thermalCelsius) : 0),
        // Desktop hint only; the manager still prefers real UI reports.
        screenHint: mock.screenOn === undefined ? null : Boolean(mock.screenOn),
        powerSave: Boolean(mock.powerSave),
        source: 'mock'
      }
    }

    const [battery, thermal, powerSave] = await Promise.all([
      this.readBattery(),
      this.readThermal(),
      this.readPowerSave()
    ])
    this.lastReadAt = Date.now()
    return {
      battery: battery.battery,
      charging: battery.charging,
      thermal: thermal.status,
      thermalCelsius: thermal.celsius,
      screenHint: null,
      powerSave,
      source: 'android'
    }
  }
}

module.exports = { AndroidSignalSource, thermalStatusFromCelsius }
