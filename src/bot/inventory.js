'use strict'

const { emptySlotCount, snapshotInventory, selectTossable } = require('./items')

const sleep = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms)
  if (t.unref) t.unref()
})

/**
 * F6 inventory cleanup.
 *
 * Trigger: empty slots < 3, or every 5 minutes.
 * Flow: walk to the CONFIGURED drop point -> serial tossStack with 300ms gap ->
 * walk back to the origin. Never tosses in place: item entities on the ground
 * cost the server more than an empty inventory slot saves.
 *
 * Paused in L0 (PRD §4) and refuses to run without a configured drop point.
 */
class InventoryManager {
  constructor ({ getBot, config, logger, notify = () => {}, nav, getMode = () => 'L2', emit = () => {}, sleepFn = sleep, now = () => Date.now() }) {
    this.getBot = getBot
    this.config = config
    this.logger = logger
    this.notify = notify
    this.nav = nav
    this.getMode = getMode
    this.emit = emit
    this.sleep = sleepFn
    this.now = now
    this.timer = null
    this.busy = false
    this.attached = new WeakSet()
    this.lastRunAt = 0
    this.lastReason = null
  }

  start () {
    this.stop()
    this.timer = setInterval(() => {
      this.maybeCleanup({ reason: 'timer' }).catch((err) => {
        this.logger && this.logger.error(`scheduled cleanup failed: ${err.message}`)
      })
    }, this.config.inv.intervalMs)
    if (this.timer.unref) this.timer.unref()
  }

  stop () {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  attach (bot) {
    if (!bot || this.attached.has(bot)) return
    this.attached.add(bot)
    let pending = null
    bot.on('playerCollect', () => {
      if (pending) return
      pending = setTimeout(() => {
        pending = null
        this.maybeCleanup({ reason: 'full' }).catch(() => {})
      }, 1500)
      if (pending.unref) pending.unref()
    })
  }

  emptySlots (bot) {
    return emptySlotCount(bot)
  }

  shouldCleanup (bot) {
    return this.emptySlots(bot) < this.config.inv.minEmptySlots
  }

  /** @returns {Promise<{ok:boolean, reason?:string}>} */
  async maybeCleanup ({ force = false, reason = 'manual' } = {}) {
    const bot = this.getBot()
    const inv = this.config.inv
    if (!bot || !bot.entity || !bot.inventory) return { ok: false, reason: 'offline' }
    if (!inv.enabled && !force) return { ok: false, reason: 'disabled' }
    if (this.busy) return { ok: false, reason: 'busy' }
    if (this.getMode() === 'L0' && !force) return { ok: false, reason: 'paused_l0' }
    if (!inv.dropPoint.set) {
      if (force) this.notify('warn', '未配置丢弃点，无法清包')
      return { ok: false, reason: 'no_drop_point' }
    }
    if (!force && reason === 'full' && !this.shouldCleanup(bot)) return { ok: false, reason: 'not_full' }
    if (this.nav && this.nav.active && !force) return { ok: false, reason: 'navigating' }
    if (this.nav && this.nav.active && force) this.nav.stop('cleanup')

    return this.run(bot, reason)
  }

  async run (bot, reason) {
    this.busy = true
    const dp = this.config.inv.dropPoint
    const origin = bot.entity.position.clone()
    let tossed = 0
    let container = null
    this.lastReason = reason
    this.logger && this.logger.info(`cleanup start (${reason}) -> ${dp.type} ${dp.x},${dp.y},${dp.z}`)
    try {
      await this.nav.goto(dp.x, dp.y, dp.z, 2, { reason: 'cleanup' })

      const items = selectTossable(bot.inventory.items(), this.config)
      if (items.length === 0) {
        this.logger && this.logger.info('cleanup: nothing to toss')
        return { ok: true, tossed: 0 }
      }

      if (dp.type === 'container') {
        container = await this.openDropContainer(bot, dp)
      }

      for (const item of items) {
        if (!this.getBot() || !this.getBot().entity) throw new Error('disconnected during cleanup')
        try {
          if (container) {
            await container.deposit(item.type, null, item.count)
          } else {
            await bot.tossStack(item)
          }
          tossed += 1
          this.emit({ t: 'inv', items: snapshotInventory(bot), empty: this.emptySlots(bot) })
        } catch (err) {
          this.logger && this.logger.warn(`toss failed for ${item.name}: ${err.message}`)
        }
        await this.sleep(this.config.inv.tossGapMs)
      }

      if (container) {
        try { container.close() } catch {}
        container = null
      }

      await this.nav.goto(origin.x, origin.y, origin.z, 1, { reason: 'cleanup-return' })
      this.logger && this.logger.info(`cleanup done: ${tossed} stacks, back at origin`)
      this.notify('info', `背包清理完成：丢弃 ${tossed} 组`)
      return { ok: true, tossed }
    } catch (err) {
      this.logger && this.logger.error(`cleanup failed: ${err.message}`)
      this.notify('warn', `背包清理失败：${err.message}`)
      // Best effort: go home even if the toss loop failed.
      try {
        if (container) container.close()
      } catch {}
      try {
        await this.nav.goto(origin.x, origin.y, origin.z, 1, { reason: 'cleanup-return' })
      } catch {}
      return { ok: false, reason: err.message, tossed }
    } finally {
      this.busy = false
      this.lastRunAt = this.now()
      this.emit({ t: 'inv', items: snapshotInventory(bot), empty: this.emptySlots(bot) })
    }
  }

  async openDropContainer (bot, dp) {
    const block = bot.blockAt ? bot.blockAt({ x: dp.x, y: dp.y, z: dp.z }) : null
    if (!block) throw new Error('drop container block not loaded')
    const container = await bot.openContainer(block)
    return container
  }
}

module.exports = { InventoryManager }
