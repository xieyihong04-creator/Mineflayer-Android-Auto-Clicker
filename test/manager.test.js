'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { BotManager } = require('../src/bot/manager')
const { PowerTierController } = require('../src/power/tier')
const { deepMerge } = require('../src/config')
const { FakeBot, makeConfig, fakeLogger, navStub } = require('./helpers')

function makeManager (configPatch = {}, { createBot } = {}) {
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
  const tier = new PowerTierController({ config })
  const bots = []
  const manager = new BotManager({
    configStore: store,
    logger,
    tier,
    nav: navStub(),
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
