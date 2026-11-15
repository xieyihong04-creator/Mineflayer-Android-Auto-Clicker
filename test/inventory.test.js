'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { InventoryManager } = require('../src/bot/inventory')
const { FakeBot, FakePosition, makeConfig, fakeLogger } = require('./helpers')

function makeInv ({ configPatch = {}, bot = new FakeBot() } = {}) {
  const gotos = []
  const events = []
  const gaps = []
  const nav = {
    active: false,
    setup: () => {},
    stop: () => { nav.active = false },
    goto: async (x, y, z, range, opts) => {
      nav.active = true
      gotos.push({ x, y, z, range, opts })
      nav.active = false
      return { x, y, z, range }
    },
    pause: () => null,
    resume: async () => {},
    snapshot: () => ({})
  }
  const config = makeConfig({
    inv: {
      dropPoint: { set: true, type: 'lava', x: 100, y: 64, z: -200 },
      tossGapMs: 300
    },
    ...configPatch
  })
  const inv = new InventoryManager({
    getBot: () => bot,
    config,
    logger: fakeLogger(),
    nav,
    getMode: () => 'L2',
    emit: (msg) => events.push(msg),
    sleepFn: async (ms) => { gaps.push(ms) },
    notify: () => {}
  })
  return { inv, bot, gotos, gaps, events, nav }
}

function fillBot (bot) {
  for (let i = 9; i <= 42; i++) bot.addItem('dirt', 64, i)
  bot.addItem('diamond_pickaxe', 1, 43)
  bot.addItem('bread', 8, 44)
  return bot
}

test('F6: walks to drop point, tosses serially with 300ms gaps, returns home', async () => {
  const bot = fillBot(new FakeBot({ pos: new FakePosition(0, 70, 0) }))
  const { inv, gotos, gaps, events } = makeInv({ bot })
  const result = await inv.maybeCleanup({ force: true, reason: 'full' })

  assert.equal(result.ok, true)
  assert.equal(result.tossed, 34)
  assert.equal(bot.tossed.length, 34)
  assert.ok(bot.tossed.every((name) => name === 'dirt'))
  assert.equal(gotoCount(gotos), 2)
  assert.deepEqual(pick(gotos[0]), { x: 100, y: 64, z: -200 })
  assert.deepEqual(pick(gotos.at(-1)), { x: 0, y: 70, z: 0 })
  assert.ok(gaps.length >= 34)
  assert.ok(gaps.every((ms) => ms === 300), 'serial toss must wait 300ms')
  assert.ok(events.some((e) => e.t === 'inv'))
})

test('F6: tools, weapons, armor and food are never tossed', async () => {
  const bot = new FakeBot({ pos: new FakePosition(0, 70, 0) })
  for (let i = 9; i <= 41; i++) bot.addItem('cobblestone', 64, i)
  bot.addItem('iron_sword', 1, 42)
  bot.addItem('netherite_helmet', 1, 43)
  bot.addItem('cooked_beef', 16, 44)
  const { inv } = makeInv({ bot })
  const result = await inv.maybeCleanup({ force: true, reason: 'full' })
  assert.equal(result.tossed, 33)
  assert.ok(!bot.tossed.includes('iron_sword'))
  assert.ok(!bot.tossed.includes('netherite_helmet'))
  assert.ok(!bot.tossed.includes('cooked_beef'))
})

test('F6: refuses to run without a configured drop point (never toss in place)', async () => {
  const bot = fillBot(new FakeBot())
  const { inv, gotos } = makeInv({
    bot,
    configPatch: { inv: { dropPoint: { set: false } } }
  })
  const result = await inv.maybeCleanup({ force: true, reason: 'full' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no_drop_point')
  assert.equal(gotoCount(gotos), 0)
  assert.equal(bot.tossed.length, 0)
})

test('F6: container drop point deposits instead of tossing', async () => {
  const bot = new FakeBot({ pos: new FakePosition(0, 70, 0) })
  fillBot(bot)
  const deposits = []
  let closed = false
  bot.blockAt = () => ({ name: 'chest', position: { x: 100, y: 64, z: -200 } })
  bot.openContainer = async () => ({
    deposit: async (type, metadata, count) => deposits.push({ type, metadata, count }),
    close: () => { closed = true }
  })
  const { inv } = makeInv({
    bot,
    configPatch: { inv: { dropPoint: { set: true, type: 'container', x: 100, y: 64, z: -200 } } }
  })
  const result = await inv.maybeCleanup({ force: true, reason: 'full' })
  assert.equal(result.ok, true)
  assert.equal(deposits.length, 34)
  assert.equal(bot.tossed.length, 0)
  assert.equal(closed, true)
})

test('F6: does nothing when the inventory is not full', async () => {
  const bot = new FakeBot()
  bot.addItem('dirt', 1, 9)
  const { inv, gotos } = makeInv({ bot })
  const result = await inv.maybeCleanup({ reason: 'full' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not_full')
  assert.equal(gotoCount(gotos), 0)
})

test('F6: scheduled cleanup is paused in L0', async () => {
  const bot = fillBot(new FakeBot())
  const config = makeConfig({ inv: { dropPoint: { set: true, type: 'lava', x: 1, y: 2, z: 3 } } })
  const inv = new InventoryManager({
    getBot: () => bot,
    config,
    logger: fakeLogger(),
    nav: { goto: async () => ({}), active: false },
    getMode: () => 'L0',
    sleepFn: async () => {},
    emit: () => {},
    notify: () => {}
  })
  const result = await inv.maybeCleanup({ reason: 'timer' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'paused_l0')
})

function gotoCount (gotos) { return gotos.length }
function pick (g) { return { x: g.x, y: g.y, z: g.z } }
