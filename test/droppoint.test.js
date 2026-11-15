'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { validateDropPoint, isSafeStanding, findStandingSpot } = require('../src/bot/droppoint')
const { InventoryManager } = require('../src/bot/inventory')
const { makeWorldBot, makeConfig, fakeLogger, FakeBot } = require('./helpers')

const point = (over = {}) => ({ set: true, type: 'lava', x: 10, y: 64, z: 10, validate: true, maxStandDistance: 3, ...over })

/** Flat stone floor at y=63 around 8..12 with a lava block at 10,64,10. */
function lavaPool () {
  const blocks = {}
  for (let x = 6; x <= 14; x++) {
    for (let z = 6; z <= 14; z++) blocks[`${x},63,${z}`] = 'stone'
  }
  blocks['10,64,10'] = 'lava'
  return makeWorldBot(blocks)
}

test('droppoint: lava drop point resolves to a real safe standing block', () => {
  const bot = lavaPool()
  const result = validateDropPoint({ bot, point: point() })
  assert.equal(result.ok, true)
  assert.equal(result.target, 'lava')
  assert.ok(result.standing)
  assert.equal(Math.hypot(result.standing.x - 10, result.standing.z - 10) <= 3, true)
  // The chosen block must not be the lava block itself.
  assert.notDeepEqual([result.standing.x, result.standing.y, result.standing.z], [10, 64, 10])
})

test('droppoint: refuses a target that is not lava (e.g. "walk here" typo)', () => {
  const bot = makeWorldBot({ '0,63,0': 'stone' })
  const result = validateDropPoint({ bot, point: point({ x: 0, y: 64, z: 0 }) })
  assert.equal(result.ok, false)
  assert.match(result.reason, /not_lava/)
})

test('droppoint: lava with no walkable floor around it -> no_safe_standing_spot', () => {
  const bot = makeWorldBot({ '0,64,0': 'lava' }) // nothing solid anywhere
  const result = validateDropPoint({ bot, point: point({ x: 0, y: 64, z: 0 }) })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no_safe_standing_spot')
})

test('droppoint: unreachable standing spot is reported, not walked', () => {
  const bot = lavaPool()
  const result = validateDropPoint({
    bot,
    point: point(),
    precheck: () => ({ ok: false, checked: true, status: 'noPath' })
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unreachable_noPath')
})

test('droppoint: container target validates by block name', () => {
  const blocks = { '0,63,0': 'stone', '3,64,3': 'chest' }
  const bot = makeWorldBot(blocks)
  const ok = validateDropPoint({ bot, point: point({ type: 'container', x: 3, y: 64, z: 3 }) })
  assert.equal(ok.ok, true)
  assert.equal(ok.target, 'chest')
  const bad = validateDropPoint({ bot, point: point({ type: 'container', x: 0, y: 64, z: 0 }) })
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /not_container/)
})

test('droppoint: offline bot is skipped instead of blocking config edits', () => {
  const result = validateDropPoint({ bot: new FakeBot(), point: point() })
  assert.equal(result.ok, true)
  assert.equal(result.checked, false)
})

test('droppoint: standing in lava or water is never considered safe', () => {
  const bot = makeWorldBot({ '0,63,0': 'stone', '0,64,0': 'lava', '2,63,2': 'stone', '2,64,2': 'water' })
  assert.equal(isSafeStanding(bot, 0, 64, 0).safe, false)
  assert.equal(isSafeStanding(bot, 2, 64, 2).safe, false)
})

test('droppoint: scan ignores candidate blocks above the target ceiling', () => {
  const bot = lavaPool()
  const spot = findStandingSpot(bot, { x: 10, y: 64, z: 10 }, 2)
  assert.ok(spot)
  assert.ok(spot.y <= 65 && spot.y >= 62)
})

test('F6: cleanup aborts loudly on an unsafe drop point (no silent 30s timeout)', async () => {
  const bot = new FakeBot()
  for (let i = 9; i <= 42; i++) bot.addItem('dirt', 64, i)
  const gotos = []
  const notifications = []
  const inv = new InventoryManager({
    getBot: () => bot,
    config: makeConfig({ inv: { dropPoint: point() } }),
    logger: fakeLogger(),
    nav: {
      active: false,
      goto: async (x, y, z) => { gotos.push({ x, y, z }); return {} },
      stop: () => {},
      precheck: () => ({ ok: true, checked: false })
    },
    getMode: () => 'L2',
    sleepFn: async () => {},
    emit: () => {},
    notify: (level, msg) => notifications.push([level, msg]),
    validateDropPoint: () => ({ ok: false, checked: true, reason: 'target_is_dirt_not_lava' })
  })
  const result = await inv.maybeCleanup({ force: true, reason: 'full' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'drop_point_target_is_dirt_not_lava')
  assert.equal(gotos.length, 0, 'must not start walking to a known-bad point')
  assert.equal(bot.tossed.length, 0)
  assert.match(notifications.at(-1)[1], /丢弃点不可用/)
})

test('F6: cleanup walks to the validated standing block, not the lava block', async () => {
  const bot = lavaPool()
  for (let i = 9; i <= 42; i++) bot.addItem('dirt', 64, i)
  const gotos = []
  const inv = new InventoryManager({
    getBot: () => bot,
    config: makeConfig({ inv: { dropPoint: point() } }),
    logger: fakeLogger(),
    nav: {
      active: false,
      goto: async (x, y, z, range) => { gotos.push({ x, y, z, range }); return {} },
      stop: () => {}
    },
    getMode: () => 'L2',
    sleepFn: async () => {},
    emit: () => {},
    notify: () => {}
  })
  const result = await inv.maybeCleanup({ force: true, reason: 'full' })
  assert.equal(result.ok, true)
  const first = gotos[0]
  assert.equal(first.range, 0)
  assert.notDeepEqual([first.x, first.y, first.z], [10, 64, 10])
  assert.equal(bot.tossed.length, 34)
})
