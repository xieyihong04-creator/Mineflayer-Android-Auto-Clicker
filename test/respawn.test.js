'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { RespawnGuard } = require('../src/bot/respawn')
const { makeConfig, FakeBot } = require('./helpers')

function makeGuard (configPatch = {}, { now, notify = () => {} } = {}) {
  const config = makeConfig(configPatch)
  const bot = new FakeBot()
  const halts = []
  const guard = new RespawnGuard({
    getBot: () => bot,
    getConfig: () => config,
    logger: null,
    notify,
    onHalt: (reason, deaths) => halts.push({ reason, deaths }),
    now: now || (() => Date.now())
  })
  guard.attach(bot)
  return { guard, bot, config, halts }
}

test('F9: death triggers a delayed respawn and a waypoint return request', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { guard, bot } = makeGuard({ respawn: { delayMs: 2000 } })
  bot.emit('death')
  assert.equal(bot.respawnCalls, 0, 'respawn waits for delayMs')
  assert.equal(guard.consumeReturnRequest(), true)
  t.mock.timers.tick(2000)
  assert.equal(bot.respawnCalls, 1)
})

test('F9: three consecutive deaths halt instead of feeding the loop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const notifications = []
  let clock = 1000000
  const { guard, bot, halts } = makeGuard(
    { respawn: { maxConsecutive: 3, delayMs: 1000, windowMs: 600000 } },
    { now: () => clock, notify: (level, msg) => notifications.push(msg) }
  )
  bot.emit('death')
  t.mock.timers.tick(1000)
  clock += 1000
  bot.emit('death')
  t.mock.timers.tick(1000)
  clock += 1000
  bot.emit('death')

  assert.equal(bot.respawnCalls, 2, 'only the first two deaths respawn')
  assert.equal(halts.length, 1)
  assert.equal(halts[0].reason, 'respawn_limit')
  assert.equal(halts[0].deaths, 3)
  assert.match(notifications.at(-1), /连续死亡 3 次/)
})

test('F9: deaths older than windowMs do not count towards the limit', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let clock = 1000000
  const { guard, bot, halts } = makeGuard(
    { respawn: { maxConsecutive: 2, delayMs: 0, windowMs: 60000 } },
    { now: () => clock }
  )
  bot.emit('death')
  clock += 120000
  bot.emit('death')
  assert.equal(halts.length, 0, 'spaced-out deaths are not a loop')
  assert.equal(guard.deaths, 1)
})

test('F9: respawn can be disabled (notify only)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const notifications = []
  const { bot, halts } = makeGuard(
    { respawn: { enabled: false } },
    { notify: (level, msg) => notifications.push(msg) }
  )
  bot.emit('death')
  t.mock.timers.tick(60000)
  assert.equal(bot.respawnCalls, 0)
  assert.equal(halts.length, 0)
  assert.match(notifications.at(-1), /自动重生已关闭/)
})

test('F9: stale bot is not resurrected after a reconnect', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const config = makeConfig({ respawn: { delayMs: 1000 } })
  const oldBot = new FakeBot()
  const newBot = new FakeBot()
  let current = oldBot
  const guard = new RespawnGuard({
    getBot: () => current,
    getConfig: () => config,
    logger: null,
    notify: () => {}
  })
  guard.attach(oldBot)
  oldBot.emit('death')
  current = newBot
  t.mock.timers.tick(1000)
  assert.equal(oldBot.respawnCalls, 0)
  assert.equal(newBot.respawnCalls, 0)
})
