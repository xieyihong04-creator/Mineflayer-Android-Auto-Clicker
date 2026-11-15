'use strict'

const fsp = require('node:fs/promises')
const { execFile } = require('node:child_process')

const POWER_SUPPLY_ROOT = '/sys/class/power_supply'
const THERMAL_ROOT = '/sys/class/thermal'

/**
 * Thermal zones are selected by `type`, never by zone number: numbering is
 * ROM-specific and can change across reboots. The list below is the whitelist
 * measured on a real device (Xiaomi 2509FPN0BC / Android 17): `quiet_therm` is
 * the body/skin sensor, `battery`/`batt_temp` the cell, `charger_therm` the
 * charging path.
 */
const DEFAULT_THERMAL = {
  // Absolute thresholds cannot work: an idle phone already sits at ~43-44 C on
  // the body sensor. L0 is driven by the delta above a per-device baseline.
  l0DeltaC: 7,
  baselineWindowMs: 180000,
  baselineMinSamples: 3,
  zoneTypes: ['quiet_therm', 'battery', 'batt_temp', 'charger_therm'],
  // `cpu-hw-trip-*` reads 95000 (a trip point, not a temperature), `vbat` is a
  // voltage, `*-bcl-lvl*` / `*-ibat-lvl*` are current limits.
  exclude: ['cpu-hw-trip', 'vbat', 'bcl-lvl', 'ibat-lvl']
}

const BATTERY_DIRS = [
  '/sys/class/power_supply/battery',
  '/sys/class/power_supply/Battery',
  '/sys/class/power_supply/BATTERY',
  '/sys/class/power_supply/bms',
  '/sys/class/power_supply/primary',
  '/sys/class/power_supply/main'
]

function execFileAsync (cmd, args, timeout = 3000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? { out: null, code: err.code || 'error' } : { out: String(stdout), code: null })
    })
  })
}

function errCode (err) {
  return (err && (err.code || err.message)) || 'error'
}

function isDenied (code) {
  return code === 'EACCES' || code === 'EPERM'
}

function median (values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Rejects the values that look like temperatures but are not:
 * -273000 mC is the kernel's "zone offline" sentinel (absolute zero);
 * `vbat` (mV) and trip points are already excluded by type, but a value outside
 * a plausible human range is dropped too instead of poisoning the baseline.
 */
function normalizeTemp (raw) {
  if (!Number.isFinite(raw)) return null
  const celsius = raw > 1000 ? raw / 1000 : raw
  // 0 exactly is "zone not populated", not a cold phone.
  if (celsius === 0 || celsius <= -40 || celsius >= 200) return null
  return celsius
}

/**
 * Display-only mapping (the tier machine uses the delta, not this): 0 = at
 * baseline, 4 = far above. `-273000`-style garbage never reaches here.
 */
function thermalStatusFromDelta (delta) {
  if (!Number.isFinite(delta)) return null
  if (delta >= 15) return 4
  if (delta >= 10) return 3
  if (delta >= 6) return 2
  if (delta >= 4) return 1
  return 0
}

/**
 * `plugged` and `status` are two independent fields, and the current sign is
 * NOT usable (this device reports +482 mA while discharging). When the two
 * fields disagree we answer "not charging": that is the side that cannot
 * deep-discharge the phone, because L3 still applies.
 */
function chargingFromApi (data) {
  const plugged = String(data.plugged || '').toUpperCase()
  const status = String(data.status || '').toUpperCase()
  const byPlugged = plugged ? !plugged.includes('UNPLUGGED') : null
  const byStatus = (status === 'CHARGING' || status === 'FULL')
    ? true
    : ((status === 'DISCHARGING' || status === 'NOT_CHARGING') ? false : null)
  if (byStatus === null && byPlugged === null) return null
  if (byStatus === null) return byPlugged
  if (byPlugged === null) return byStatus
  return byStatus && byPlugged
}

/** Power telemetry for the jsonl log; never shown in the UI. */
function telemetryFromApi (data) {
  const mv = Number(data.voltage)
  const ua = Number(data.current)
  const pct = Number(data.percentage)
  const chargeCounterUah = Number(data.charge_counter)
  const voltageV = Number.isFinite(mv) ? mv / 1000 : null
  const watts = voltageV !== null && Number.isFinite(ua)
    ? Math.round(Math.abs(voltageV * (ua / 1e6)) * 1000) / 1000
    : null
  // charge_counter is uAh; pct is 0-100. Extrapolating to 100% gives the full
  // pack estimate, which is the only way to turn watts into %/h.
  const fullMah = Number.isFinite(chargeCounterUah) && pct > 0
    ? Math.round(((chargeCounterUah / 1000) / (pct / 100)) * 10) / 10
    : null
  const energyWh = fullMah !== null && voltageV !== null
    ? Math.round((fullMah / 1000) * voltageV * 10) / 10
    : null
  return {
    watts,
    voltageMv: Number.isFinite(mv) ? mv : null,
    currentUa: Number.isFinite(ua) ? ua : null,
    cycle: Number.isFinite(Number(data.cycle)) ? Number(data.cycle) : null,
    fullMah,
    energyWh,
    batteryTempC: Number.isFinite(Number(data.temperature)) ? Number(data.temperature) : null,
    status: data.status || null,
    plugged: data.plugged || null
  }
}

/**
 * Reads battery/thermal/power-save signals for a Termux shell.
 *
 * Real-device facts that shape this file (measured, not guessed):
 * - `/sys/class/power_supply` is EACCES for a normal uid on this ROM: SELinux
 *   denies it permanently without root. The sysfs branch therefore always
 *   fails there and `termux-battery-status` is the live path.
 * - Body temperature at idle is ~43 C, so absolute thresholds would pin the bot
 *   in L0 forever. We learn a baseline (median of the first minutes) and react
 *   to the delta.
 * - Discharge current is reported positive, so power uses |V * I|.
 *
 * Screen state is deliberately NOT read here: `dumpsys power` needs DUMP.
 */
class AndroidSignalSource {
  constructor ({
    fs = fsp,
    exec = execFileAsync,
    env = process.env,
    batteryDirs = BATTERY_DIRS,
    thermal = {},
    now = () => Date.now()
  } = {}) {
    this.fs = fs
    this.exec = exec
    this.env = env
    this.batteryDirs = batteryDirs
    this.thermalCfg = { ...DEFAULT_THERMAL, ...thermal }
    this.now = now
    this.lastReadAt = 0
    this.baseline = null
    this.baselineSince = null
    this.baselineSamples = []
    this.baselineType = null
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

  /** `exec` stubs in tests return a bare string; normalize both shapes. */
  async execText (cmd, args) {
    const result = await this.exec(cmd, args)
    if (typeof result === 'string') return { out: result, code: null }
    return result || { out: null, code: 'error' }
  }

  async readBattery () {
    const { dirs, error: sysfsError } = await this.candidateDirs()
    let battery = null
    let charging = null
    let via = null
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
    if (battery !== null) {
      return { battery, charging, via, sysfsError, bridgeError: null, telemetry: null }
    }
    const api = await this.readBatteryViaApi()
    if (api.ok) {
      return {
        battery: api.battery,
        charging: api.charging,
        via: 'termux-api',
        sysfsError,
        bridgeError: null,
        telemetry: api.telemetry
      }
    }
    return { battery: null, charging: null, via: null, sysfsError, bridgeError: api.reason, telemetry: null }
  }

  /**
   * Directory names for the battery node differ per ROM. Ask sysfs for every
   * supply whose `type` is Battery and put those first, then fall back to the
   * hardcoded guesses. The readdir error is kept because EACCES here is the
   * SELinux case the self-check table has to report verbatim.
   */
  async candidateDirs () {
    const dirs = [...this.batteryDirs]
    let names = []
    let error = null
    try {
      names = await this.fs.readdir(POWER_SUPPLY_ROOT)
    } catch (err) {
      error = errCode(err)
    }
    for (const name of names || []) {
      const dir = `${POWER_SUPPLY_ROOT}/${name}`
      if (dirs.includes(dir)) continue
      try {
        const type = (await this.fs.readFile(`${dir}/type`, 'utf8')).trim().toLowerCase()
        if (type === 'battery') dirs.unshift(dir)
      } catch (err) {
        if (error === null && isDenied(errCode(err))) error = errCode(err)
      }
    }
    return { dirs, error }
  }

  async readBatteryViaApi () {
    const { out } = await this.execText('termux-battery-status', [])
    // Missing package, missing Termux:API app and a hung bridge all land here;
    // all three are fixed on the app side, so they share one status.
    if (!out) return { ok: false, reason: 'no-bridge' }
    let data
    try {
      data = JSON.parse(out)
    } catch {
      return { ok: false, reason: 'no-bridge' }
    }
    if (!data || typeof data !== 'object') return { ok: false, reason: 'no-bridge' }
    const battery = Number(data.percentage)
    if (!Number.isFinite(battery)) return { ok: false, reason: 'no-bridge' }
    return {
      ok: true,
      battery,
      charging: chargingFromApi(data),
      telemetry: telemetryFromApi(data)
    }
  }

  /**
   * Whitelisted zones only, chosen in config order. Returns the delta above the
   * learned baseline; `delta === null` means "baseline still warming up", which
   * must not downgrade anything.
   */
  async readThermal () {
    const cfg = this.thermalCfg
    let zones = []
    let dirError = null
    try {
      zones = await this.fs.readdir(THERMAL_ROOT)
    } catch (err) {
      dirError = errCode(err)
    }
    const matched = []
    for (const zone of zones || []) {
      if (!zone.startsWith('thermal_zone')) continue
      const base = `${THERMAL_ROOT}/${zone}`
      let type
      try {
        type = (await this.fs.readFile(`${base}/type`, 'utf8')).trim().toLowerCase()
      } catch {
        continue
      }
      if (!type || !this.isWhitelisted(type, cfg)) continue
      let raw
      try {
        raw = Number((await this.fs.readFile(`${base}/temp`, 'utf8')).trim())
      } catch {
        continue
      }
      const celsius = normalizeTemp(raw)
      if (celsius === null) continue
      matched.push({ zone, type, celsius })
    }
    if (!matched.length) {
      const status = dirError && isDenied(dirError) ? 'unavailable(selinux)' : 'unavailable(no-zone)'
      return { celsius: null, delta: null, baselineC: null, zone: null, type: null, status, matched }
    }
    let chosen = null
    for (const wanted of cfg.zoneTypes) {
      chosen = matched.find((m) => m.type === String(wanted).toLowerCase())
      if (chosen) break
    }
    if (!chosen) chosen = matched[0]
    const baselineC = this.trackBaseline(chosen)
    const delta = baselineC === null
      ? null
      : Math.round((chosen.celsius - baselineC) * 10) / 10
    return {
      celsius: chosen.celsius,
      delta,
      baselineC,
      zone: chosen.zone,
      type: chosen.type,
      status: 'live',
      matched
    }
  }

  isWhitelisted (type, cfg) {
    if (cfg.exclude.some((pattern) => type.includes(String(pattern).toLowerCase()))) return false
    return cfg.zoneTypes.some((wanted) => type === String(wanted).toLowerCase())
  }

  /**
   * Baseline = median of the samples taken during the first `baselineWindowMs`.
   * Median (not mean) so a single hot sample while the bot logs in does not
   * shift the reference for the whole session. A zone switch resets it.
   */
  trackBaseline ({ type, celsius }) {
    if (this.baselineType !== type) {
      this.baselineType = type
      this.baseline = null
      this.baselineSince = null
      this.baselineSamples = []
    }
    if (this.baseline !== null) return this.baseline
    const now = this.now()
    if (this.baselineSince === null) this.baselineSince = now
    this.baselineSamples.push(celsius)
    if (now - this.baselineSince < this.thermalCfg.baselineWindowMs) return null
    if (this.baselineSamples.length < this.thermalCfg.baselineMinSamples) return null
    this.baseline = Math.round(median(this.baselineSamples) * 10) / 10
    return this.baseline
  }

  async readScreenOn () {
    // Kept only as an explicit diagnostic: Termux usually has no DUMP access.
    const out = await this.exec('dumpsys', ['power'])
    if (!out) return null
    const text = typeof out === 'string' ? out : out.out
    if (!text) return null
    const wakefulness = /mWakefulness=(\w+)/.exec(text)
    if (wakefulness) return wakefulness[1] === 'Awake'
    if (/mScreenOn=true/.test(text)) return true
    if (/mScreenOn=false/.test(text)) return false
    const display = /Display Power: state=(\w+)/.exec(text)
    if (display) return display[1] === 'ON'
    return null
  }

  /** null = could not read; callers must show "unavailable", never "off". */
  async readPowerSave () {
    const { out } = await this.execText('settings', ['get', 'global', 'low_power'])
    if (!out) return { value: null, via: null }
    const value = out.trim()
    if (value === '1') return { value: true, via: 'settings' }
    if (value === '0') return { value: false, via: 'settings' }
    return { value: null, via: null }
  }

  async read () {
    const mock = this.readMock()
    if (mock) {
      this.lastReadAt = this.now()
      const batteryKnown = Number.isFinite(mock.battery)
      const thermalDelta = Number.isFinite(mock.thermalDeltaC) ? mock.thermalDeltaC : null
      const display = Number.isFinite(mock.thermal) ? mock.thermal : thermalStatusFromDelta(thermalDelta)
      return {
        battery: batteryKnown ? mock.battery : null,
        charging: mock.charging === undefined ? null : Boolean(mock.charging),
        thermal: display,
        thermalCelsius: Number.isFinite(mock.thermalCelsius) ? mock.thermalCelsius : null,
        thermalBaselineC: null,
        thermalDelta,
        thermalZone: null,
        // Desktop hint only; the manager still prefers real UI reports.
        screenHint: mock.screenOn === undefined ? null : Boolean(mock.screenOn),
        powerSave: Boolean(mock.powerSave),
        source: 'mock',
        telemetry: null,
        availability: {
          battery: batteryKnown ? 'mock' : 'unavailable',
          charging: mock.charging === undefined ? 'unavailable' : 'mock',
          thermal: display === null && thermalDelta === null ? 'unavailable' : 'mock',
          powerSave: 'mock'
        }
      }
    }

    const [battery, thermal, powerSave] = await Promise.all([
      this.readBattery(),
      this.readThermal(),
      this.readPowerSave()
    ])
    this.lastReadAt = this.now()
    return {
      battery: battery.battery,
      charging: battery.charging,
      thermal: thermal.delta === null ? null : thermalStatusFromDelta(thermal.delta),
      thermalCelsius: thermal.celsius,
      thermalBaselineC: thermal.baselineC,
      thermalDelta: thermal.delta,
      thermalZone: thermal.type,
      screenHint: null,
      powerSave: powerSave.value,
      source: 'android',
      telemetry: battery.telemetry,
      // Third state per signal. The reason is part of the status: on a SELinux
      // ROM "unavailable(selinux)" is permanent and no amount of config fixes
      // it, while "unavailable(no-bridge)" means install Termux:API.
      availability: {
        battery: this.batteryAvailability(battery),
        charging: battery.charging === null
          ? 'unavailable'
          : (battery.via === 'termux-api' ? 'live(termux-api)' : 'live'),
        thermal: thermal.status,
        powerSave: powerSave.value === null ? 'unavailable' : 'live',
        // Separate from the status so the table can show both facts at once:
        // "sysfs is denied by SELinux" is permanent, "no bridge" is fixable.
        bridge: battery.bridgeError || null
      }
    }
  }

  batteryAvailability (battery) {
    if (battery.battery !== null) {
      return battery.via === 'termux-api' ? 'live(termux-api)' : 'live'
    }
    // SELinux first: it is the platform truth on a non-root ROM, and it stays
    // true even after Termux:API is installed.
    if (isDenied(battery.sysfsError)) return 'unavailable(selinux)'
    if (battery.bridgeError) return 'unavailable(no-bridge)'
    return 'unavailable'
  }
}

module.exports = {
  AndroidSignalSource,
  thermalStatusFromDelta,
  normalizeTemp,
  chargingFromApi,
  DEFAULT_THERMAL
}
