'use strict'

/**
 * F9 auto-respawn (added by the PRD owner after the M1 review).
 *
 *   death -> wait respawn.delayMs -> bot.respawn() -> walk back to the waypoint
 *
 * A death loop (eaten out of food -> starve -> respawn -> starve) burns server
 * resources and looks like a griefer, so >= maxConsecutive deaths inside
 * `windowMs` halts the bot instead of retrying forever. The counter is also
 * cleared on a manual connect.
 */
class RespawnGuard {
  constructor ({ getBot, getConfig, logger, notify, onHalt = () => {}, emit = () => {}, now = () => Date.now() }) {
    this.getBot = getBot
    this.getConfig = getConfig
    this.logger = logger
    this.notify = notify
    this.onHalt = onHalt
    this.emit = emit
    this.now = now
    this.deaths = 0
    this.lastDeathAt = 0
    this.returnRequested = false
    this.timer = null
    this.attached = new WeakSet()
  }

  get guardConfig () {
    return this.getConfig().respawn
  }

  attach (bot) {
    if (!bot || this.attached.has(bot)) return
    this.attached.add(bot)
    bot.on('death', () => this.handleDeath(bot))
  }

  handleDeath (bot) {
    const cfg = this.guardConfig
    const at = this.now()
    if (!this.lastDeathAt || at - this.lastDeathAt > cfg.windowMs) this.deaths = 0
    this.deaths += 1
    this.lastDeathAt = at

    if (!cfg.enabled) {
      this.notify('warn', '角色死亡（自动重生已关闭）')
      return { ok: false, reason: 'disabled', deaths: this.deaths }
    }

    if (this.deaths >= cfg.maxConsecutive) {
      this.clearTimer()
      this.notify('warn', `连续死亡 ${this.deaths} 次，已停机（检查食物/挂机点安全）`)
      this.logger && this.logger.warn(`respawn circuit breaker tripped (${this.deaths} deaths)`)
      this.onHalt('respawn_limit', this.deaths)
      return { ok: false, reason: 'halted', deaths: this.deaths }
    }

    this.notify('warn', `角色死亡（第 ${this.deaths}/${cfg.maxConsecutive} 次），${Math.round(cfg.delayMs / 1000)}s 后重生`)
    this.logger && this.logger.warn(`death #${this.deaths} -> respawn in ${cfg.delayMs}ms`)
    // The waypoint trip must happen after the respawn, not now.
    this.returnRequested = true
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      const current = this.getBot()
      if (current !== bot || !bot || typeof bot.respawn !== 'function') return
      try {
        bot.respawn()
      } catch (err) {
        this.logger && this.logger.warn(`respawn failed: ${err.message}`)
        this.notify('warn', `重生失败：${err.message}`)
        this.returnRequested = false
      }
    }, cfg.delayMs)
    if (this.timer.unref) this.timer.unref()
    return { ok: true, deaths: this.deaths }
  }

  /** Called by the manager on spawn: true means "we came back from a death". */
  consumeReturnRequest () {
    const requested = this.returnRequested
    this.returnRequested = false
    return requested
  }

  reset () {
    this.deaths = 0
    this.lastDeathAt = 0
    this.returnRequested = false
    this.clearTimer()
  }

  clearTimer () {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  snapshot () {
    return {
      deaths: this.deaths,
      maxConsecutive: this.guardConfig.maxConsecutive,
      lastDeathAt: this.lastDeathAt
    }
  }
}

module.exports = { RespawnGuard }
