'use strict'

/**
 * Bridge protocol v1 (frozen by PRD §5).
 *
 * Downstream: cmd / goto / stop / eat / toss / setMode / connect / config
 * Upstream:   state / chat / inv / nav / mode / log
 *
 * Every upstream message is built here so the UI and the core cannot drift.
 * Every downstream message is validated here; malformed input is rejected with
 * a ProtocolError instead of crashing the bot.
 */

class ProtocolError extends Error {
  constructor (message) {
    super(message)
    this.name = 'ProtocolError'
  }
}

// `disconnect` / `waypoint` / `screen` are additive v1 extensions (no field
// changes), needed by F8, P1 and the event-based screen authority. The frozen
// message shapes above are unchanged, and `hello` now carries `protoVersion`
// so an M2 app can detect a version mismatch on handshake. Upstream `signals`
// is the additive self-check table (live / unavailable / no_client).
const DOWN_TYPES = new Set(['cmd', 'goto', 'stop', 'eat', 'toss', 'setMode', 'connect', 'disconnect', 'waypoint', 'screen', 'config', 'ping'])
const PROTO_VERSION = 1
const UP_TYPES = new Set(['state', 'chat', 'inv', 'nav', 'mode', 'log', 'hello', 'error', 'notify', 'auth', 'config', 'signals'])

function num (value, name, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new ProtocolError(`${name} must be a finite number`)
  if (n < min || n > max) throw new ProtocolError(`${name} out of range [${min}, ${max}]`)
  return n
}

function str (value, name, { max = 4096, allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new ProtocolError(`${name} must be a string`)
  if (!allowEmpty && value.length === 0) throw new ProtocolError(`${name} must not be empty`)
  if (value.length > max) throw new ProtocolError(`${name} too long (max ${max})`)
  return value
}

function validateGoto (payload) {
  const x = num(payload.x, 'goto.x')
  const y = num(payload.y, 'goto.y')
  const z = num(payload.z, 'goto.z')
  const range = payload.range === undefined ? undefined : num(payload.range, 'goto.range', { min: 0, max: 16 })
  return { x, y, z, range }
}

function validateConnect (payload) {
  const out = {}
  if (payload.host !== undefined) out.host = str(payload.host, 'connect.host', { max: 253 })
  if (payload.username !== undefined) out.username = str(payload.username, 'connect.username', { max: 64 })
  if (payload.version !== undefined) {
    out.version = payload.version === false ? false : str(payload.version, 'connect.version', { max: 32 })
  }
  if (payload.port !== undefined) out.port = num(payload.port, 'connect.port', { min: 1, max: 65535 })
  if (payload.autoConnect !== undefined) out.autoConnect = Boolean(payload.autoConnect)
  return out
}

/** Returns { type, payload } or throws ProtocolError. */
function parseDown (raw) {
  if (!raw || typeof raw !== 'object') throw new ProtocolError('message must be an object')
  const type = raw.t
  if (typeof type !== 'string' || !DOWN_TYPES.has(type)) {
    throw new ProtocolError(`unknown downstream type: ${String(type)}`)
  }
  const p = raw
  switch (type) {
    case 'cmd':
      return { type, payload: { text: str(p.text, 'cmd.text', { max: 256 }) } }
    case 'goto':
      return { type, payload: validateGoto(p) }
    case 'stop':
      return { type, payload: {} }
    case 'eat':
      return { type, payload: {} }
    case 'toss':
      return {
        type,
        payload: {
          mode: p.mode === 'stack' ? 'stack' : 'cleanup',
          slot: p.slot === undefined ? undefined : num(p.slot, 'toss.slot', { min: 0, max: 45 })
        }
      }
    case 'setMode': {
      const mode = p.mode
      if (!['L2', 'L1', 'L0', 'auto'].includes(mode)) {
        throw new ProtocolError("setMode.mode must be L2|L1|L0|auto")
      }
      return { type, payload: { mode } }
    }
    case 'connect':
      return { type, payload: validateConnect(p) }
    case 'disconnect':
      return { type, payload: { reason: p.reason === undefined ? 'user' : str(p.reason, 'disconnect.reason', { max: 64 }) } }
    case 'screen': {
      if (typeof p.on !== 'boolean') throw new ProtocolError('screen.on must be a boolean')
      return { type, payload: { on: p.on } }
    }
    case 'waypoint': {
      const action = p.action
      if (!['save', 'go', 'delete', 'list'].includes(action)) {
        throw new ProtocolError('waypoint.action must be save|go|delete|list')
      }
      if (action === 'list') return { type, payload: { action } }
      return { type, payload: { action, name: str(p.name, 'waypoint.name', { max: 32 }) } }
    }
    case 'config': {
      const action = p.action
      if (!['get', 'set', 'import'].includes(action)) {
        throw new ProtocolError("config.action must be get|set|import")
      }
      if (action === 'get') return { type, payload: { action } }
      if (action === 'set' && (typeof p.patch !== 'object' || p.patch === null)) {
        throw new ProtocolError('config.patch must be an object')
      }
      if (action === 'import' && typeof p.json !== 'string') {
        throw new ProtocolError('config.json must be a string')
      }
      return { type, payload: { action, patch: p.patch, json: p.json } }
    }
    case 'ping':
      return { type, payload: { ts: p.ts === undefined ? Date.now() : num(p.ts, 'ping.ts') } }
    default:
      throw new ProtocolError(`unhandled downstream type: ${type}`)
  }
}

// ---- upstream builders -----------------------------------------------------

function stateMessage (s) {
  return {
    t: 'state',
    hp: s.hp,
    food: s.food,
    pos: s.pos ? [round2(s.pos.x), round2(s.pos.y), round2(s.pos.z)] : null,
    yaw: round2(s.yaw || 0),
    nav: Boolean(s.nav),
    mode: s.mode,
    online: s.online ? Math.floor(s.online / 1000) : 0,
    connected: Boolean(s.connected),
    ...(s.extra || {})
  }
}

function chatMessage (m) {
  return {
    t: 'chat',
    ts: m.ts || Date.now(),
    kind: m.kind || 'chat', // chat | system | action | whisper
    from: m.from || '',
    text: m.text || '',
    ...(m.raw ? { raw: m.raw } : {})
  }
}

function invMessage (items, emptySlots) {
  return { t: 'inv', items, empty: emptySlots }
}

function navMessage (nav) {
  return { t: 'nav', ...nav }
}

function modeMessage (mode) {
  return {
    t: 'mode',
    mode: mode.mode,
    forced: mode.forced,
    signals: mode.signals,
    candidate: mode.candidate,
    since: mode.lastChangeAt
  }
}

function logMessage (entry) {
  return entry
}

function helloMessage (payload) {
  return { t: 'hello', protocol: PROTO_VERSION, protoVersion: PROTO_VERSION, ...payload }
}

function errorMessage (message, code = 'error') {
  return { t: 'error', code, msg: String(message) }
}

function notifyMessage (level, message) {
  return { t: 'notify', level, msg: String(message), ts: Date.now() }
}

function signalsMessage (signals) {
  return { t: 'signals', signals }
}

function round2 (n) {
  return Math.round(Number(n) * 100) / 100
}

module.exports = {
  DOWN_TYPES,
  UP_TYPES,
  PROTO_VERSION,
  ProtocolError,
  parseDown,
  stateMessage,
  chatMessage,
  invMessage,
  navMessage,
  modeMessage,
  logMessage,
  helloMessage,
  errorMessage,
  notifyMessage,
  signalsMessage
}
