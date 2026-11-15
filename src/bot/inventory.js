'use strict'

const { emptySlotCount, snapshotInventory, selectTossable } = require('./items')
const { validateDropPoint: defaultValidate, isSafeStanding } = require('./droppoint')

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
  constructor ({ getBot, config, logger, notify = () => {}, nav, getMode = () => 'L2', emit = () => {}, sleepFn = sleep, now = () => Date.now(), validateDropPoint = defaultValidate }) {
    this.getBot = getBot
    this.config = config
    this.logger = logger
    this.notify = notify
    this.nav = nav
    this.getMode = getMode
    this.emit = emit
    this.sleep = sleepFn
    this.now = now
    this.validateDropPoint = validateDropPoint
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
    let standing = null
    let startHealth = Number.isFinite(bot.health) ? bot.health : null
    this.lastReason = reason
    this.logger && this.logger.info(`cleanup start (${reason}) -> ${dp.type} ${dp.x},${dp.y},${dp.z}`)
    try {
      // Pre-flight: a bad drop point must fail loudly here, not as a 30s nav
      // timeout that leaves the farm silently full. Also picks a standing block
      // that is provably not lava instead of "somewhere within 2 blocks".
      const target = { x: dp.x, y: dp.y, z: dp.z }
      let range = 2
      if (dp.validate) {
        const check = this.validateDropPoint({ bot, point: dp, nav: this.nav })
        if (!check.ok) {
          const why = `${check.reason}`
          this.logger && this.logger.warn(`cleanup aborted: drop point unusable (${why})`)
          this.notify('warn', `丢弃点不可用（${why}），已跳过本次清包`)
          return { ok: false, reason: `drop_point_${why}` }
        }
        if (check.standing) {
          target.x = check.standing.x
          target.y = check.standing.y
          target.z = check.standing.z
          range = 0
          standing = check.standing
        }
      }

      await this.nav.goto(target.x, target.y, target.z, range, { reason: 'cleanup' })

      // The world moved while we walked (lava spread, block broken, chunk
      // reload). Re-check the spot before opening a container / tossing, so an
      // outdated pre-flight cannot drop the bot into a hazard.
      if (standing) {
        const live = isSafeStanding(bot, standing.x, standing.y, standing.z)
        if (!live.safe) {
          const why = live.reason
          this.logger && this.logger.warn(`cleanup aborted on arrival: standing spot unsafe (${why})`)
          this.notify('warn', `丢弃点已不安全（${why}），已中止清包并返回`)
          await this.returnHome(origin)
          return { ok: false, reason: `standing_unsafe_${why}`, tossed }
        }
      }

      const items = selectTossable(bot.inventory.items(), this.config)
      if (items.length === 0) {
        this.logger && this.logger.info('cleanup: nothing to toss')
        return { ok: true, tossed: 0 }
      }

      if (dp.type === 'container') {
        container = await this.openDropContainer(bot, dp)
      }
      if (Number.isFinite(bot.health) && startHealth === null) startHealth = bot.health

      for (const item of items) {
        if (!this.getBot() || !this.getBot().entity) throw new Error('disconnected during cleanup')
        // Standing next to lava / a mob is survivable for a second or two, not
        // for 10 stacks. Any damage means "leave now", not "finish the job".
        if (this.config.inv.abortOnDamage && startHealth !== null && Number.isFinite(bot.health) && bot.health < startHealth) {
          throw new Error(`受到伤害（HP ${bot.health}/${startHealth}），已中止清包并后撤`)
        }
        if (container && this.containerFull(container)) {
          throw new Error('目标容器已满，已停止清包')
        }
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
      await this.returnHome(origin)
      return { ok: false, reason: err.message, tossed }
    } finally {
      this.busy = false
      this.lastRunAt = this.now()
      this.emit({ t: 'inv', items: snapshotInventory(bot), empty: this.emptySlots(bot) })
    }
  }

  async returnHome (origin) {
    try {
      await this.nav.goto(origin.x, origin.y, origin.z, 1, { reason: 'cleanup-return' })
    } catch {}
  }

  /** A full hopper/chest would silently drop nothing; stop instead. */
  containerFull (container) {
    if (!container || typeof container.emptySlotCount !== 'function') return false
    try {
      return container.emptySlotCount() === 0
    } catch {
      return false
    }
  }

  async openDropContainer (bot, dp) {
    const block = bot.blockAt ? bot.blockAt({ x: dp.x, y: dp.y, z: dp.z }) : null
    if (!block) throw new Error('drop container block not loaded')
    const container = await bot.openContainer(block)
    if (this.containerFull(container)) {
      try { container.close() } catch {}
      throw new Error('目标容器已满，已停止清包')
    }
    return container
  }
}

module.exports = { InventoryManager }
