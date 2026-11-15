'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { AutoEater } = require('../src/bot/eating')
const { FakeBot, makeConfig, fakeLogger } = require('./helpers')

function makeEater ({ bot = new FakeBot(), configPatch = {}, nav = null, onStarving = null } = {}) {
  const notifications = []
  const config = makeConfig(configPatch)
  const eater = new AutoEater({
    getBot: () => bot,
    config,
    logger: fakeLogger(),
    nav,
    notify: (level, msg) => notifications.push({ level, msg }),
    now: () => Date.now(),
    onStarving
  })
  return { eater, bot, notifications, config }
}

test('F5: eats when food is at or below the threshold', async () => {
  const { eater, bot } = makeEater()
  bot.food = 14
  bot.addItem('bread', 5)
  const result = await eater.check('health')
  assert.equal(result.ok, true)
  assert.equal(result.food, 'bread')
  assert.equal(bot.consumeCalls, 1)
})

test('F5: does not eat when food is above the threshold', async () => {
  const { eater, bot } = makeEater()
  bot.food = 18
  bot.addItem('bread', 5)
  const result = await eater.check('health')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not_hungry')
  assert.equal(bot.consumeCalls, 0)
})

test('F5: never eats blacklisted food, notifies once when food is exhausted', async () => {
  const { eater, bot, notifications } = makeEater()
  bot.food = 6
  bot.addItem('rotten_flesh', 20)
  bot.addItem('raw_chicken', 3)
  const first = await eater.check('health')
  assert.equal(first.ok, false)
  assert.equal(first.reason, 'no_food')
  const second = await eater.check('health')
  assert.equal(second.reason, 'no_food')
  assert.equal(bot.consumeCalls, 0)
  assert.equal(notifications.filter((n) => n.level === 'warn').length, 1)
})

test('F5: manual eat can force even when above threshold', async () => {
  const { eater, bot } = makeEater()
  bot.food = 19
  bot.addItem('golden_carrot', 4)
  const result = await eater.check('manual', { force: true })
  assert.equal(result.ok, true)
  assert.equal(bot.consumeCalls, 1)
})

test('F5: pauses navigation while eating and resumes the goal', async () => {
  const calls = []
  const nav = {
    active: true,
    pause: () => { calls.push('pause'); return { x: 1, y: 2, z: 3, range: 2 } },
    resume: async (goal) => { calls.push(['resume', goal]) },
    goto: async () => {},
    stop: () => {}
  }
  const { eater, bot } = makeEater({ nav })
  bot.food = 10
  bot.addItem('bread', 3)
  await eater.check('health')
  assert.equal(calls[0], 'pause')
  assert.deepEqual(calls[1], ['resume', { x: 1, y: 2, z: 3, range: 2 }])
})

test('F5: eat timeout is reported instead of hanging', async () => {
  const { eater, bot } = makeEater()
  bot.food = 8
  bot.addItem('bread', 1)
  bot.consumeImpl = () => new Promise(() => {})
  eater.withTimeout = (promise, ms, reason) => Promise.reject(new Error(reason))
  const result = await eater.check('health')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'eat_timeout')
})

test('F5: disabled by config unless forced', async () => {
  const { eater, bot } = makeEater({ configPatch: { eat: { enabled: false } } })
  bot.food = 3
  bot.addItem('bread', 1)
  assert.equal((await eater.check('health')).reason, 'disabled')
  assert.equal((await eater.check('manual', { force: true })).ok, true)
})

test('F5: foodless + low HP reports starving once and asks the manager to halt', async () => {
  const halts = []
  const { eater, bot, notifications } = makeEater({ onStarving: (info) => halts.push(info) })
  bot.food = 0
  bot.health = 6
  bot.addItem('rotten_flesh', 10)
  const first = await eater.check('health')
  assert.equal(first.reason, 'no_food')
  assert.equal(halts.length, 1)
  assert.equal(halts[0].health, 6)
  assert.equal(halts[0].reason, 'food_exhausted')
  assert.ok(notifications.some((n) => /生命仅 6/.test(n.msg)))
  await eater.check('health')
  assert.equal(halts.length, 1, 'one halt per starving episode, not per health event')
})

test('F5: foodless but healthy only alerts, never halts', async () => {
  const halts = []
  const { eater, bot } = makeEater({ onStarving: (info) => halts.push(info) })
  bot.food = 0
  bot.health = 18
  bot.addItem('rotten_flesh', 10)
  assert.equal((await eater.check('health')).reason, 'no_food')
  assert.equal(halts.length, 0)
})

test('F5: disconnectAtHealth = 0 disables the starvation halt', async () => {
  const halts = []
  const { eater, bot } = makeEater({
    configPatch: { eat: { disconnectAtHealth: 0 } },
    onStarving: (info) => halts.push(info)
  })
  bot.food = 0
  bot.health = 1
  bot.addItem('rotten_flesh', 10)
  await eater.check('health')
  assert.equal(halts.length, 0)
})
