'use strict'

const { selectFood, snapshotInventory } = require('./items')

/**
 * F5 auto-eat.
 *
 * - triggers when food <= threshold (default 14)
 * - only whitelisted food, blacklist always wins (rotten flesh / raw chicken /
 *   poisonous potato are never eaten)
 * - notifies once when food runs out, and at/below `eat.disconnectAtHealth`
 *   stops the bot: on normal difficulty starvation itself is not lethal, but a
 *   foodless bot dies to mobs, and the F9 breaker should be the last line.
 *
 * Red line: this listener must never be disabled by the power scheduler.
 */
class AutoEater {
  constructor ({ getBot, config, logger, notify = () => {}, nav = null, emit = () => {}, now = () => Date.now(), onStarving = null }) {
    this.getBot = getBot
    this.config = config
    this.logger = logger
    this.notify = notify
    this.nav = nav
    this.emit = emit
    this.now = now
    this.onStarving = onStarving
    this.busy = false
    this.outNotified = false
    this.starveNotified = false
    this.lastAttemptAt = 0
    this.cooldownMs = 1000
  }

  attach (bot) {
    if (!bot) return
    bot.on('health', () => {
      if (bot.food > this.config.eat.threshold) {
        this.outNotified = false
        this.starveNotified = false
      }
      this.check('health').catch((err) => this.logger && this.logger.error(`auto-eat failed: ${err.message}`))
    })
  }

  edibleSet (bot) {
    const foods = bot.registry && bot.registry.foodsByName
    return foods ? new Set(Object.keys(foods)) : null
  }

  foodItems (bot) {
    const registry = (bot.registry && bot.registry.itemsByName) || {}
    return bot.inventory.items().map((item) => ({
      ...item,
      foodPoints: (registry[item.name] && registry[item.name].foodPoints) || 0
    }))
  }

  /** @returns {Promise<{ok:boolean, reason?:string, food?:string}>} */
  async check (trigger = 'health', { force = false } = {}) {
    const bot = this.getBot()
    const cfg = this.config.eat
    if (!bot || !bot.entity || !bot.inventory) return { ok: false, reason: 'offline' }
    if (!cfg.enabled && !force) return { ok: false, reason: 'disabled' }
    if (this.busy) return { ok: false, reason: 'busy' }
    if (this.now() - this.lastAttemptAt < this.cooldownMs) return { ok: false, reason: 'cooldown' }
    if (!force && bot.food > cfg.threshold) return { ok: false, reason: 'not_hungry' }
    if (bot.food >= 20 && force) return { ok: false, reason: 'full' }

    const items = this.foodItems(bot)
    const chosen = selectFood(items, cfg, this.edibleSet(bot))
    if (!chosen) {
      if (!this.outNotified) {
        this.outNotified = true
        this.logger && this.logger.warn('food exhausted: nothing edible left')
        this.notify('warn', '食物耗尽，请补充食物')
      }
      this.checkStarving(bot)
      return { ok: false, reason: 'no_food' }
    }

    if (this.starveNotified) this.starveNotified = false

    this.busy = true
    this.lastAttemptAt = this.now()
    const goal = this.nav && this.nav.active ? this.nav.pause() : null
    this.logger && this.logger.info(`eating ${chosen.name} (food ${bot.food}/${cfg.threshold})`)
    try {
      await this.withTimeout(bot.consume(), 15000, 'eat_timeout')
      this.outNotified = false
      this.emit({ t: 'inv', items: snapshotInventory(bot), empty: undefined })
      return { ok: true, food: chosen.name }
    } catch (err) {
      this.logger && this.logger.warn(`eat aborted: ${err.message}`)
      return { ok: false, reason: err.message }
    } finally {
      this.busy = false
      if (goal && this.nav) {
        this.nav.resume(goal).catch((err) => this.logger && this.logger.warn(`resume nav failed: ${err.message}`))
      }
    }
  }

  /**
   * Foodless + hurt: a normal-difficulty bot will not starve to death, it dies
   * to the next mob. Alert immediately; at the configured HP stop the bot so
   * the user can restock instead of watching the F9 breaker count deaths.
   */
  checkStarving (bot) {
    const limit = Number(this.config.eat.disconnectAtHealth) || 0
    if (limit <= 0) return
    const hp = Number.isFinite(bot.health) ? bot.health : null
    if (hp === null || hp > limit) return
    if (this.starveNotified) return
    this.starveNotified = true
    this.logger && this.logger.warn(`food exhausted at ${hp} HP -> halt`)
    this.notify('warn', `食物耗尽且生命仅 ${hp}，准备停机以免死亡，请补充食物`)
    if (typeof this.onStarving === 'function') {
      try {
        this.onStarving({ health: hp, reason: 'food_exhausted' })
      } catch (err) {
        this.logger && this.logger.error(`onStarving failed: ${err.message}`)
      }
    }
  }

  withTimeout (promise, ms, reason) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(reason)), ms)
      if (timer.unref) timer.unref()
      Promise.resolve(promise).then(
        (value) => { clearTimeout(timer); resolve(value) },
        (err) => { clearTimeout(timer); reject(err) }
      )
    })
  }
}

module.exports = { AutoEater }
