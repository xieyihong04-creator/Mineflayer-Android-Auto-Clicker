'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { InventoryManager } = require('../src/bot/inventory')
const { FakeBot, FakePosition, makeConfig, fakeLogger, makeWorldBot } = require('./helpers')

function makeInv ({ configPatch = {}, bot = new FakeBot(), validateDropPoint = undefined, now = undefined } = {}) {
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
    notify: () => {},
    ...(now ? { now } : {}),
    ...(validateDropPoint ? { validateDropPoint } : {})
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
    // This fake world answers "chest" for every coordinate, so the standing
    // spot scan has no meaning here; the container path is what is under test.
    validateDropPoint: () => ({ ok: true, checked: false }),
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

test('F6: aborts and walks home when HP drops during the toss loop', async () => {
  const bot = fillBot(new FakeBot({ pos: new FakePosition(0, 70, 0) }))
  const notes = []
  bot.tossStack = async (item) => {
    bot.tossed.push(item.name)
    if (bot.tossed.length === 1) bot.health = 11
  }
  const { inv, gotos } = makeInv({
    bot,
    validateDropPoint: () => ({ ok: true, checked: false })
  })
  inv.notify = (level, msg) => notes.push({ level, msg })
  const result = await inv.maybeCleanup({ force: true, reason: 'full' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /受到伤害/)
  assert.equal(result.tossed, 1, 'the loop stops right after the damage')
  assert.equal(bot.tossed.length, 1)
  assert.deepEqual(pick(gotos.at(-1)), { x: 0, y: 70, z: 0 }, 'retreats home')
  assert.ok(notes.some((n) => /受到伤害/.test(n.msg)))
})

test('F6: re-validates the standing spot on arrival (world may have changed)', async () => {
  const bot = fillBot(makeWorldBot({ '10,63,10': 'lava' }, { pos: new FakePosition(0, 70, 0) }))
  const { inv, gotos } = makeInv({
    bot,
    validateDropPoint: () => ({ ok: true, checked: true, standing: { x: 10, y: 64, z: 10 } })
  })
  const result = await inv.maybeCleanup({ force: true, reason: 'full' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /^standing_unsafe_/)
  assert.equal(bot.tossed.length, 0, 'never tosses from an unsafe spot')
  assert.equal(gotoCount(gotos), 2, 'walks to the point, then back home')
})

test('F6: a full container aborts instead of pretending to deposit', async () => {
  const bot = fillBot(new FakeBot({ pos: new FakePosition(0, 70, 0) }))
  let closed = false
  bot.blockAt = () => ({ name: 'hopper', position: { x: 100, y: 64, z: -200 } })
  bot.openContainer = async () => ({
    deposit: async () => {},
    emptySlotCount: () => 0,
    close: () => { closed = true }
  })
  const { inv } = makeInv({
    bot,
    validateDropPoint: () => ({ ok: true, checked: false }),
    configPatch: { inv: { dropPoint: { set: true, type: 'container', x: 100, y: 64, z: -200 } } }
  })
  const result = await inv.maybeCleanup({ force: true, reason: 'full' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /容器已满/)
  assert.equal(closed, true)
})

test('F6: a container that fills mid-loop stops the deposit run', async () => {
  const bot = fillBot(new FakeBot({ pos: new FakePosition(0, 70, 0) }))
  let slots = 2
  const deposits = []
  bot.blockAt = () => ({ name: 'chest', position: { x: 100, y: 64, z: -200 } })
  bot.openContainer = async () => ({
    deposit: async (type, metadata, count) => { deposits.push(count); slots -= 1 },
    emptySlotCount: () => slots,
    close: () => {}
  })
  const { inv } = makeInv({
    bot,
    validateDropPoint: () => ({ ok: true, checked: false }),
    configPatch: { inv: { dropPoint: { set: true, type: 'container', x: 100, y: 64, z: -200 } } }
  })
  const result = await inv.maybeCleanup({ force: true, reason: 'full' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /容器已满/)
  assert.equal(deposits.length, 2)
  assert.equal(result.tossed, 2)
})

test('F6: a damage abort still closes the container window', async () => {
  const bot = fillBot(new FakeBot({ pos: new FakePosition(0, 70, 0) }))
  let closeCalls = 0
  bot.blockAt = () => ({ name: 'chest', position: { x: 100, y: 64, z: -200 } })
  bot.openContainer = async () => ({
    selectedItem: null,
    deposit: async () => { bot.health = 12 },
    emptySlotCount: () => 5,
    close: () => { closeCalls += 1 }
  })
  const notes = []
  const { inv, gotos } = makeInv({
    bot,
    validateDropPoint: () => ({ ok: true, checked: false }),
    configPatch: { inv: { dropPoint: { set: true, type: 'container', x: 100, y: 64, z: -200 } } }
  })
  inv.notify = (level, msg) => notes.push(msg)
  const result = await inv.maybeCleanup({ force: true, reason: 'manual' })
  assert.equal(result.ok, false)
  assert.equal(closeCalls, 1, 'window is closed exactly once on the abort path')
  assert.ok(notes.some((m) => /受到伤害/.test(m)))
  assert.ok(notes.some((m) => /已丢 1 组/.test(m)), 'the abort message says how far it got')
  assert.deepEqual(pick(gotos.at(-1)), { x: 0, y: 70, z: 0 }, 'closes, then walks home')
})

test('F6: closing with a stack on the cursor is reported, not silently lost', async () => {
  const bot = fillBot(new FakeBot({ pos: new FakePosition(0, 70, 0) }))
  bot.blockAt = () => ({ name: 'chest', position: { x: 100, y: 64, z: -200 } })
  bot.openContainer = async () => ({
    selectedItem: { name: 'dirt', count: 32 },
    deposit: async () => {},
    emptySlotCount: () => 0,
    close: () => {}
  })
  const notes = []
  const { inv } = makeInv({
    bot,
    validateDropPoint: () => ({ ok: true, checked: false }),
    configPatch: { inv: { dropPoint: { set: true, type: 'container', x: 100, y: 64, z: -200 } } }
  })
  inv.notify = (level, msg) => notes.push(msg)
  const result = await inv.maybeCleanup({ force: true, reason: 'manual' })
  assert.equal(result.ok, false)
  assert.ok(notes.some((m) => /容器已满/.test(m)))
  assert.ok(notes.some((m) => /手上还有 32 个 dirt/.test(m)))
})

test('F6: the same abort is not re-toasted on every 5-minute retry', async () => {
  const bot = fillBot(new FakeBot({ pos: new FakePosition(0, 70, 0) }))
  bot.blockAt = () => ({ name: 'hopper', position: { x: 100, y: 64, z: -200 } })
  bot.openContainer = async () => ({
    deposit: async () => {},
    emptySlotCount: () => 0,
    close: () => {}
  })
  let clock = 1000
  const notes = []
  const { inv } = makeInv({
    bot,
    now: () => clock,
    validateDropPoint: () => ({ ok: true, checked: false }),
    configPatch: { inv: { dropPoint: { set: true, type: 'container', x: 100, y: 64, z: -200 } } }
  })
  inv.notify = (level, msg) => notes.push(msg)
  await inv.maybeCleanup({ reason: 'timer' })
  await inv.maybeCleanup({ reason: 'timer' })
  assert.equal(notes.filter((m) => /容器已满/.test(m)).length, 1, 'deduped within 10 minutes')
  clock += 11 * 60 * 1000
  await inv.maybeCleanup({ reason: 'timer' })
  assert.equal(notes.filter((m) => /容器已满/.test(m)).length, 2, 're-reported after the window')
})
