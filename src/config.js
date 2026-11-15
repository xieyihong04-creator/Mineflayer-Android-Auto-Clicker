'use strict'

const fs = require('node:fs')
const path = require('node:path')

const DEFAULTS = {
  server: {
    host: '',
    port: 25565,
    version: false, // false => mineflayer auto-detect
    username: '',
    autoConnect: true
  },
  auth: {
    type: 'microsoft', // 'microsoft' | 'offline'
    profilesFolder: './.auth'
  },
  reconnect: {
    baseMs: 1000,
    maxMs: 60000,
    // L3 disconnect must not immediately reconnect (PRD §4 + F1 conflict).
    enabled: true
  },
  power: {
    debounceMs: 10000,
    // Manual override: null = auto, 'L2' = pin active tier.
    forcedMode: null,
    battery: {
      l0Below: 20,
      l3Below: 10,
      // Hysteresis: enter L3 below l3Below, leave it only above l3ExitAbove,
      // otherwise 9% <-> 11% would flap the radio on and off all night.
      l3ExitAbove: 20,
      // If the phone is charging, the <10% disconnect rule is skipped.
      l3SkipWhileCharging: true
    },
    thermal: {
      // Real hardware idles at ~43 C on the body sensor, so an absolute
      // threshold (the old MODERATE=2) would hold the bot in L0 forever.
      // L0 triggers on the delta above a baseline learned during startup.
      l0DeltaC: 7,
      baselineWindowMs: 180000,
      baselineMinSamples: 3,
      // Selected by `type`, never by zone number (numbering is ROM-specific).
      zoneTypes: ['quiet_therm', 'battery', 'batt_temp', 'charger_therm'],
      // Trip points (95000), voltages (vbat) and current limits are not temps.
      exclude: ['cpu-hw-trip', 'vbat', 'bcl-lvl', 'ibat-lvl']
    },
    // Screen state is reported by the UI (Page Visibility API in M1,
    // ACTION_SCREEN_ON/OFF in M2). Querying the system from Termux needs DUMP
    // (privileged), so it is NOT the authority. Fail-safe is always "off".
    screen: {
      requireClient: true,
      reportStaleMs: 600000
    },
    idleMs: 30000,
    // State push rate in Hz per tier. L0 is documented as "stop" in the PRD,
    // but a blind UI cannot satisfy F2/P1; we keep a slow minimal heartbeat.
    stateHz: { L2: 2, L1: 0.2, L0: 0.05 },
    chatLimit: 200,
    chatLimitL0: 50,
    logToFile: true,
    viewDistance: { default: 'normal', l0: 'tiny' }
  },
  eat: {
    enabled: true,
    threshold: 14,
    // On normal difficulty the bot does not starve to death; it dies to mobs
    // while weak. Empty inventory + low HP is therefore an alert, and at/below
    // this HP we stop instead of feeding a death loop. 0 disables the halt.
    disconnectAtHealth: 8,
    // Blacklist always wins over whitelist.
    blacklist: [
      'rotten_flesh',
      'spider_eye',
      'poisonous_potato',
      'pufferfish',
      'raw_chicken',
      'tropical_fish'
    ],
    whitelist: [
      'bread',
      'apple',
      'golden_apple',
      'golden_carrot',
      'carrot',
      'baked_potato',
      'cooked_beef',
      'cooked_porkchop',
      'cooked_mutton',
      'cooked_chicken',
      'cooked_rabbit',
      'cooked_cod',
      'cooked_salmon',
      'melon_slice',
      'sweet_berries',
      'glow_berries',
      'pumpkin_pie',
      'mushroom_stew',
      'beetroot_soup',
      'dried_kelp',
      'cookie'
    ]
  },
  inv: {
    enabled: true,
    minEmptySlots: 3,
    intervalMs: 300000,
    tossGapMs: 300,
    // Any HP loss while standing at the drop point (lava splash, mob, cactus)
    // aborts the toss loop and walks back instead of finishing the job.
    abortOnDamage: true,
    retainCategories: ['tools', 'weapons', 'armor', 'food'],
    // type: 'lava' (walk near + toss) | 'container' (chest/hopper/barrel)
    // set must be true before cleanup is allowed; otherwise the bot would walk
    // to 0,64,0 the first time the timer fires.
    dropPoint: {
      set: false,
      type: 'lava',
      x: 0,
      y: 64,
      z: 0,
      // Before walking there, verify the destination is loaded, the block is a
      // real lava/container, a safe standing spot exists nearby and it is
      // reachable. Without this a bad point means "walk into lava" or a silent
      // 30s nav timeout on every cleanup.
      validate: true,
      maxStandDistance: 3
    }
  },
  respawn: {
    // F9: death -> respawn -> walk back to the AFK waypoint.
    enabled: true,
    // Stop instead of feeding a death loop (eaten out of food is the classic).
    maxConsecutive: 3,
    // Deaths older than this do not count towards the consecutive limit.
    windowMs: 600000,
    delayMs: 2000,
    returnToWaypoint: true,
    waypoint: 'afk'
  },
  nav: {
    timeoutMs: 30000,
    range: 2,
    // F4: never dig/build/parkour.
    canDig: false,
    allowParkour: false,
    allowFreeMotion: false
  },
  afk: {
    // Server AFK-kick mitigation (risk table §7)
    enabled: false,
    intervalMs: 60000,
    action: 'look' // 'look' | 'swing'
  },
  ws: {
    host: '127.0.0.1',
    port: 8765
  },
  waypoints: {}
}

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepClone (value) {
  if (Array.isArray(value)) return value.map(deepClone)
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, inner] of Object.entries(value)) out[key] = deepClone(inner)
    return out
  }
  return value
}

/**
 * Deep merge that never shares nested objects with `base`.
 * Without the clone, `normalize({})` would hand out the live DEFAULTS.power
 * object and a single `forcedMode` write would leak into every other config.
 */
function deepMerge (base, patch) {
  const out = deepClone(base)
  if (!isPlainObject(patch)) return out
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value)
    } else {
      out[key] = deepClone(value)
    }
  }
  return out
}

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Validates and normalizes user-provided config patches.
 * Returns { config, errors } — never throws, so a bad import cannot brick the bot.
 */
function normalize (input, base = DEFAULTS) {
  const cfg = deepMerge(base, input || {})
  const errors = []

  const needString = (value, name) => {
    if (typeof value !== 'string') errors.push(`${name} must be a string`)
  }

  needString(cfg.server.host, 'server.host')
  needString(cfg.server.username, 'server.username')
  cfg.server.autoConnect = Boolean(cfg.server.autoConnect)
  cfg.server.port = Number(cfg.server.port)
  if (!Number.isInteger(cfg.server.port) || cfg.server.port < 1 || cfg.server.port > 65535) {
    errors.push('server.port must be an integer 1-65535')
    cfg.server.port = 25565
  }
  if (cfg.server.version !== false && typeof cfg.server.version !== 'string') {
    errors.push('server.version must be false or a string')
    cfg.server.version = false
  }

  if (!['microsoft', 'offline'].includes(cfg.auth.type)) {
    errors.push("auth.type must be 'microsoft' or 'offline'")
    cfg.auth.type = 'microsoft'
  }

  cfg.reconnect.baseMs = clamp(Number(cfg.reconnect.baseMs) || 1000, 250, 60000)
  cfg.reconnect.maxMs = clamp(Number(cfg.reconnect.maxMs) || 60000, cfg.reconnect.baseMs, 600000)

  const p = cfg.power
  p.debounceMs = clamp(Number(p.debounceMs) || 10000, 10000, 600000)
  p.battery.l0Below = clamp(Number(p.battery.l0Below) || 20, 1, 99)
  p.battery.l3Below = clamp(Number(p.battery.l3Below) || 10, 0, 90)
  if (p.battery.l3Below >= p.battery.l0Below) {
    errors.push('power.battery.l3Below must be < power.battery.l0Below')
    p.battery.l3Below = Math.max(0, p.battery.l0Below - 1)
  }
  p.battery.l3ExitAbove = clamp(Number(p.battery.l3ExitAbove) || p.battery.l0Below, 1, 100)
  if (p.battery.l3ExitAbove <= p.battery.l3Below) {
    errors.push('power.battery.l3ExitAbove must be > power.battery.l3Below (L3 needs hysteresis)')
    p.battery.l3ExitAbove = Math.min(100, p.battery.l3Below + 1)
  }
  p.thermal.l0DeltaC = clamp(Number(p.thermal.l0DeltaC) || 7, 2, 25)
  p.thermal.baselineWindowMs = clamp(Number(p.thermal.baselineWindowMs) || 180000, 10000, 3600000)
  p.thermal.baselineMinSamples = clamp(Number(p.thermal.baselineMinSamples) || 3, 1, 1000)
  p.thermal.zoneTypes = Array.isArray(p.thermal.zoneTypes) && p.thermal.zoneTypes.length
    ? p.thermal.zoneTypes.map((t) => String(t))
    : DEFAULTS.power.thermal.zoneTypes.slice()
  p.thermal.exclude = Array.isArray(p.thermal.exclude) ? p.thermal.exclude.map((t) => String(t)) : []
  p.screen.requireClient = p.screen.requireClient !== false
  p.screen.reportStaleMs = clamp(Number(p.screen.reportStaleMs) || 600000, 10000, 3600000)
  p.idleMs = clamp(Number(p.idleMs) || 30000, 5000, 3600000)
  for (const tier of ['L2', 'L1', 'L0']) {
    const hz = Number(p.stateHz[tier])
    p.stateHz[tier] = Number.isFinite(hz) && hz > 0 ? clamp(hz, 0.02, 20) : DEFAULTS.power.stateHz[tier]
  }
  p.chatLimit = clamp(Number(p.chatLimit) || 200, 1, 2000)
  p.chatLimitL0 = clamp(Number(p.chatLimitL0) || 50, 1, p.chatLimit)
  if (p.forcedMode !== null && !['L2', 'L1', 'L0'].includes(p.forcedMode)) {
    errors.push("power.forcedMode must be null, 'L2', 'L1' or 'L0'")
    p.forcedMode = null
  }
  if (!['tiny', 'short', 'normal', 'far'].includes(p.viewDistance.default)) {
    errors.push('power.viewDistance.default must be tiny|short|normal|far')
    p.viewDistance.default = 'normal'
  }

  const eat = cfg.eat
  eat.threshold = clamp(Number(eat.threshold) || 14, 0, 20)
  eat.disconnectAtHealth = clamp(Number(eat.disconnectAtHealth) || 0, 0, 20)
  eat.blacklist = Array.isArray(eat.blacklist) ? eat.blacklist.map(String) : []
  eat.whitelist = Array.isArray(eat.whitelist) ? eat.whitelist.map(String) : []

  const inv = cfg.inv
  inv.minEmptySlots = clamp(Number(inv.minEmptySlots) || 3, 1, 30)
  inv.intervalMs = clamp(Number(inv.intervalMs) || 300000, 10000, 86400000)
  inv.tossGapMs = clamp(Number(inv.tossGapMs) || 300, 100, 5000)
  inv.abortOnDamage = inv.abortOnDamage !== false
  inv.retainCategories = Array.isArray(inv.retainCategories) ? inv.retainCategories.map(String) : []
  if (!['lava', 'container'].includes(inv.dropPoint.type)) {
    errors.push("inv.dropPoint.type must be 'lava' or 'container'")
    inv.dropPoint.type = 'lava'
  }
  inv.dropPoint.set = Boolean(inv.dropPoint.set)
  inv.dropPoint.validate = inv.dropPoint.validate !== false
  inv.dropPoint.maxStandDistance = clamp(Number(inv.dropPoint.maxStandDistance) || 3, 1, 8)
  for (const axis of ['x', 'y', 'z']) {
    const n = Number(inv.dropPoint[axis])
    if (!Number.isFinite(n)) {
      errors.push(`inv.dropPoint.${axis} must be a number`)
      inv.dropPoint[axis] = 0
    } else {
      inv.dropPoint[axis] = n
    }
  }

  const rs = cfg.respawn
  rs.enabled = rs.enabled !== false
  rs.maxConsecutive = clamp(Number(rs.maxConsecutive) || 3, 1, 100)
  rs.windowMs = clamp(Number(rs.windowMs) || 600000, 10000, 86400000)
  rs.delayMs = clamp(Number(rs.delayMs) || 2000, 0, 60000)
  rs.returnToWaypoint = rs.returnToWaypoint !== false
  rs.waypoint = typeof rs.waypoint === 'string' ? rs.waypoint.slice(0, 32) : 'afk'

  const nav = cfg.nav
  nav.timeoutMs = clamp(Number(nav.timeoutMs) || 30000, 1000, 300000)
  nav.range = clamp(Number(nav.range) || 2, 0, 16)
  // Hard-locked by PRD F4 regardless of what the config file says.
  nav.canDig = false
  nav.allowParkour = false
  nav.allowFreeMotion = false

  if (!['look', 'swing'].includes(cfg.afk.action)) {
    errors.push("afk.action must be 'look' or 'swing'")
    cfg.afk.action = 'look'
  }
  cfg.afk.intervalMs = clamp(Number(cfg.afk.intervalMs) || 60000, 5000, 3600000)

  needString(cfg.ws.host, 'ws.host')
  cfg.ws.port = clamp(Number(cfg.ws.port) || 8765, 1, 65535)

  if (!isPlainObject(cfg.waypoints)) cfg.waypoints = {}

  return { config: cfg, errors }
}

/** Redacted view for the UI: never expose auth folder credentials etc. */
function publicView (cfg) {
  return cfg
}

class ConfigStore {
  constructor (filePath) {
    this.filePath = filePath
    this.config = normalize({}).config
  }

  load () {
    if (!fs.existsSync(this.filePath)) {
      this.config = normalize({}).config
      return this.config
    }
    const raw = fs.readFileSync(this.filePath, 'utf8')
    let parsed = {}
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(`config parse error: ${err.message}`)
    }
    const { config, errors } = normalize(parsed)
    if (errors.length) throw new Error(`config invalid: ${errors.join('; ')}`)
    this.config = config
    return config
  }

  save (patch) {
    const { config, errors } = normalize(patch, this.config)
    if (errors.length) {
      const err = new Error(errors.join('; '))
      err.validation = errors
      throw err
    }
    this.config = config
    this.persist()
    return config
  }

  persist () {
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.filePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2))
    fs.renameSync(tmp, this.filePath)
  }
}

module.exports = { DEFAULTS, ConfigStore, normalize, deepMerge, deepClone, publicView }
