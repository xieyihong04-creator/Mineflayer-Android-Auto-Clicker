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
 * Reads battery/thermal/screen/power-save signals from a Termux shell.
 *
 * M1 runs in Termux where BatteryManager/getCurrentThermalStatus do not exist,
 * so we read sysfs and dumpsys. Every read is best-effort: a failure yields
 * `null`/safe defaults instead of throwing.
 */
class AndroidSignalSource {
  constructor ({ fs = fsp, exec = execFileAsync, env = process.env, batteryDirs = BATTERY_DIRS } = {}) {
    this.fs = fs
    this.exec = exec
    this.env = env
    this.batteryDirs = batteryDirs
    this.screenOnOverride = null
    this.lastScreenOn = true
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
    if (this.screenOnOverride !== null) return this.screenOnOverride
    const out = await this.exec('dumpsys', ['power'])
    if (!out) return this.lastScreenOn
    const wakefulness = /mWakefulness=(\w+)/.exec(out)
    if (wakefulness) {
      this.lastScreenOn = wakefulness[1] === 'Awake'
      return this.lastScreenOn
    }
    if (/mScreenOn=true/.test(out)) return true
    if (/mScreenOn=false/.test(out)) return false
    const display = /Display Power: state=(\w+)/.exec(out)
    if (display) return display[1] === 'ON'
    return this.lastScreenOn
  }

  async readPowerSave () {
    const out = await this.exec('settings', ['get', 'global', 'low_power'])
    if (!out) return false
    return out.trim() === '1'
  }

  setScreenOverride (on) {
    this.screenOnOverride = on === null ? null : Boolean(on)
  }

  async read () {
    const mock = this.readMock()
    if (mock) {
      this.lastReadAt = Date.now()
      return {
        battery: Number.isFinite(mock.battery) ? mock.battery : null,
        charging: Boolean(mock.charging),
        thermal: Number.isFinite(mock.thermal) ? mock.thermal : (Number.isFinite(mock.thermalCelsius) ? thermalStatusFromCelsius(mock.thermalCelsius) : 0),
        screenOn: mock.screenOn !== undefined ? Boolean(mock.screenOn) : true,
        powerSave: Boolean(mock.powerSave),
        source: 'mock'
      }
    }

    const [battery, thermal, screenOn, powerSave] = await Promise.all([
      this.readBattery(),
      this.readThermal(),
      this.readScreenOn(),
      this.readPowerSave()
    ])
    this.lastReadAt = Date.now()
    return {
      battery: battery.battery,
      charging: battery.charging,
      thermal: thermal.status,
      thermalCelsius: thermal.celsius,
      screenOn,
      powerSave,
      source: 'android'
    }
  }
}

module.exports = { AndroidSignalSource, thermalStatusFromCelsius }
