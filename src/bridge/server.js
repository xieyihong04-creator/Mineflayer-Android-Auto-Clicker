'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { WebSocketServer } = require('ws')
const {
  parseDown,
  ProtocolError,
  helloMessage,
  errorMessage,
  PROTO_VERSION
} = require('./protocol')
const { normalize } = require('../config')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
}

/**
 * localhost WebSocket + static file server.
 * The bridge is the ONLY contract between UI and core; protocol v1 is frozen
 * in ./protocol.js so both sides can evolve independently (PRD §2).
 */
class BridgeServer {
  constructor ({ manager, configStore, logger, webRoot, host = '127.0.0.1', port = 8765 }) {
    this.manager = manager
    this.configStore = configStore
    this.logger = logger
    this.webRoot = path.resolve(webRoot)
    this.host = host
    this.port = port
    this.server = null
    this.wss = null
    this.clients = new Set()
    this.clientSeq = 0
    this.onManagerMessage = (msg) => this.broadcast(msg)
    this.onManagerStatus = (status) => this.broadcast({ t: 'status', status })
  }

  async start () {
    this.server = http.createServer((req, res) => this.handleHttp(req, res))
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' })
    this.wss.on('connection', (ws, req) => this.handleClient(ws, req))

    this.manager.on('message', this.onManagerMessage)
    this.manager.on('status', this.onManagerStatus)

    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', reject)
        resolve()
      })
    })
    const addr = this.server.address()
    this.port = addr.port
    this.logger.info(`bridge listening on http://${this.host}:${this.port} (ws://${this.host}:${this.port}/ws)`)
    return addr
  }

  async close () {
    this.manager.removeListener('message', this.onManagerMessage)
    this.manager.removeListener('status', this.onManagerStatus)
    for (const ws of this.clients) {
      try { ws.close() } catch {}
    }
    this.clients.clear()
    if (this.wss) await new Promise((resolve) => this.wss.close(resolve))
    if (this.server) await new Promise((resolve) => this.server.close(resolve))
  }

  handleHttp (req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    if (url.pathname === '/api/health') {
      const body = JSON.stringify({
        ok: true,
        status: this.manager.status,
        mode: this.manager.tier.mode,
        clients: this.clients.size,
        protoVersion: PROTO_VERSION,
        // Same self-check table as hello.signals, so a real-device check is
        // `curl -s localhost:8765/api/health` instead of a screenshot.
        signals: this.manager.signalTable(),
        // Raw values + power telemetry: the numbers the on-device report needs.
        power: this.manager.powerSnapshot()
      })
      res.writeHead(200, { 'content-type': MIME['.json'] })
      res.end(body)
      return
    }

    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/index.html'
    const filePath = path.resolve(this.webRoot, `.${pathname}`)
    if (!filePath.startsWith(this.webRoot + path.sep) && filePath !== path.join(this.webRoot, 'index.html')) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      const ext = path.extname(filePath)
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': 'no-store'
      })
      res.end(data)
    })
  }

  handleClient (ws) {
    // Every socket is one observer. Multi-client rule (PRD verdict #3):
    // any client reporting screen-on wins; a disconnect re-aggregates the
    // remaining set instead of leaving the last report behind.
    const clientId = `ui-${++this.clientSeq}`
    ws.__clientId = clientId
    this.clients.add(ws)
    this.manager.setUiClients(this.clients.size)
    const hello = helloMessage({ ...this.manager.helloPayload(), clientId })
    this.send(ws, hello)
    this.logger.info(`ui client ${clientId} connected (${this.clients.size} total)`)

    ws.on('message', (raw) => {
      // Any upstream traffic proves the page is alive; refresh its screen
      // report timestamp so a watching user is never treated as stale.
      this.manager.touchScreen(clientId)
      this.onMessage(ws, raw).catch((err) => {
        this.send(ws, errorMessage(err.message, 'internal'))
      })
    })
    const drop = () => {
      if (!this.clients.delete(ws)) return
      this.manager.dropScreenClient(clientId)
      this.manager.setUiClients(this.clients.size)
    }
    ws.on('close', drop)
    ws.on('error', drop)
  }

  async onMessage (ws, raw) {
    let parsed
    try {
      parsed = JSON.parse(raw.toString())
    } catch {
      this.send(ws, errorMessage('invalid JSON', 'bad_json'))
      return
    }
    const id = parsed && parsed.id
    try {
      const { type, payload } = parseDown(parsed)
      const result = await this.dispatch(type, payload, ws)
      if (result && result.ok === false && result.reason && id !== undefined) {
        this.send(ws, { t: 'ack', id, ok: false, error: String(result.reason) })
        this.send(ws, { t: 'error', code: 'command', msg: String(result.reason) })
        return
      }
      if (id !== undefined) this.send(ws, { t: 'ack', id, ok: true, ...(result || {}) })
    } catch (err) {
      if (err instanceof ProtocolError) {
        this.send(ws, { t: 'ack', id, ok: false, error: err.message })
        this.send(ws, errorMessage(err.message, 'protocol'))
      } else {
        this.send(ws, { t: 'ack', id, ok: false, error: err.message })
        this.logger.warn(`command failed: ${err.message}`)
      }
    }
  }

  async dispatch (type, payload, ws = null) {
    switch (type) {
      case 'cmd':
        return this.manager.sendChat(payload.text)
      case 'goto':
        return this.manager.goto(payload.x, payload.y, payload.z, payload.range)
      case 'stop':
        return this.manager.stop()
      case 'eat':
        return this.manager.eat()
      case 'toss':
        return this.manager.toss(payload)
      case 'setMode': {
        // Persist the manual override so a restart keeps the user's choice.
        this.configStore.save({ power: { forcedMode: payload.mode === 'auto' ? null : payload.mode } })
        return this.manager.setMode(payload.mode)
      }
      case 'connect': {
        const patch = {
          server: {
            ...(payload.host !== undefined ? { host: payload.host } : {}),
            ...(payload.port !== undefined ? { port: payload.port } : {}),
            ...(payload.version !== undefined ? { version: payload.version } : {}),
            ...(payload.username !== undefined ? { username: payload.username } : {})
          }
        }
        if (payload.host !== undefined || payload.port !== undefined || payload.version !== undefined || payload.username !== undefined) {
          this.configStore.save(patch)
          this.manager.applyConfig()
        }
        return this.manager.connect(payload)
      }
      case 'disconnect':
        this.manager.disconnect({ reason: payload.reason })
        return { ok: true }
      case 'screen':
        return { ok: true, mode: this.manager.reportScreen(payload.on, (ws && ws.__clientId) || 'default') }
      // M2 native signals from the WebView shell. Additive in v1: older clients
      // never send them, and nothing depends on them being present.
      case 'thermal':
        return { ok: true, mode: this.manager.reportNativeThermal(payload.value) }
      case 'powerSave':
        return { ok: true, mode: this.manager.reportNativePowerSave(payload.on) }
      // M3: sticky ACTION_BATTERY_CHANGED. Native is the primary battery
      // source inside the APK (sysfs is SELinux-denied, Termux:API absent);
      // the tier machine is untouched, it just gets a real reading again.
      case 'battery':
        return { ok: true, mode: this.manager.reportNativeBattery(payload) }
      case 'waypoint': {
        if (payload.action === 'save') return this.manager.saveWaypoint(payload.name)
        if (payload.action === 'go') return this.manager.goWaypoint(payload.name)
        if (payload.action === 'delete') return this.manager.deleteWaypoint(payload.name)
        return { ok: true, waypoints: this.configStore.config.waypoints }
      }
      case 'config': {
        if (payload.action === 'get') {
          this.sendAll({ t: 'config', action: 'get', config: this.configStore.config })
          return { ok: true }
        }
        if (payload.action === 'set') {
          if (payload.patch && payload.patch.inv && payload.patch.inv.dropPoint) {
            const merged = normalize(payload.patch, this.configStore.config)
            if (merged.errors.length) throw new Error(merged.errors.join('; '))
            // Refuse a drop point that would walk the bot into lava or that is
            // unreachable, instead of failing silently 30s into the walk.
            const check = this.manager.checkDropPoint(merged.config.inv.dropPoint)
            if (!check.ok) throw new Error(`丢弃点不可用: ${check.reason}`)
            if (!check.checked) this.send(ws, { t: 'notify', level: 'warn', msg: 'bot 未在线，丢弃点仅保存未校验' })
            this.configStore.save(payload.patch)
            this.manager.applyConfig()
            this.sendAll({ t: 'config', action: 'set', config: this.configStore.config })
            return { ok: true, dropPoint: check }
          }
          this.configStore.save(payload.patch)
          this.manager.applyConfig()
          this.sendAll({ t: 'config', action: 'set', config: this.configStore.config })
          return { ok: true }
        }
        if (payload.action === 'import') {
          let parsed
          try {
            parsed = JSON.parse(payload.json)
          } catch (err) {
            throw new Error(`config JSON 解析失败: ${err.message}`)
          }
          this.configStore.save(parsed)
          this.manager.applyConfig()
          this.sendAll({ t: 'config', action: 'import', config: this.configStore.config })
          return { ok: true }
        }
        return { ok: false }
      }
      case 'ping':
        return { pong: Date.now(), ts: payload.ts }
      default:
        throw new Error(`unhandled: ${type}`)
    }
  }

  send (ws, msg) {
    if (ws.readyState !== 1) return
    try {
      ws.send(JSON.stringify(msg))
    } catch {}
  }

  sendAll (msg) {
    this.broadcast(msg)
  }

  broadcast (msg) {
    if (this.clients.size === 0) return
    const data = JSON.stringify(msg)
    for (const ws of this.clients) {
      if (ws.readyState === 1) {
        try { ws.send(data) } catch {}
      }
    }
  }
}

module.exports = { BridgeServer }
