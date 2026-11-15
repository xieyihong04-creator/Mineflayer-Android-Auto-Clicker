'use strict'

const path = require('node:path')
const EventEmitter = require('node:events')
const mineflayer = require('mineflayer')
const { Backoff } = require('../util/backoff')
const { ChatStore } = require('./chat')
const { Navigator } = require('./nav')
const { AutoEater } = require('./eating')
const { InventoryManager } = require('./inventory')
const { AfkKeeper } = require('./afk')
const { emptySlotCount, snapshotInventory } = require('./items')
const { NetworkWatcher } = require('../util/network')
const {
  stateMessage,
  modeMessage,
  notifyMessage
} = require('../bridge/protocol')

const VIEW_DISTANCE = {
  tiny: 'tiny',
  short: 'short',
  normal: 'normal',
  far: 'far'
}

class BotManager extends EventEmitter {
  constructor ({ configStore, logger, tier, createBot = mineflayer.createBot, now = () => Date.now(), networkWatcher = null, nav = null }) {
    super()
    this.configStore = configStore
    this.logger = logger
    this.tier = tier
    this.createBot = createBot
    this.now = now
    this.bot = null
    this.status = 'offline' // offline | connecting | online | reconnecting | suspended
    this.desiredOnline = false
    this.suspended = false
    this.onlineSince = 0
    this.lastError = null
    this.attempts = 0
    this.reconnectTimer = null
    this.stateTimer = null
    this.idleTimer = null
    this.stateIntervalMs = 500
    this.lastPos = null
    this.lastMoveAt = now()
    this.lastConnectOptions = null
    this.backoff = new Backoff({
      baseMs: configStore.config.reconnect.baseMs,
      maxMs: configStore.config.reconnect.maxMs
    })
    this.chat = new ChatStore({ limit: configStore.config.power.chatLimit, maxLimit: 2000 })
    this.nav = nav || new Navigator({
      getBot: () => this.bot,
      config: this.config,
      logger,
      emit: (msg) => this.emit('message', msg)
    })
    this.eater = new AutoEater({
      getBot: () => this.bot,
      config: this.config,
      logger,
      nav: this.nav,
      notify: (level, msg) => this.notify(level, msg),
      emit: (msg) => this.emit('message', msg)
    })
    this.inventory = new InventoryManager({
      getBot: () => this.bot,
      config: this.config,
      logger,
      nav: this.nav,
      getMode: () => this.tier.mode,
      notify: (level, msg) => this.notify(level, msg),
      emit: (msg) => this.emit('message', msg)
    })
    this.afk = new AfkKeeper({
      getBot: () => this.bot,
      config: this.config,
      logger,
      getMode: () => this.tier.mode
    })
    this.networkWatcher = networkWatcher || new NetworkWatcher({
      onChange: () => this.onNetworkChange()
    })
  }

  get config () {
    return this.configStore.config
  }

  // ---------------------------------------------------------------- lifecycle

  start () {
    this.networkWatcher.start()
    this.startIdleLoop()
    this.startStateLoop()
    this.inventory.start()
    this.afk.start()
    this.applyModeActions(this.tier.mode, null)
  }

  destroy () {
    this.desiredOnline = false
    this.clearTimers()
    this.networkWatcher.stop()
    this.inventory.stop()
    this.afk.stop()
    if (this.bot) {
      try { this.bot.end() } catch {}
      this.bot = null
    }
  }

  clearTimers () {
    for (const key of ['reconnectTimer', 'stateTimer', 'idleTimer']) {
      if (this[key]) {
        clearTimeout(this[key])
        clearInterval(this[key])
        this[key] = null
      }
    }
  }

  /** F1 connect. Also used by the reconnection timer. */
  connect (options = {}) {
    const cfg = this.config
    const merged = {
      host: options.host || cfg.server.host,
      port: Number(options.port || cfg.server.port),
      version: options.version !== undefined ? options.version : cfg.server.version,
      username: options.username || cfg.server.username
    }
    if (!merged.host) {
      this.lastError = 'server host is empty'
      this.emit('message', notifyMessage('warn', '请先填写服务器地址'))
      return { ok: false, reason: 'no_host' }
    }
    if (!merged.username) {
      merged.username = cfg.auth.type === 'offline' ? 'AFK_Bot' : ''
    }
    if (!merged.username) {
      this.lastError = 'username is empty'
      this.emit('message', notifyMessage('warn', '请先填写微软账号用户名（邮箱）'))
      return { ok: false, reason: 'no_username' }
    }

    this.desiredOnline = true
    this.suspended = false
    this.lastConnectOptions = merged
    this.clearReconnectTimer()
    if (this.bot) {
      const old = this.bot
      this.bot = null
      try { old.end() } catch {}
    }

    this.setStatus('connecting')
    const botOptions = {
      host: merged.host,
      port: merged.port,
      username: merged.username,
      auth: cfg.auth.type === 'microsoft' ? 'microsoft' : 'offline',
      profilesFolder: path.resolve(cfg.auth.profilesFolder),
      viewDistance: VIEW_DISTANCE[cfg.power.viewDistance.default] || 'normal',
      hideErrors: true,
      checkTimeoutInterval: 30000,
      onMsaCode: (data) => this.onMsaCode(data)
    }
    if (merged.version !== false && merged.version !== undefined) botOptions.version = merged.version

    let bot
    try {
      bot = this.createBot(botOptions)
    } catch (err) {
      this.lastError = err.message
      this.logger.error(`createBot failed: ${err.message}`)
      this.scheduleReconnect('create_failed')
      return { ok: false, reason: err.message }
    }

    this.bot = bot
    this.attempts += 1
    try {
      this.attachBot(bot)
    } catch (err) {
      this.lastError = err.message
      this.logger.error(`attach failed: ${err.message}`)
      this.bot = null
      try { bot.end() } catch {}
      this.scheduleReconnect('attach_failed')
      return { ok: false, reason: err.message }
    }
    this.logger.info(`connecting to ${merged.host}:${merged.port} as ${merged.username} (${botOptions.auth})`)
    return { ok: true }
  }

  attachBot (bot) {
    const fresh = () => this.bot === bot

    bot.on('login', () => {
      if (!fresh()) return
      this.logger.info('login accepted')
    })

    bot.on('spawn', () => {
      if (!fresh()) return
      this.onlineSince = this.now()
      this.lastMoveAt = this.now()
      this.lastPos = bot.entity ? bot.entity.position.clone() : null
      this.backoff.reset()
      this.setStatus('online')
      this.logger.info('spawned: bot is online')
      this.emit('message', stateMessage(this.buildState()))
      this.emitInventory()
    })

    bot.on('end', (reason) => {
      if (!fresh()) return
      const wasOnline = this.status === 'online'
      this.logger.warn(`connection ended: ${describeReason(reason)}`)
      this.onlineSince = 0
      this.bot = null
      this.setStatus('offline')
      if (wasOnline) this.emit('message', stateMessage(this.buildState()))
      if (this.desiredOnline && !this.suspended) this.scheduleReconnect('end')
    })

    bot.on('error', (err) => {
      if (!fresh()) return
      this.lastError = err.message
      this.logger.warn(`socket error: ${err.message}`)
    })

    bot.on('kicked', (reason) => {
      if (!fresh()) return
      const text = describeReason(reason)
      this.lastError = `kicked: ${text}`
      this.logger.warn(`kicked by server: ${text}`)
      this.notify('warn', `被服务器踢出：${text}`)
    })

    bot.on('death', () => {
      if (!fresh()) return
      this.logger.warn('bot died')
      this.notify('warn', '角色死亡')
    })

    bot.on('health', () => {
      if (!fresh()) return
      this.emit('message', stateMessage(this.buildState({ minimal: this.tier.mode === 'L0' })))
    })

    bot.on('messagestr', (message, position) => {
      if (!fresh()) return
      const msg = this.chat.pushLine(message, position)
      this.emit('message', msg)
    })

    let invTimer = null
    const scheduleInv = () => {
      if (invTimer) return
      invTimer = setTimeout(() => {
        invTimer = null
        if (fresh()) this.emitInventory()
      }, 500)
      if (invTimer.unref) invTimer.unref()
    }
    bot.on('playerCollect', scheduleInv)
    bot.on('windowUpdate', scheduleInv)

    this.nav.setup(bot)
    this.eater.attach(bot)
    this.inventory.attach(bot)
    this.nav.emit = (msg) => this.emit('message', msg)
  }

  scheduleReconnect (reason) {
    if (!this.desiredOnline || this.suspended) return
    if (!this.config.reconnect.enabled) return
    const delay = this.backoff.next()
    this.setStatus('reconnecting')
    this.logger.warn(`reconnect #${this.attempts} in ${delay}ms (${reason})`)
    this.clearReconnectTimer()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.desiredOnline || this.suspended) return
      this.connect(this.lastConnectOptions || {})
    }, delay)
    if (this.reconnectTimer.unref) this.reconnectTimer.unref()
  }

  clearReconnectTimer () {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /** Explicit user disconnect (UI button). */
  disconnect ({ reason = 'user', keepDesired = false } = {}) {
    this.desiredOnline = keepDesired
    this.clearReconnectTimer()
    const bot = this.bot
    this.bot = null
    this.onlineSince = 0
    this.nav.stop('disconnect')
    if (bot) {
      try { bot.quit(reason) } catch {
        try { bot.end() } catch {}
      }
    }
    this.setStatus('offline')
    this.logger.info(`disconnected (${reason})`)
    this.emit('message', stateMessage(this.buildState()))
  }

  onNetworkChange () {
    this.logger.info('network interface changed -> immediate reconnect')
    this.emit('message', notifyMessage('info', '网络切换，立即重连'))
    this.backoff.reset()
    if (!this.desiredOnline || this.suspended) return
    this.clearReconnectTimer()
    const bot = this.bot
    this.bot = null
    if (bot) {
      try { bot.end() } catch {}
    }
    this.connect(this.lastConnectOptions || {})
  }

  onMsaCode (data) {
    const info = {
      url: data.verification_uri || 'https://microsoft.com/link',
      code: data.user_code,
      expiresIn: data.expires_in
    }
    this.logger.warn(`Microsoft device code: ${info.code} @ ${info.url}`)
    this.emit('message', { t: 'auth', ...info })
    this.notify('info', `微软设备码登录：${info.code}（${info.url}）`)
  }

  setStatus (status) {
    this.status = status
    this.emit('status', this.statusSnapshot())
  }

  statusSnapshot () {
    return {
      status: this.status,
      onlineSince: this.onlineSince,
      attempts: this.attempts,
      lastError: this.lastError,
      username: this.bot && this.bot.username ? this.bot.username : null,
      server: this.lastConnectOptions
        ? `${this.lastConnectOptions.host}:${this.lastConnectOptions.port}`
        : this.config.server.host ? `${this.config.server.host}:${this.config.server.port}` : null,
      suspended: this.suspended,
      desiredOnline: this.desiredOnline
    }
  }

  // ------------------------------------------------------------ power tiers

  /** Called by the power loop every few seconds. */
  updatePower (signals) {
    const next = this.tier.update({
      ...signals,
      navActive: this.nav.active,
      idle: this.isIdle()
    })
    return next
  }

  isIdle () {
    const bot = this.bot
    if (!bot || !bot.entity) return this.now() - this.lastMoveAt >= this.config.power.idleMs
    const pos = bot.entity.position
    if (!this.lastPos || pos.distanceTo(this.lastPos) > 0.05) {
      this.lastPos = pos.clone()
      this.lastMoveAt = this.now()
      return false
    }
    return this.now() - this.lastMoveAt >= this.config.power.idleMs
  }

  /** F7: apply the side effects of a tier switch. Called by the tier controller. */
  applyModeActions (mode, prev) {
    const cfg = this.config
    if (prev) this.logger.info(`power tier ${prev} -> ${mode}`)

    const limit = mode === 'L0' ? cfg.power.chatLimitL0 : cfg.power.chatLimit
    this.chat.setLimit(limit)

    const fileLog = mode === 'L2' && cfg.power.logToFile
    if (this.logger.setFileEnabled) this.logger.setFileEnabled(fileLog)

    if (mode === 'L0') {
      this.setViewDistance(cfg.power.viewDistance.l0)
      this.inventory.stop()
    } else if (mode !== 'L3') {
      this.setViewDistance(cfg.power.viewDistance.default)
      this.inventory.start()
    }

    this.restartStateLoop(mode)
    this.emit('message', modeMessage(this.tier.snapshot))

    if (mode === 'L3') {
      this.suspended = true
      this.emit('message', notifyMessage('warn', '电量低于阈值，已主动断开连接'))
      this.disconnect({ reason: 'power_l3', keepDesired: true })
      this.setStatus('suspended')
    } else if (prev === 'L3' || this.suspended) {
      this.suspended = false
      if (this.desiredOnline && !this.bot) {
        this.logger.info('leaving L3 -> reconnecting')
        this.connect(this.lastConnectOptions || {})
      }
    }
  }

  /**
   * PRD §4: lower view distance via the `settings` packet so the SERVER stops
   * sending chunks. Never delete local world data (pathfinder would go blind
   * and the server does not resend).
   */
  setViewDistance (distance) {
    const bot = this.bot
    if (!bot || !bot.setSettings) return
    const target = VIEW_DISTANCE[distance] || 'normal'
    if (bot.settings && bot.settings.viewDistance === target) return
    try {
      bot.setSettings({ viewDistance: target })
      this.logger.info(`view distance -> ${target}`)
    } catch (err) {
      this.logger.warn(`set view distance failed: ${err.message}`)
    }
  }

  restartStateLoop (mode = this.tier.mode) {
    if (this.stateTimer) {
      clearInterval(this.stateTimer)
      this.stateTimer = null
    }
    const hz = this.config.power.stateHz[mode] || 2
    this.stateIntervalMs = Math.max(50, Math.round(1000 / hz))
    this.stateTimer = setInterval(() => {
      if (!this.bot) return
      this.emit('message', stateMessage(this.buildState({ minimal: this.tier.mode === 'L0' })))
    }, this.stateIntervalMs)
    if (this.stateTimer.unref) this.stateTimer.unref()
  }

  startStateLoop () {
    this.restartStateLoop()
  }

  startIdleLoop () {
    if (this.idleTimer) clearInterval(this.idleTimer)
    this.idleTimer = setInterval(() => {
      this.isIdle()
    }, 1000)
    if (this.idleTimer.unref) this.idleTimer.unref()
  }

  buildState ({ minimal = false } = {}) {
    const bot = this.bot
    const base = {
      hp: bot && Number.isFinite(bot.health) ? bot.health : null,
      food: bot && Number.isFinite(bot.food) ? bot.food : null,
      pos: bot && bot.entity ? bot.entity.position : null,
      yaw: bot && bot.entity ? bot.entity.yaw : 0,
      nav: this.nav.active,
      mode: this.tier.mode,
      connected: this.status === 'online',
      online: this.onlineSince ? this.now() - this.onlineSince : 0
    }
    if (minimal) return base
    return {
      ...base,
      extra: {
        forced: this.tier.forcedMode,
        status: this.status,
        empty: bot && bot.inventory ? emptySlotCount(bot) : null
      }
    }
  }

  emitInventory () {
    if (!this.bot || !this.bot.inventory) return
    this.emit('message', {
      t: 'inv',
      items: snapshotInventory(this.bot),
      empty: emptySlotCount(this.bot)
    })
  }

  notify (level, msg) {
    this.emit('message', notifyMessage(level, msg))
  }

  // ------------------------------------------------------------------ actions

  sendChat (text) {
    if (!this.bot) return { ok: false, reason: 'offline' }
    this.bot.chat(text)
    const msg = this.chat.push({ kind: 'self', from: this.bot.username || 'me', text, raw: text })
    this.emit('message', msg)
    this.logger.info(`chat -> ${text}`)
    return { ok: true }
  }

  async goto (x, y, z, range) {
    if (!this.bot) return { ok: false, reason: 'offline' }
    try {
      const goal = await this.nav.goto(x, y, z, range, { reason: 'user' })
      this.logger.info(`goto ${goal.x},${goal.y},${goal.z} range=${goal.range}`)
      return { ok: true, goal }
    } catch (err) {
      return { ok: false, reason: err.message }
    }
  }

  stop () {
    this.nav.stop('user')
    return { ok: true }
  }

  async eat () {
    return this.eater.check('manual', { force: true })
  }

  async toss (payload = {}) {
    if (payload.mode === 'stack') {
      const bot = this.bot
      if (!bot) return { ok: false, reason: 'offline' }
      if (!Number.isInteger(payload.slot)) return { ok: false, reason: 'slot_required' }
      const item = bot.inventory.slots[payload.slot]
      if (!item) return { ok: false, reason: 'empty_slot' }
      await bot.tossStack(item)
      this.emitInventory()
      return { ok: true }
    }
    return this.inventory.maybeCleanup({ force: true, reason: 'manual' })
  }

  setMode (mode) {
    if (mode === 'auto') {
      this.tier.setForcedMode(null)
    } else {
      this.tier.setForcedMode(mode)
    }
    // Forcing the tier that is already active does not fire onChange, but the
    // UI still needs to see the "forced" badge.
    this.emit('message', modeMessage(this.tier.snapshot))
    return { ok: true, mode: this.tier.mode, forced: this.tier.forcedMode }
  }

  // --------------------------------------------------------------- P1 helpers

  saveWaypoint (name) {
    const bot = this.bot
    if (!bot || !bot.entity) return { ok: false, reason: 'offline' }
    const clean = String(name || '').trim().slice(0, 32)
    if (!clean) return { ok: false, reason: 'name_required' }
    const p = bot.entity.position
    this.configStore.save({
      waypoints: {
        ...this.config.waypoints,
        [clean]: { x: p.x, y: p.y, z: p.z }
      }
    })
    this.logger.info(`waypoint saved: ${clean}`)
    return { ok: true, waypoint: { name: clean, x: p.x, y: p.y, z: p.z } }
  }

  async goWaypoint (name) {
    const wp = this.config.waypoints[name]
    if (!wp) return { ok: false, reason: 'unknown_waypoint' }
    return this.goto(wp.x, wp.y, wp.z, this.config.nav.range)
  }

  deleteWaypoint (name) {
    if (!this.config.waypoints[name]) return { ok: false, reason: 'unknown_waypoint' }
    const next = { ...this.config.waypoints }
    delete next[name]
    this.configStore.save({ waypoints: next })
    return { ok: true }
  }

  /** Re-apply config after an import / edit. */
  applyConfig () {
    this.backoff = new Backoff({
      baseMs: this.config.reconnect.baseMs,
      maxMs: this.config.reconnect.maxMs
    })
    this.chat.setLimit(this.tier.mode === 'L0' ? this.config.power.chatLimitL0 : this.config.power.chatLimit)
    this.inventory.start()
    this.afk.start()
    this.restartStateLoop()
    return { ok: true }
  }

  /** Snapshot sent to a freshly connected UI client. */
  helloPayload () {
    return {
      status: this.statusSnapshot(),
      mode: this.tier.snapshot,
      config: this.config,
      chat: this.chat.history(),
      inv: this.bot && this.bot.inventory
        ? { items: snapshotInventory(this.bot), empty: emptySlotCount(this.bot) }
        : { items: [], empty: null },
      nav: this.nav.snapshot(),
      logs: this.logger ? this.logger.recent(100) : []
    }
  }
}

function describeReason (reason) {
  if (reason === undefined || reason === null) return 'none'
  if (typeof reason === 'string') return reason
  try {
    if (reason.toString && reason.toString !== Object.prototype.toString) return reason.toString()
    return JSON.stringify(reason)
  } catch {
    return String(reason)
  }
}

module.exports = { BotManager, describeReason }
