'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { BotManager } = require('../src/bot/manager')
const { PowerTierController } = require('../src/power/tier')
const { deepMerge } = require('../src/config')
const { FakeBot, makeConfig, fakeLogger, navStub } = require('./helpers')

function makeManager (configPatch = {}, { createBot, nav, now } = {}) {
  const config = makeConfig({
    server: { host: 'mc.example.com', port: 25565, username: 'Tester' },
    ...configPatch
  })
  const store = {
    config,
    save (patch) {
      this.config = deepMerge(this.config, patch)
      return this.config
    },
    persist () {}
  }
  const logger = fakeLogger()
  const tier = new PowerTierController({ config, now })
  const bots = []
  const manager = new BotManager({
    configStore: store,
    logger,
    tier,
    now,
    nav: nav || navStub(),
    createBot: createBot || (() => {
      const bot = new FakeBot()
      bots.push(bot)
      return bot
    }),
    networkWatcher: { start: () => {}, stop: () => {} }
  })
  tier.onChange = (mode, prev, meta) => manager.applyModeActions(mode, prev, meta)
  return { manager, store, logger, tier, bots }
}

test('F1: connect -> spawn -> online, and backoff resets', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { manager, bots } = makeManager()
  t.after(() => manager.destroy())
  assert.equal(manager.connect().ok, true)
  assert.equal(manager.status, 'connecting')
  bots[0].emit('spawn')
  assert.equal(manager.status, 'online')
  assert.equal(manager.backoff.attempt, 0)
  manager.disconnect()
  assert.equal(manager.status, 'offline')
  assert.equal(manager.desiredOnline, false)
})

test('F1: disconnected session reconnects with 1s then 2s backoff', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { manager, bots } = makeManager()
  t.after(() => manager.destroy())
  manager.connect()
  bots[0].emit('spawn')
  bots[0].emit('end', 'socket closed')
  assert.equal(manager.status, 'reconnecting')

  t.mock.timers.tick(1000)
  assert.equal(bots.length, 2, 'first retry after 1s')
  bots[1].emit('end', 'socket closed again')
  t.mock.timers.tick(1000)
  assert.equal(bots.length, 2, 'second retry waits 2s')
  t.mock.timers.tick(1000)
  assert.equal(bots.length, 3, 'second retry fires at 2s')
})

test('F1: user disconnect does not reconnect', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { manager, bots } = makeManager()
  t.after(() => manager.destroy())
  manager.connect()
  bots[0].emit('spawn')
  manager.disconnect({ reason: 'user' })
  t.mock.timers.tick(60000)
  assert.equal(bots.length, 1)
})

test('F1: reconnect can be disabled by config', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { manager, bots } = makeManager({ reconnect: { enabled: false } })
  t.after(() => manager.destroy())
  manager.connect()
  bots[0].emit('spawn')
  bots[0].emit('end', 'closed')
  t.mock.timers.tick(120000)
  assert.equal(bots.length, 1)
  assert.equal(manager.status, 'offline')
})

test('F1: network switch forces an immediate reconnect', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { manager, bots } = makeManager()
  t.after(() => manager.destroy())
  manager.connect()
  bots[0].emit('spawn')
  manager.onNetworkChange()
  assert.equal(bots.length, 2, 'reconnect without waiting for backoff')
})

test('F7: L0 sets tiny view distance, trims chat, pauses cleanup, slows state push', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { manager, bots, tier } = makeManager()
  t.after(() => manager.destroy())
  manager.start()
  manager.connect()
  bots[0].emit('spawn')
  for (let i = 0; i < 120; i++) manager.chat.push({ text: `m${i}` })
  assert.ok(manager.inventory.timer, 'cleanup timer running in L2')

  manager.applyModeActions('L0', 'L2')
  assert.deepEqual(bots[0].setSettingsCalls.at(-1), { viewDistance: 'tiny' })
  assert.equal(manager.chat.history().length, 50)
  assert.equal(manager.inventory.timer, null)
  assert.equal(manager.stateIntervalMs, 20000)
  assert.equal(tier.mode, 'L2', 'applyModeActions does not mutate the tier itself')
})

test('F7: back to L2 restores normal view distance, chat limit and cleanup timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { manager, bots } = makeManager()
  t.after(() => manager.destroy())
  manager.start()
  manager.connect()
  bots[0].emit('spawn')
  manager.applyModeActions('L0', 'L2')
  manager.applyModeActions('L2', 'L0')
  assert.deepEqual(bots[0].setSettingsCalls.at(-1), { viewDistance: 'normal' })
  assert.ok(manager.inventory.timer)
  assert.equal(manager.stateIntervalMs, 500)
})

test('F7/L3: battery cutoff disconnects, stays suspended, and only reconnects after recovery', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { manager, bots } = makeManager()
  t.after(() => manager.destroy())
  manager.connect()
  bots[0].emit('spawn')

  manager.applyModeActions('L3', 'L2')
  assert.equal(manager.status, 'suspended')
  assert.equal(manager.suspended, true)
  assert.equal(manager.desiredOnline, true, 'user intent is remembered')

  t.mock.timers.tick(120000)
  assert.equal(bots.length, 1, 'L3 must not trigger the reconnect loop')

  manager.applyModeActions('L2', 'L3')
  assert.equal(manager.suspended, false)
  assert.equal(bots.length, 2, 'reconnects when the tier recovers')
})

test('F3: chat sends through the bot and echoes a self message', () => {
  const { manager } = makeManager()
  const messages = []
  manager.on('message', (m) => messages.push(m))
  assert.equal(manager.sendChat('hi').ok, false)
  const bot = new FakeBot()
  manager.bot = bot
  assert.equal(manager.sendChat('/spawn').ok, true)
  assert.deepEqual(bot.chatCalls, ['/spawn'])
  assert.equal(messages.at(-1).kind, 'self')
})

test('P1: waypoints save and go through the config store', async () => {
  const { manager, store } = makeManager()
  const bot = new FakeBot()
  manager.bot = bot
  const saved = manager.saveWaypoint('afk')
  assert.equal(saved.ok, true)
  assert.deepEqual(store.config.waypoints.afk, { x: 0, y: 64, z: 0 })
  manager.bot = null
  const goto = await manager.goWaypoint('afk')
  assert.equal(goto.ok, false, 'offline navigation is refused')
})

test('F2: state snapshot carries hp/food/pos/yaw/nav/mode/online', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { manager, bots } = makeManager()
  t.after(() => manager.destroy())
  manager.connect()
  bots[0].emit('spawn')
  const state = manager.buildState()
  assert.equal(state.hp, 20)
  assert.equal(state.food, 20)
  assert.deepEqual(state.pos, bots[0].entity.position)
  assert.equal(state.mode, 'L2')
  assert.equal(state.connected, true)
  assert.ok(Number.isFinite(state.online))
})

test('verdict #1: L0 never serializes state without a UI client', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { manager, bots } = makeManager()
  t.after(() => manager.destroy())
  const states = []
  manager.on('message', (m) => { if (m.t === 'state') states.push(m) })
  manager.start()
  manager.connect()
  bots[0].emit('spawn')
  assert.equal(states.length, 0, 'no observer -> no state at all')

  manager.applyModeActions('L0', 'L2')
  t.mock.timers.tick(60000)
  assert.equal(states.length, 0, 'L0 heartbeat is skipped with zero clients')

  manager.setUiClients(1)
  t.mock.timers.tick(20000)
  assert.ok(states.length >= 1, 'a client makes the L0 heartbeat run')
})

test('screen authority: UI reports drive the tier signals, no-client means off', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { manager } = makeManager()
  t.after(() => manager.destroy())

  manager.updatePower({ battery: 80, charging: false, thermal: 0, powerSave: false, screenHint: null })
  assert.equal(manager.tier.lastSignals.screenOn, false)
  assert.equal(manager.tier.lastSignals.screenSource, 'no_client')

  manager.setUiClients(1)
  manager.reportScreen(true, 'ui-1')
  assert.equal(manager.tier.lastSignals.screenOn, true)
  assert.equal(manager.tier.lastSignals.screenSource, 'ui')

  manager.reportScreen(false, 'ui-1')
  assert.equal(manager.tier.lastSignals.screenOn, false)

  manager.setUiClients(0)
  assert.deepEqual(manager.screen.snapshot().reports, {}, 'closing the tab discards the report')
})

test('F9: manager halts after the respawn circuit breaker and stops reconnecting', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { manager, bots } = makeManager({ respawn: { maxConsecutive: 2, delayMs: 1000 } })
  t.after(() => manager.destroy())
  manager.start()
  manager.connect()
  bots[0].emit('spawn')

  bots[0].emit('death')
  t.mock.timers.tick(1000)
  bots[0].emit('death')

  assert.equal(manager.status, 'halted')
  assert.equal(manager.halted, true)
  assert.equal(manager.desiredOnline, false)
  assert.equal(bots[0].respawnCalls, 0, 'the third death trips the breaker instead of respawning')
  t.mock.timers.tick(120000)
  assert.equal(bots.length, 1, 'halted means no reconnect loop')

  assert.equal(manager.resume().ok, true, 'manual resume clears the halt')
  assert.equal(manager.halted, false)
})

test('F9: reconnect after a kick walks back to the AFK waypoint', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const gotos = []
  const nav = {
    ...navStub(),
    goto: async (x, y, z, range, opts) => { gotos.push({ x, y, z, range, opts }); return { x, y, z, range } }
  }
  const { manager, bots } = makeManager(
    { waypoints: { afk: { x: 5, y: 64, z: -7 } } },
    { nav }
  )
  t.after(() => manager.destroy())
  manager.connect()
  bots[0].emit('spawn')
  assert.equal(gotos.length, 0, 'a first connect does not move the bot')

  bots[0].emit('end', 'server restart')
  t.mock.timers.tick(1000)
  bots[1].emit('spawn')
  assert.equal(gotos.length, 1)
  assert.deepEqual({ x: gotos[0].x, y: gotos[0].y, z: gotos[0].z }, { x: 5, y: 64, z: -7 })
})

test('F9: respawn walks back to the waypoint after the bot is back', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const gotos = []
  const nav = {
    ...navStub(),
    goto: async (x, y, z, range, opts) => { gotos.push({ x, y, z, opts }); return { x, y, z } }
  }
  const { manager, bots } = makeManager(
    { waypoints: { afk: { x: 1, y: 65, z: 2 } }, respawn: { delayMs: 500 } },
    { nav }
  )
  t.after(() => manager.destroy())
  manager.connect()
  bots[0].emit('spawn')
  bots[0].emit('death')
  t.mock.timers.tick(500)
  bots[0].emit('spawn')
  assert.equal(gotos.length, 1)
  assert.equal(gotos[0].opts.reason, 'return_respawn')
})

test('F6: drop point check is wired to the live world', () => {
  const { manager } = makeManager()
  const offline = manager.checkDropPoint()
  assert.equal(offline.checked, false, 'offline -> nothing to validate against')
  assert.equal(offline.reason, 'no_world')
})

test('halt separation: L3 enter/exit must never resurrect an F9 halt', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { manager, bots } = makeManager({ respawn: { maxConsecutive: 2, delayMs: 1000 } })
  t.after(() => manager.destroy())
  manager.start()
  manager.connect()
  bots[0].emit('spawn')
  bots[0].emit('death')
  t.mock.timers.tick(1000)
  bots[0].emit('death')
  assert.equal(manager.status, 'halted')

  manager.applyModeActions('L3', 'L2')
  assert.equal(manager.status, 'halted', 'L3 must not overwrite the halt status')
  assert.equal(manager.suspended, false, 'a halted bot is not "power suspended"')
  assert.equal(manager.desiredOnline, false, 'L3 must not re-arm the reconnect intent')

  manager.applyModeActions('L2', 'L3')
  t.mock.timers.tick(120000)
  assert.equal(bots.length, 1, 'leaving L3 while halted does not reconnect')
  assert.equal(manager.halted, true)

  manager.resume()
  assert.equal(manager.halted, false, 'only a manual resume clears it')
})

test('halt separation: charging/L3 recovery cannot clear a food-exhaustion halt', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { manager, bots } = makeManager()
  t.after(() => manager.destroy())
  manager.start()
  manager.connect()
  bots[0].emit('spawn')

  manager.halt('food_exhausted', '食物耗尽')
  assert.equal(manager.status, 'halted')
  manager.updatePower({
    battery: 90,
    charging: true,
    thermal: 0,
    powerSave: false,
    availability: { battery: 'live', thermal: 'live', powerSave: 'live' }
  })
  manager.applyModeActions('L2', 'L3')
  t.mock.timers.tick(30000)
  assert.equal(manager.halted, true)
  assert.equal(manager.status, 'halted')
  assert.equal(bots.length, 1)
})

test('signal self-check: every unavailable sensor is a third state in hello', () => {
  const { manager } = makeManager()
  manager.updatePower({
    battery: null,
    charging: null,
    thermal: null,
    powerSave: false,
    availability: { battery: 'unavailable', charging: 'unavailable', thermal: 'unavailable', powerSave: 'live' }
  })
  const table = manager.signalTable()
  assert.equal(table.battery.status, 'unavailable')
  assert.equal(table.charging.status, 'unavailable', 'charging is its own line, not folded into battery')
  assert.equal(table.thermal.status, 'unavailable')
  assert.equal(table.powerSave.status, 'live')
  assert.equal(table.screen.status, 'no_client')
  assert.equal(manager.helloPayload().signals.battery.status, 'unavailable')

  manager.setUiClients(1)
  manager.reportScreen(true, 'ui-1')
  assert.equal(manager.signalTable().screen.status, 'live')
  assert.equal(manager.signalTable().screen.source, 'ui-events')
})

test('signal self-check: termux-api fallback is reported, not hidden', () => {
  const { manager } = makeManager()
  manager.updatePower({
    battery: 42,
    charging: true,
    thermal: 1,
    powerSave: false,
    availability: { battery: 'live(termux-api)', charging: 'live', thermal: 'live', powerSave: 'live' }
  })
  assert.equal(manager.signalTable().battery.status, 'live(termux-api)')
})

test('signal self-check: failure reasons are preserved verbatim (selinux vs no-bridge)', () => {
  const { manager } = makeManager()
  manager.updatePower({
    battery: null,
    charging: null,
    thermal: null,
    thermalDelta: null,
    thermalBaselineC: null,
    powerSave: null,
    thermalZone: null,
    availability: {
      battery: 'unavailable(selinux)',
      charging: 'unavailable',
      thermal: 'unavailable(selinux)',
      powerSave: 'unavailable'
    }
  })
  const table = manager.signalTable()
  assert.equal(table.battery.status, 'unavailable(selinux)')
  assert.equal(table.thermal.status, 'unavailable(selinux)')
  assert.equal(table.thermal.baseline, 'pending')
  assert.equal(table.powerSave.status, 'unavailable')

  manager.updatePower({
    battery: 66,
    charging: false,
    thermal: 0,
    thermalDelta: 0.2,
    thermalBaselineC: 43.1,
    thermalZone: 'quiet_therm',
    powerSave: false,
    availability: { battery: 'live(termux-api)', charging: 'live(termux-api)', thermal: 'live', powerSave: 'live' }
  })
  const ready = manager.signalTable()
  assert.equal(ready.battery.status, 'live(termux-api)')
  assert.equal(ready.thermal.baseline, 'ready')
  assert.equal(ready.thermal.zone, 'quiet_therm')
  assert.equal(manager.powerSnapshot().thermalBaselineC, 43.1)
})

test('signal self-check: table is pushed once per change, not per poll', () => {
  const { manager } = makeManager()
  const pushes = []
  manager.on('message', (m) => { if (m.t === 'signals') pushes.push(m) })
  const signals = {
    battery: 80,
    charging: false,
    thermal: 0,
    powerSave: false,
    availability: { battery: 'live', charging: 'live', thermal: 'live', powerSave: 'live' }
  }
  manager.updatePower(signals)
  manager.updatePower(signals)
  assert.equal(pushes.length, 1)
  manager.updatePower({ ...signals, availability: { battery: 'unavailable', charging: 'live', thermal: 'live', powerSave: 'live' } })
  assert.equal(pushes.length, 2)
  assert.equal(pushes[1].signals.battery.status, 'unavailable')
})

// ------------------------------------------------------------------ M2 native

function clock () {
  let t = 1000
  return { now: () => t, tick: (ms) => { t += ms } }
}

const liveAll = { battery: 'live', charging: 'live', thermal: 'live', powerSave: 'live' }
const sysfsSignals = {
  battery: 80,
  charging: false,
  thermal: 0,
  thermalDelta: 0,
  thermalBaselineC: 43.1,
  thermalZone: 'quiet_therm',
  powerSave: false,
  availability: liveAll
}

test('M2: native thermal status is primary, reaches L0 without any sysfs delta', () => {
  const c = clock()
  const { manager, tier } = makeManager({}, { now: c.now })
  manager.updatePower(sysfsSignals)
  assert.equal(tier.mode, 'L2')
  assert.equal(manager.reportNativeThermal(2), 'L2', 'L2 -> L0 still debounces like any downgrade')
  c.tick(10000)
  assert.equal(manager.reportNativeThermal(2), 'L0')
  const row = manager.signalTable().thermal
  assert.equal(row.source, 'android-native')
  assert.equal(row.status, 'live')
  assert.equal(row.native, 2)
  assert.equal(row.baseline, 'ready', 'sysfs baseline is still reported alongside')
  assert.equal(manager.powerSnapshot().thermalNative, 2)
})

test('M2: a stale native report expires instead of pinning the tier', () => {
  const c = clock()
  const { manager, tier } = makeManager({}, { now: c.now })
  manager.updatePower(sysfsSignals)
  manager.reportNativeThermal(3)
  c.tick(10000)
  assert.equal(manager.reportNativeThermal(3), 'L0')
  c.tick(manager.nativeStaleMs + 1)
  manager.updatePower(sysfsSignals)
  assert.equal(tier.mode, 'L1', 'no app + no UI client: back to L1 immediately, never stuck in L0')
  const row = manager.signalTable().thermal
  assert.equal(row.source, 'sysfs')
  assert.equal(row.native, null)
  assert.equal(manager.powerSnapshot().thermalNative, null)
})

test('M2: native isPowerSaveMode overrides the unreadable settings value', () => {
  const c = clock()
  const { manager, tier } = makeManager({}, { now: c.now })
  manager.updatePower({ ...sysfsSignals, powerSave: null, availability: { ...liveAll, powerSave: 'unavailable' } })
  assert.equal(manager.signalTable().powerSave.status, 'unavailable')
  assert.equal(manager.reportNativePowerSave(true), 'L2')
  c.tick(10000)
  assert.equal(manager.reportNativePowerSave(true), 'L0')
  const row = manager.signalTable().powerSave
  assert.equal(row.source, 'android-native')
  assert.equal(row.status, 'live')
  assert.equal(manager.powerSnapshot().powerSaveNative, true)
  assert.equal(c.now(), 11000)
})
