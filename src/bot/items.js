'use strict'

const ARMOR_SUFFIXES = ['_helmet', '_chestplate', '_leggings', '_boots']
const EXTRA_ARMOR = new Set(['elytra', 'turtle_helmet', 'shield', 'carved_pumpkin', 'player_head'])
const TOOL_SUFFIXES = ['_pickaxe', '_axe', '_shovel', '_hoe', '_sword']
const EXTRA_TOOLS = new Set([
  'shears', 'flint_and_steel', 'fishing_rod', 'compass', 'clock',
  'spyglass', 'brush', 'lead', 'bucket', 'water_bucket', 'lava_bucket',
  'milk_bucket', 'torch', 'oak_planks'
])
const EXTRA_WEAPONS = new Set(['bow', 'crossbow', 'trident', 'arrow', 'spectral_arrow', 'tipped_arrow', 'mace'])

function isArmor (name) {
  return ARMOR_SUFFIXES.some((suffix) => name.endsWith(suffix)) || EXTRA_ARMOR.has(name)
}

function isTool (name) {
  return TOOL_SUFFIXES.some((suffix) => name.endsWith(suffix)) || EXTRA_TOOLS.has(name)
}

function isWeapon (name) {
  return EXTRA_WEAPONS.has(name) || name.endsWith('_sword')
}

/**
 * Food that is allowed to be eaten. Blacklist always wins (PRD F5).
 * @param {string} name item name
 * @param {{whitelist: string[], blacklist: string[]}} eatCfg
 * @param {Set<string>|null} edibleNames optional registry-derived "is actually edible" set
 */
function isAllowedFood (name, eatCfg, edibleNames = null) {
  if (!name) return false
  if (eatCfg.blacklist.includes(name)) return false
  if (edibleNames && !edibleNames.has(name)) return false
  return eatCfg.whitelist.includes(name)
}

/** Pick the best food stack to eat: prefer high food value, then larger stack. */
function selectFood (items, eatCfg, edibleNames = null) {
  const candidates = items.filter((item) =>
    isAllowedFood(item.name, eatCfg, edibleNames) && item.count > 0
  )
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    const fa = a.foodPoints || 0
    const fb = b.foodPoints || 0
    if (fb !== fa) return fb - fa
    return b.count - a.count
  })
  return candidates[0]
}

/**
 * F6 retention rules: tools / weapons / armor / food never get tossed.
 * @returns {{keep: boolean, category: string|null}}
 */
function classifyItem (name, cfg) {
  const retain = new Set(cfg.inv.retainCategories)
  if (retain.has('food') && isAllowedFood(name, cfg.eat)) {
    return { keep: true, category: 'food' }
  }
  if (retain.has('armor') && isArmor(name)) {
    return { keep: true, category: 'armor' }
  }
  if (retain.has('weapons') && isWeapon(name)) {
    return { keep: true, category: 'weapons' }
  }
  if (retain.has('tools') && isTool(name)) {
    return { keep: true, category: 'tools' }
  }
  return { keep: false, category: null }
}

/** Items that are safe to toss, biggest stacks first (fewer toss calls). */
function selectTossable (items, cfg) {
  return items
    .filter((item) => item.count > 0 && !classifyItem(item.name, cfg).keep)
    .sort((a, b) => b.count - a.count)
}

/** Count of truly empty storage slots (main inventory 9-35 + hotbar 36-44). */
function emptySlotCount (bot) {
  const slots = bot.inventory && bot.inventory.slots ? bot.inventory.slots : []
  let used = 0
  for (let i = 9; i <= 44; i++) {
    if (slots[i]) used += 1
  }
  return Math.max(0, 36 - used)
}

function snapshotInventory (bot) {
  if (!bot || !bot.inventory) return []
  return bot.inventory.items().map((item) => ({
    name: item.name,
    displayName: item.displayName,
    count: item.count,
    slot: item.slot,
    type: item.type
  }))
}

module.exports = {
  isArmor,
  isTool,
  isWeapon,
  isAllowedFood,
  selectFood,
  classifyItem,
  selectTossable,
  emptySlotCount,
  snapshotInventory
}
