'use strict'

let Vec3 = null
try {
  Vec3 = require('vec3')
} catch {
  Vec3 = null
}

const HAZARDS = new Set([
  'lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush',
  'campfire', 'soul_campfire', 'powder_snow', 'wither_rose', 'pointed_dripstone'
])

const CONTAINERS = new Set([
  'chest', 'trapped_chest', 'barrel', 'hopper', 'dropper', 'dispenser',
  'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'brewing_stand'
])

function isContainerName (name) {
  return CONTAINERS.has(name) || /_shulker_box$/.test(name || '')
}

function vec (x, y, z) {
  if (Vec3) return new Vec3(x, y, z)
  return { x, y, z }
}

function blockAt (bot, x, y, z) {
  if (!bot || typeof bot.blockAt !== 'function') return null
  try {
    return bot.blockAt(vec(x, y, z))
  } catch {
    return null
  }
}

function isEmpty (block) {
  return !block || (block.boundingBox === 'empty' && !block.liquid)
}

function isSolid (block) {
  return Boolean(block) && block.boundingBox !== 'empty'
}

/**
 * A standing spot is safe when the feet and head are free, the floor is solid,
 * and nothing in the 3-block column is lava/fire/cactus/magma.
 */
function isSafeStanding (bot, x, y, z) {
  const feet = blockAt(bot, x, y, z)
  const head = blockAt(bot, x, y + 1, z)
  const floor = blockAt(bot, x, y - 1, z)
  if (!feet || !head) return { safe: false, reason: 'chunk_not_loaded' }
  if (HAZARDS.has(feet.name) || HAZARDS.has(head.name)) return { safe: false, reason: 'standing_in_hazard' }
  if (feet.liquid || head.liquid) return { safe: false, reason: 'standing_in_liquid' }
  if (!isEmpty(feet) || !isEmpty(head)) return { safe: false, reason: 'standing_space_blocked' }
  if (!floor || !isSolid(floor)) return { safe: false, reason: 'no_floor' }
  if (HAZARDS.has(floor.name) || floor.name === 'lava' || floor.name === 'water') {
    return { safe: false, reason: 'hazardous_floor' }
  }
  return { safe: true }
}

/**
 * Finds the closest safe standing block to the drop point. The bot walks to
 * GoalNear(point, 2) today, which can land it on top of the lava; this scan
 * picks the actual block it should stand on.
 */
function findStandingSpot (bot, point, maxDistance) {
  const candidates = []
  for (let dx = -maxDistance; dx <= maxDistance; dx++) {
    for (let dz = -maxDistance; dz <= maxDistance; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        if (dx === 0 && dz === 0 && dy === 0) continue
        const x = Math.floor(point.x) + dx
        const y = Math.floor(point.y) + dy
        const z = Math.floor(point.z) + dz
        const distance = Math.hypot(dx, dy, dz)
        if (distance > maxDistance) continue
        const check = isSafeStanding(bot, x, y, z)
        if (check.safe) candidates.push({ x, y, z, distance })
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance)
  return candidates[0] || null
}

/**
 * Pre-flight check for the configured drop point.
 *
 * @returns {{ok:boolean, checked:boolean, reason?:string, standing?:object, target?:string}}
 *   `checked:false` means the bot has no world data yet (config edited while
 *   offline); the caller should save the point but warn.
 */
function validateDropPoint ({ bot, point, nav = null, precheck = null }) {
  if (!bot || !bot.entity || typeof bot.blockAt !== 'function') {
    return { ok: true, checked: false, reason: 'no_world' }
  }
  if (!point || point.set !== true) return { ok: false, checked: true, reason: 'not_configured' }

  const tx = Math.floor(point.x)
  const ty = Math.floor(point.y)
  const tz = Math.floor(point.z)
  const target = blockAt(bot, tx, ty, tz)
  if (!target) return { ok: false, checked: true, reason: 'target_not_loaded' }

  if (point.type === 'lava') {
    if (target.name !== 'lava') {
      return { ok: false, checked: true, reason: `target_is_${target.name}_not_lava`, target: target.name }
    }
  } else if (point.type === 'container') {
    if (!isContainerName(target.name)) {
      return { ok: false, checked: true, reason: `target_is_${target.name}_not_container`, target: target.name }
    }
  }

  const maxDistance = Math.max(1, Number(point.maxStandDistance) || 3)
  const standing = findStandingSpot(bot, { x: tx, y: ty, z: tz }, maxDistance)
  if (!standing) {
    return { ok: false, checked: true, reason: 'no_safe_standing_spot', target: target.name }
  }

  const reach = precheck
    ? precheck(standing)
    : nav && typeof nav.precheck === 'function' ? nav.precheck(standing.x, standing.y, standing.z) : { ok: true, checked: false }
  if (reach && reach.checked && reach.ok === false) {
    return {
      ok: false,
      checked: true,
      reason: `unreachable_${reach.status || 'unknown'}`,
      target: target.name,
      standing
    }
  }

  return { ok: true, checked: true, reason: null, target: target.name, standing, reach }
}

module.exports = {
  validateDropPoint,
  findStandingSpot,
  isSafeStanding,
  isContainerName,
  HAZARDS,
  CONTAINERS
}
