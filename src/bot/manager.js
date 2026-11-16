'use strict'

const path = require('node:path')
const net = require('node:net')
const EventEmitter = require('node:events')
const mineflayer = require('mineflayer')
const { Backoff } = require('../util/backoff')
const { resolveTarget } = require('../util/resolve')
const { ChatStore } = require('./chat')
const { Navigator } = require('./nav')
const { AutoEater } = require('./eating')
const { InventoryManager } = require('./inventory')
const { AfkKeeper } = require('./afk')
const { RespawnGuard } = require('./respawn')
const { validateDropPoint } = require('./droppoint')
const { emptySlotCount, snapshotInventory } = require('./items')
const { NetworkWatcher } = require('../util/network')
const { ScreenStateTracker } = require('../power/screen')
const {
  stateMessage,
  modeMessage,
  notifyMessage,
  signalsMessage
} = require('../bridge/protocol')

const VIEW_DISTANCE = {
  tiny: 'tiny',
  short: 'short',
  normal: 'normal',
  far: 'far'
}

class BotManager extends EventEmitter {
  constructor ({ configStore, logger, tier, createBot = mineflayer.createBot, now = () => Date.now(), networkWatcher = null, nav = null, screen = null, resolve = resolveTarget }) {
    super()
    this.configStore = configStore
    this.logger = logger
    this.tier = tier
    this.createBot = createBot
    this.resolve = resolve
    this.connectToken = 0
    this.now = now
    this.bot = null
    this.status = 'offline' // offline | connecting | online | reconnecting | suspended | halted
    this.desiredOnline = false
    this.suspended = false
    this.halted = false
    this.haltReason = null
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
    this.lastSignals = {
      battery: null,
      charging: null,
      thermal: null,
      thermalDelta: null,
      thermalBaselineC: null,
      powerSave: null
    }
    // M2 native shell reports. Kept separately from the polled sensor values so
    // a stale native reading can expire and fall back to sysfs/settings instead
    // of pinning the tier forever if the app dies. Battery is a whole reading
    // (level/charging/tempC/chargeCounterUah/cycle) because the platform sends
    // all of it in one broadcast.
    this.native = {
      thermal: null,
      thermalAt: 0,
      powerSave: null,
      powerSaveAt: 0,
      battery: null,
      batteryAt: 0
    }
    this.nativeStaleMs = 300000
    this.lastSignalTableJson = null
    this.uiClients = 0
    this.returnAfterReconnect = false
    this.backoff = new Backoff({
      baseMs: configStore.config.reconnect.baseMs,
      maxMs: configStore.config.reconnect.maxMs
    })
    this.screen = screen || new ScreenStateTracker({
      getConfig: () => this.config,
      now
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
      emit: (msg) => this.emit('message', msg),
      // Food exhaustion + low HP stops the bot. This is a SEPARATE halt source
      // from F9: L3 exit / charging must not clear either of them.
      onStarving: (info) => this.halt('food_exhausted', `食物耗尽且生命 ${info.health}，已停机待补食物`)
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
    this.respawn = new RespawnGuard({
      getBot: () => this.bot,
      getConfig: () => this.config,
      logger,
      notify: (level, msg) => this.notify(level, msg),
      onHalt: (reason, deaths) => this.halt(reason, `连续死亡 ${deaths} 次，已停机`),
      now
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
    this.connectToken += 1
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
    if (this.halted) {
      this.halted = false
      this.haltReason = null
      this.respawn.reset()
      this.logger.info('halt cleared by manual connect')
    }
    this.lastConnectOptions = merged
    this.clearReconnectTimer()
    if (this.bot) {
      const old = this.bot
      this.bot = null
      try { old.end() } catch {}
    }

    this.setStatus('connecting')
    // Resolve first, then create the bot. The bot's `host` stays exactly what
    // the user typed (the handshake serverHost): TCPShield/NeoProtect route by
    // hostname and reject an IP with "Invalid hostname"; only the socket goes
    // to the resolved address. See src/util/resolve.js.
    const token = ++this.connectToken
    this.resolve(merged.host, merged.port, (err, target) => {
      if (token !== this.connectToken) return
      if (err) {
        this.lastError = err.message
        this.logger.warn(`resolve failed: ${err.message}`)
        this.emit('message', notifyMessage('warn', err.message))
        this.scheduleReconnect('resolve_failed')
        return
      }
      this.launch(merged, target)
    })
    return { ok: true }
  }

  /** Creates the bot once the address behind `merged.host` is known. */
  launch (merged, target) {
    const cfg = this.config
    const botOptions = {
      // Deliberately the typed hostname, not target.address.
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
    // Overrides minecraft-protocol's tcp_dns module, which would otherwise
    // replace options.host with the SRV target and re-resolve via c-ares.
    botOptions.connect = (client) => {
      const socket = net.connect(target.port, target.address)
      client.setSocket(socket)
    }
    if (merged.version !== false && merged.version !== undefined) botOptions.version = merged.version

    const route = target.srv
      ? `${merged.host}:${merged.port} -> srv ${target.srv} (${target.via}) -> ${target.address}:${target.port}`
      : `${merged.host}:${merged.port} -> ${target.address}:${target.port} (${target.via})`
    this.logger.info(`resolved ${route}`)

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
      this.emitState()
      this.emitInventory()
      // F9: after a death or a reconnect the bot is standing at the world spawn;
      // walking back to the AFK waypoint is what makes 挂机 actually resume.
      const fromDeath = this.respawn.consumeReturnRequest()
      if (fromDeath || this.returnAfterReconnect) {
        this.returnAfterReconnect = false
        this.returnToWaypoint(fromDeath ? 'respawn' : 'reconnect')
      }
    })

    bot.on('end', (reason) => {
      if (!fresh()) return
      const wasOnline = this.status === 'online'
      this.logger.warn(`connection ended: ${describeReason(reason)}`)
      this.onlineSince = 0
      this.bot = null
      this.setStatus('offline')
      if (wasOnline) {
        this.emitState()
        // A server restart / kick drops us at the world spawn on reconnect.
        this.returnAfterReconnect = this.config.respawn.returnToWaypoint
      }
      if (this.desiredOnline && !this.suspended && !this.halted) this.scheduleReconnect('end')
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
      // F9 lives in RespawnGuard (respawn + circuit breaker + notify).
      this.respawn.handleDeath(bot)
    })

    bot.on('health', () => {
      if (!fresh()) return
      this.emitState({ minimal: this.tier.mode === 'L0' })
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
    this.respawn.attach(bot)
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
    // A resolution still in flight must not create a bot after this call.
    this.connectToken += 1
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
    this.emitState()
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

  /** F9 circuit breaker / manual stop: stay down until a human hits connect. */
  halt (reason, detail) {
    if (this.halted) return { ok: false, reason: 'already_halted' }
    this.halted = true
    this.haltReason = reason
    this.desiredOnline = false
    this.clearReconnectTimer()
    this.logger.warn(`halted: ${reason}`)
    this.disconnect({ reason: `halt:${reason}`, keepDesired: false })
    this.setStatus('halted')
    this.notify('warn', detail || `已停机（${reason}）`)
    return { ok: true, reason }
  }

  resume () {
    if (!this.halted) return { ok: false, reason: 'not_halted' }
    this.halted = false
    this.haltReason = null
    this.respawn.reset()
    return this.connect(this.lastConnectOptions || {})
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
      halted: this.halted,
      haltReason: this.haltReason,
      desiredOnline: this.desiredOnline,
      uiClients: this.uiClients,
      screen: this.screen.snapshot(),
      respawn: this.respawn.snapshot()
    }
  }

  // ------------------------------------------------------------ power tiers

  /** Called by the power loop every few seconds with raw sensor values. */
  updatePower (signals) {
    this.lastSignals = { ...signals }
    const next = this.refreshPower()
    this.emitSignalTable()
    return next
  }

  /**
   * Recomputes the tier from the last sensors + the screen authority + bot
   * activity. Cheap, so it also runs when the UI connects/disconnects or the
   * page visibility changes (where waiting for the next poll would lag).
   */
  refreshPower () {
    const screen = this.screen.evaluate({
      clientCount: this.uiClients,
      fallback: this.lastSignals.screenHint
    })
    const nativeThermal = this.nativeValue('thermal')
    const nativePowerSave = this.nativeValue('powerSave')
    const nativeBattery = this.nativeValue('battery')
    const nativeLevel = nativeBattery && Number.isFinite(nativeBattery.level)
      ? nativeBattery.level
      : null
    const nativeCharging = nativeBattery && typeof nativeBattery.charging === 'boolean'
      ? nativeBattery.charging
      : null
    const next = this.tier.update({
      ...this.lastSignals,
      // Priority: native -> sysfs -> termux-api -> null. Inside the APK sysfs
      // is SELinux-denied and there is no Termux:API, so this native reading
      // is the only thing that keeps L3/L0 alive; a missing/stale native value
      // falls back to whatever the poller could read (standalone Termux).
      battery: nativeLevel !== null ? nativeLevel : this.lastSignals.battery,
      charging: nativeCharging !== null ? nativeCharging : this.lastSignals.charging,
      // PowerManager's own calibrated status is the primary heat signal when
      // the app is alive; the sysfs delta stays as the fallback.
      thermalNative: nativeThermal,
      powerSave: nativePowerSave === null ? this.lastSignals.powerSave : nativePowerSave,
      screenOn: screen.on,
      screenSource: screen.source,
      navActive: this.nav.active,
      idle: this.isIdle()
    })
    return next
  }

  nativeValue (kind) {
    const value = this.native[kind]
    if (value === null || value === undefined) return null
    const at = this.native[`${kind}At`]
    if (this.now() - at > this.nativeStaleMs) return null
    return value
  }

  /** A2/A4/P1: native shell reports PowerManager.THERMAL_STATUS_* (0-6). */
  reportNativeThermal (value) {
    this.native.thermal = value
    this.native.thermalAt = this.now()
    const mode = this.refreshPower()
    this.emitSignalTable()
    return mode
  }

  /** P1: native `isPowerSaveMode()`, replaces the unreadable `settings` call. */
  reportNativePowerSave (on) {
    this.native.powerSave = Boolean(on)
    this.native.powerSaveAt = this.now()
    const mode = this.refreshPower()
    this.emitSignalTable()
    return mode
  }

  /**
   * M3 defect fix: native ACTION_BATTERY_CHANGED reading. `level` is percent,
   * `charging` is the shell's two-field answer (null = ROM did not say),
   * `tempC` is the cell temperature for cross-checking the thermal path.
   * A fresh reading beats sysfs/termux-api; after `nativeStaleMs` it expires
   * so a dead shell cannot hide a draining battery forever.
   */
  reportNativeBattery (payload = {}) {
    const level = Number.isFinite(payload.level) ? payload.level : null
    const charging = typeof payload.charging === 'boolean' ? payload.charging : null
    const tempC = Number.isFinite(payload.tempC) ? payload.tempC : null
    const chargeCounterUah = Number.isFinite(payload.chargeCounterUah) ? payload.chargeCounterUah : null
    const cycle = Number.isInteger(payload.cycle) ? payload.cycle : null
    this.native.battery = { level, charging, tempC, chargeCounterUah, cycle }
    this.native.batteryAt = this.now()
    const mode = this.refreshPower()
    this.emitSignalTable()
    return mode
  }

  /** Bridge tells us how many UI sockets are open. 0 observers => screen off. */
  setUiClients (count) {
    this.uiClients = Math.max(0, Number(count) || 0)
    this.screen.setClients(this.uiClients)
    this.refreshPower()
    this.restartStateLoop(this.tier.mode)
    this.emitSignalTable()
    this.emit('status', this.statusSnapshot())
  }

  /** `{"t":"screen","on":false}` from one client's Page Visibility API. */
  reportScreen (on, clientId = 'default') {
    this.screen.report(clientId, on)
    const mode = this.refreshPower()
    this.emitSignalTable()
    return mode
  }

  /** Any upstream message keeps that observer's report fresh. */
  touchScreen (clientId = 'default') {
    if (this.screen.touch(clientId)) this.refreshPower()
  }

  dropScreenClient (clientId) {
    this.screen.removeClient(clientId)
    this.refreshPower()
    this.emitSignalTable()
  }

  /**
   * Startup / runtime self-check table. Every external signal has a third
   * "unavailable" state; the UI must show it instead of pretending normal.
   */
  signalTable () {
    const avail = this.lastSignals.availability || {}
    const nativeThermal = this.nativeValue('thermal')
    const nativePowerSave = this.nativeValue('powerSave')
    const nativeBattery = this.nativeValue('battery')
    const nativeLevel = nativeBattery && Number.isFinite(nativeBattery.level)
      ? nativeBattery.level
      : null
    const nativeCharging = nativeBattery && typeof nativeBattery.charging === 'boolean'
      ? nativeBattery.charging
      : null
    const screen = this.screen.snapshot()
    const mock = this.lastSignals.source === 'mock'
    const screenStatus = screen.clients === 0
      ? 'no_client'
      : (screen.source === 'ui' ? 'live' : 'unknown')
    return {
      // Native reading first: sysfs is SELinux-denied inside the APK and
      // Termux:API may not be installed, so `unavailable(selinux)` must not be
      // printed while a real broadcast reading is flowing.
      battery: {
        source: nativeLevel !== null ? 'android-native' : (mock ? 'mock' : 'sysfs|termux-api'),
        status: nativeLevel !== null ? 'live' : (avail.battery || 'unavailable'),
        value: nativeLevel,
        tempC: nativeLevel !== null ? (nativeBattery.tempC ?? null) : null,
        bridge: avail.bridge || null
      },
      // `capacity` and `status` are independent sysfs files, and both the L3
      // skip and the L3 exit depend on this one: report it separately.
      charging: {
        source: nativeCharging !== null ? 'android-native' : (mock ? 'mock' : 'sysfs|termux-api'),
        status: nativeCharging !== null ? 'live' : (avail.charging || 'unavailable'),
        value: nativeCharging !== null ? nativeCharging : this.lastSignals.charging
      },
      // `baseline: pending` means the delta is not trusted yet (first minutes
      // after start), so thermal cannot downgrade the tier - say it out loud.
      // Native PowerManager status wins when present: it is OEM-calibrated and
      // does not need a baseline, so `status` becomes live even if sysfs is not.
      thermal: {
        source: nativeThermal !== null ? 'android-native' : (mock ? 'mock' : 'sysfs'),
        status: nativeThermal !== null ? 'live' : (avail.thermal || 'unavailable'),
        baseline: this.lastSignals.thermalBaselineC == null ? 'pending' : 'ready',
        zone: this.lastSignals.thermalZone || null,
        native: nativeThermal
      },
      screen: { source: 'ui-events', status: screenStatus },
      powerSave: {
        source: nativePowerSave !== null ? 'android-native' : (mock ? 'mock' : 'settings'),
        status: nativePowerSave !== null ? 'live' : (avail.powerSave || 'unavailable')
      }
    }
  }

  /** Raw sensor values + power telemetry for /api/health and the jsonl log. */
  powerSnapshot () {
    const s = this.lastSignals
    const nativeBattery = this.nativeValue('battery')
    return {
      battery: this.mergedBattery(),
      charging: this.mergedCharging(),
      powerSave: s.powerSave,
      thermalCelsius: s.thermalCelsius == null ? null : s.thermalCelsius,
      thermalBaselineC: s.thermalBaselineC == null ? null : s.thermalBaselineC,
      thermalDelta: s.thermalDelta == null ? null : s.thermalDelta,
      thermalZone: s.thermalZone || null,
      thermalNative: this.nativeValue('thermal'),
      powerSaveNative: this.nativeValue('powerSave'),
      batteryNative: nativeBattery,
      telemetry: s.telemetry || null
    }
  }

  /** Priority: native -> sysfs -> termux-api -> null (same rule as refreshPower). */
  mergedBattery () {
    const native = this.nativeValue('battery')
    if (native && Number.isFinite(native.level)) return native.level
    return this.lastSignals.battery
  }

  mergedCharging () {
    const native = this.nativeValue('battery')
    if (native && typeof native.charging === 'boolean') return native.charging
    return this.lastSignals.charging
  }

  emitSignalTable () {
    const table = this.signalTable()
    const serialized = JSON.stringify(table)
    if (serialized === this.lastSignalTableJson) return
    this.lastSignalTableJson = serialized
    this.emit('message', signalsMessage(table))
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
      // F9's breaker halt is manual-only: a power transition must never
      // resurrect a bot that died 3 times, nor overwrite its status.
      if (this.halted) {
        this.setStatus('halted')
        return
      }
      this.suspended = true
      this.emit('message', notifyMessage('warn', '电量低于阈值，已主动断开连接'))
      this.disconnect({ reason: 'power_l3', keepDesired: true })
      this.setStatus('suspended')
    } else if ((prev === 'L3' || this.suspended) && !this.halted) {
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
      // L0 with no observer: do not serialize state for an empty socket set.
      if (this.tier.mode === 'L0' && this.uiClients === 0) return
      this.emitState({ minimal: this.tier.mode === 'L0' })
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

  /**
   * Single funnel for state pushes. With zero UI clients there is nobody to
   * read the HUD, so we skip the JSON serialization entirely (verdict #1).
   */
  emitState ({ minimal = this.tier.mode === 'L0' } = {}) {
    if (this.uiClients === 0) return
    this.emit('message', stateMessage(this.buildState({ minimal })))
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
    // Thermal / power-save outrank the override: say so instead of silently
    // ignoring the click.
    if (mode !== 'auto' && this.tier.mode !== mode) {
      this.notify('warn', `温度或省电模式限制，当前保持 ${this.tier.mode}`)
    }
    return { ok: true, mode: this.tier.mode, forced: this.tier.forcedMode }
  }

  /** Pre-flight for the configured drop point (F6 safety). */
  checkDropPoint (point = this.config.inv.dropPoint) {
    return validateDropPoint({ bot: this.bot, point, nav: this.nav })
  }

  /** F9: walk back to the configured AFK waypoint after a death / reconnect. */
  async returnToWaypoint (why) {
    const cfg = this.config.respawn
    if (!cfg.returnToWaypoint) return
    const wp = this.config.waypoints[cfg.waypoint]
    if (!wp) {
      this.logger.warn(`no waypoint "${cfg.waypoint}" to return to (${why})`)
      this.notify('warn', `未找到挂机点 "${cfg.waypoint}"，请先在挂机位置保存`)
      return
    }
    try {
      await this.nav.goto(wp.x, wp.y, wp.z, this.config.nav.range, { reason: `return_${why}` })
      this.logger.info(`returned to waypoint ${cfg.waypoint} (${why})`)
    } catch (err) {
      this.logger.warn(`return to waypoint failed: ${err.message}`)
      this.notify('warn', `返回挂机点失败：${err.message}`)
    }
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
    this.configStore.replaceWaypoints(next)
    return { ok: true }
  }

  /** Re-apply config after an import / edit. */
  applyConfig () {
    this.backoff = new Backoff({
      baseMs: this.config.reconnect.baseMs,
      maxMs: this.config.reconnect.maxMs
    })
    // ConfigStore.save() swaps the config object; sub-managers hold the old
    // reference, so a value edited in the UI would otherwise never take effect.
    for (const sub of [this.nav, this.eater, this.inventory, this.afk]) {
      if (sub) sub.config = this.config
    }
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
      screen: this.screen.snapshot(),
      signals: this.signalTable(),
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
