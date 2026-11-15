'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { isAllowedFood, selectFood, classifyItem, selectTossable, emptySlotCount } = require('../src/bot/items')
const { makeConfig, FakeBot } = require('./helpers')

const cfg = makeConfig()

test('food: blacklist wins over whitelist', () => {
  const eat = { whitelist: ['rotten_flesh', 'bread'], blacklist: ['rotten_flesh'] }
  assert.equal(isAllowedFood('rotten_flesh', eat), false)
  assert.equal(isAllowedFood('bread', eat), true)
  assert.equal(isAllowedFood('poisonous_potato', cfg.eat), false)
  assert.equal(isAllowedFood('raw_chicken', cfg.eat), false)
})

test('food: registry edible set is honoured', () => {
  const edible = new Set(['bread'])
  assert.equal(isAllowedFood('bread', cfg.eat, edible), true)
  assert.equal(isAllowedFood('apple', cfg.eat, edible), false)
})

test('food: selects highest food value, then biggest stack', () => {
  const items = [
    { name: 'bread', count: 3, foodPoints: 5 },
    { name: 'cooked_beef', count: 2, foodPoints: 8 },
    { name: 'rotten_flesh', count: 64, foodPoints: 4 },
    { name: 'cooked_beef', count: 9, foodPoints: 8 }
  ]
  assert.equal(selectFood(items, cfg.eat).count, 9)
})

test('food: returns null when only blacklisted food is present', () => {
  const items = [{ name: 'rotten_flesh', count: 10, foodPoints: 4 }]
  assert.equal(selectFood(items, cfg.eat), null)
})

test('retention: tools, weapons, armor and food are kept', () => {
  for (const name of ['diamond_pickaxe', 'iron_sword', 'netherite_chestplate', 'bread', 'bow', 'shield']) {
    assert.equal(classifyItem(name, cfg).keep, true, `${name} should be kept`)
  }
  for (const name of ['dirt', 'cobblestone', 'oak_log', 'rotten_flesh']) {
    assert.equal(classifyItem(name, cfg).keep, false, `${name} should be tossed`)
  }
})

test('tossable: sorted by stack size, excludes retained items', () => {
  const items = [
    { name: 'dirt', count: 12 },
    { name: 'cobblestone', count: 64 },
    { name: 'diamond_sword', count: 1 },
    { name: 'apple', count: 5 }
  ]
  const toss = selectTossable(items, cfg)
  assert.deepEqual(toss.map((i) => i.name), ['cobblestone', 'dirt'])
})

test('emptySlotCount only counts the 36 storage slots', () => {
  const bot = new FakeBot()
  assert.equal(emptySlotCount(bot), 36)
  bot.addItem('dirt', 1, 9)
  bot.addItem('stone', 1, 44)
  bot.inventory.slots[5] = { name: 'helmet' } // armor slot must not count
  assert.equal(emptySlotCount(bot), 34)
})
