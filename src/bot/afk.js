'use strict'

/**
 * §7 risk mitigation: some servers kick players who never send movement/look.
 * Optional head swing / look, disabled by default.
 */
class AfkKeeper {
  constructor ({ getBot, config, logger = null, getMode = () => 'L2' }) {
    this.getBot = getBot
    this.config = config
    this.logger = logger
    this.getMode = getMode
    this.timer = null
  }

  start () {
    this.stop()
    if (!this.config.afk.enabled) return
    this.timer = setInterval(() => this.tick(), this.config.afk.intervalMs)
    if (this.timer.unref) this.timer.unref()
  }

  stop () {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  tick () {
    const bot = this.getBot()
    if (!bot || !bot.entity) return
    // L0/L3 must stay quiet; L1 is fine because yaw changes do not move the
    // player and therefore do not break idle detection.
    const mode = this.getMode()
    if (mode === 'L0' || mode === 'L3') return
    try {
      if (this.config.afk.action === 'swing') {
        bot.swingArm('right', true)
      } else {
        const yaw = (bot.entity.yaw || 0) + (Math.random() - 0.5) * 0.8
        const pitch = (bot.entity.pitch || 0) + (Math.random() - 0.5) * 0.2
        bot.look(yaw, pitch, true)
      }
    } catch (err) {
      this.logger && this.logger.debug(`afk action failed: ${err.message}`)
    }
  }
}

module.exports = { AfkKeeper }
