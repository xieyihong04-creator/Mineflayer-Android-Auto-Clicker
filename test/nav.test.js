'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Navigator } = require('../src/bot/nav')
const { FakeBot, makeConfig, fakeLogger } = require('./helpers')

function makeNavigator (configPatch = {}) {
  const bot = new FakeBot()
  const events = []
  const factory = () => ({
    pathfinder: {},
    Movements: class Movements {
      constructor (b) { this.bot = b }
    },
    goals: {
      GoalNear: class GoalNear {
        constructor (x, y, z, range) {
          Object.assign(this, { x, y, z, range })
        }
      }
    }
  })
  const nav = new Navigator({
    getBot: () => bot,
    config: makeConfig(configPatch),
    logger: fakeLogger(),
    emit: (msg) => events.push(msg),
    factory
  })
  nav.setup(bot)
  return { bot, nav, events }
}

test('F4: movements are locked down (no dig / parkour / free motion / scaffolding)', () => {
  const { bot } = makeNavigator()
  const m = bot.pathfinder.movements
  assert.equal(m.canDig, false)
  assert.equal(m.allowParkour, false)
  assert.equal(m.allowFreeMotion, false)
  assert.equal(m.allow1by1towers, false)
  assert.deepEqual(m.scafoldingBlocks, [])
})

test('pathfinder plugin is loaded only when the bot does not have it yet', () => {
  const bot = new FakeBot()
  delete bot.pathfinder
  bot.loadPlugin = () => {
    bot.pluginLoaded = true
    bot.pathfinder = {
      setMovements: (m) => { bot.pathfinder.movements = m },
      setGoal: () => {},
      stop: () => {}
    }
  }
  const nav = new Navigator({
    getBot: () => bot,
    config: makeConfig(),
    logger: fakeLogger(),
    factory: () => ({
      pathfinder: {},
      Movements: class { constructor () {} },
      goals: { GoalNear: class {} }
    })
  })
  nav.setup(bot)
  assert.equal(bot.pluginLoaded, true)
  assert.ok(bot.pathfinder.movements)
})

test('goto sets a GoalNear with the requested range', async () => {
  const { bot, nav, events } = makeNavigator()
  await nav.goto(10, 64, -20, 3)
  assert.equal(nav.active, true)
  const goal = bot.pathfinder.goals.at(-1)
  assert.equal(goal.x, 10)
  assert.equal(goal.y, 64)
  assert.equal(goal.z, -20)
  assert.equal(goal.range, 3)
  assert.equal(events[0].state, 'started')
})

test('goto aborts after nav.timeoutMs (30s) and reports stopped(timeout)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { bot, nav, events } = makeNavigator()
  await nav.goto(1, 2, 3, 1)
  t.mock.timers.tick(29999)
  assert.equal(nav.active, true, 'still navigating just before the timeout')
  t.mock.timers.tick(1)
  const last = events.at(-1)
  assert.equal(nav.active, false)
  assert.equal(last.state, 'stopped')
  assert.equal(last.reason, 'timeout')
  assert.equal(bot.pathfinder.stopped, true)
})

test('manual stop cancels navigation', async () => {
  const { nav, events } = makeNavigator()
  await nav.goto(1, 2, 3, 1)
  nav.stop('user')
  assert.equal(nav.active, false)
  assert.equal(events.at(-1).state, 'stopped')
  assert.equal(events.at(-1).reason, 'user')
})

test('goal_reached finishes navigation', async () => {
  const { bot, nav, events } = makeNavigator()
  await nav.goto(1, 2, 3, 1)
  bot.emit('goal_reached')
  assert.equal(nav.active, false)
  assert.equal(events.at(-1).state, 'reached')
})

test('pause keeps the goal for resume', async () => {
  const { nav } = makeNavigator()
  await nav.goto(5, 6, 7, 2)
  const goal = nav.pause()
  assert.deepEqual(goal, { x: 5, y: 6, z: 7, range: 2 })
  assert.equal(nav.active, true, 'paused still counts as active')
  await nav.resume(goal)
  assert.equal(nav.snapshot().active, true)
})

test('goto rejects when there is no bot in a world', async () => {
  const nav = new Navigator({ getBot: () => null, config: makeConfig(), logger: fakeLogger() })
  await assert.rejects(() => nav.goto(1, 2, 3, 1), /not in a world/)
})
