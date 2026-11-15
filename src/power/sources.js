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
  '/sys/class/power_supply/BATTERY',
  '/sys/class/power_supply/bms',
  '/sys/class/power_supply/primary',
  '/sys/class/power_supply/main'
]
const POWER_SUPPLY_ROOT = '/sys/class/power_supply'
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

  /**
   * Battery: sysfs first (world-readable on most ROMs), then `termux-battery-status`
   * (needs the Termux:API app + package). Returns `{battery: null}` when neither
   * works - never a fake 100%.
   *
   * `capacity` and `status` are two independent files: a ROM can expose one and
   * deny the other, so charging is probed across every candidate directory and
   * becomes `null` (unknown) instead of silently "not charging".
   */
  async readBattery () {
    const dirs = await this.candidateDirs()
    let battery = null
    let via = null
    let charging = null
    for (const dir of dirs) {
      if (battery !== null) break
      try {
        const capacity = Number((await this.fs.readFile(`${dir}/capacity`, 'utf8')).trim())
        if (!Number.isFinite(capacity)) continue
        battery = capacity
        via = 'sysfs'
      } catch {}
    }
    for (const dir of dirs) {
      try {
        const status = (await this.fs.readFile(`${dir}/status`, 'utf8')).trim().toLowerCase()
        if (!status) continue
        charging = status === 'charging' || status === 'full'
        break
      } catch {}
    }
    if (battery !== null) return { battery, charging, via }
    const viaApi = await this.readBatteryViaApi()
    if (viaApi) return viaApi
    return { battery: null, charging: null, via: null }
  }

  /**
   * Directory names for the battery node differ per ROM (`battery`/`BATTERY`/
   * `bms`/...). Ask sysfs for every supply whose `type` is Battery and put those
   * first, then fall back to the hardcoded guesses.
   */
  async candidateDirs () {
    const dirs = [...this.batteryDirs]
    let names = []
    try {
      names = await this.fs.readdir(POWER_SUPPLY_ROOT)
    } catch {}
    for (const name of names) {
      const dir = `${POWER_SUPPLY_ROOT}/${name}`
      if (dirs.includes(dir)) continue
      try {
        const type = (await this.fs.readFile(`${dir}/type`, 'utf8')).trim().toLowerCase()
        if (type === 'battery') dirs.unshift(dir)
      } catch {}
    }
    return dirs
  }

  async readBatteryViaApi () {
    const out = await this.exec('termux-battery-status', [])
    if (!out) return null
    try {
      const data = JSON.parse(out)
      const capacity = Number(data.percentage)
      if (!Number.isFinite(capacity)) return null
      const plugged = String(data.plugged || '').toUpperCase()
      // No `plugged` field at all: charging is unknown, not "no".
      const charging = plugged ? plugged.includes('PLUGGED') : null
      return { battery: capacity, charging, via: 'termux-api' }
    } catch {
      return null
    }
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
    // null means "no readable zone" (zone numbering is ROM-specific and some
    // ROMs deny the whole directory). Do not collapse it to NONE=0.
    return { celsius: hottest, status: hottest === null ? null : thermalStatusFromCelsius(hottest) }
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
      const batteryKnown = Number.isFinite(mock.battery)
      const thermalKnown = Number.isFinite(mock.thermal) || Number.isFinite(mock.thermalCelsius)
      return {
        battery: batteryKnown ? mock.battery : null,
        charging: mock.charging === undefined ? null : Boolean(mock.charging),
        thermal: thermalKnown
          ? (Number.isFinite(mock.thermal) ? mock.thermal : thermalStatusFromCelsius(mock.thermalCelsius))
          : null,
        // Desktop hint only; the manager still prefers real UI reports.
        screenHint: mock.screenOn === undefined ? null : Boolean(mock.screenOn),
        powerSave: Boolean(mock.powerSave),
        source: 'mock',
        availability: {
          battery: batteryKnown ? 'mock' : 'unavailable',
          charging: mock.charging === undefined ? 'unavailable' : 'mock',
          thermal: thermalKnown ? 'mock' : 'unavailable',
          powerSave: 'mock'
        }
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
      source: 'android',
      // Third state per signal: 'live' | 'unavailable'. Anything else must not
      // be silently treated as a healthy value.
      availability: {
        battery: battery.battery === null ? 'unavailable' : (battery.via === 'termux-api' ? 'live(termux-api)' : 'live'),
        // capacity and status are separate files: one can be readable while the
        // other is denied, and L3 exit depends on this one.
        charging: battery.charging === null ? 'unavailable' : 'live',
        thermal: thermal.status === null ? 'unavailable' : 'live',
        powerSave: 'live'
      }
    }
  }
}

module.exports = { AndroidSignalSource, thermalStatusFromCelsius }
