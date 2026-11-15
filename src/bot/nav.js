'use strict'

const DEFAULT_FACTORY = () => {
  const pf = require('mineflayer-pathfinder')
  return { pathfinder: pf.pathfinder, Movements: pf.Movements, goals: pf.goals }
}

/**
 * F4 simple navigation.
 *
 * Hard constraints (PRD): canDig=false, allowParkour=false,
 * allowFreeMotion=false, no block placing/scaffolding. A goto that does not
 * finish within nav.timeoutMs is abandoned and reported as failed(timeout).
 */
class Navigator {
  constructor ({ getBot, config, logger, emit = () => {}, factory = DEFAULT_FACTORY, now = () => Date.now() }) {
    this.getBot = getBot
    this.config = config
    this.logger = logger
    this.emit = emit
    this.factory = factory
    this.now = now
    this.state = { active: false, goal: null, startedAt: 0, paused: false }
    this.timer = null
    this.readyBots = new WeakSet()
    this.configuredBots = new WeakSet()
  }

  get active () {
    return this.state.active || this.state.paused
  }

  setup (bot) {
    if (!bot) return
    const { pathfinder } = this.factory()
    if (!bot.pathfinder) {
      if (!bot.loadPlugin) return
      bot.loadPlugin(pathfinder)
    }
    if (!this.readyBots.has(bot)) {
      this.readyBots.add(bot)
      bot.on('goal_reached', () => this.finish('reached'))
      bot.on('path_update', (result) => {
        if (!this.state.active) return
        if (result.status === 'noPath') {
          this.emitNav({ state: 'progress', status: 'noPath' })
        } else if (result.status === 'timeout') {
          this.finish('failed', 'pathfinder_timeout')
        }
      })
      // Movements needs bot.registry (the block table), which only exists after
      // login; createBot() returns before that, so re-try on spawn.
      bot.once('spawn', () => this.configureMovements(bot))
    }
    this.configureMovements(bot)
  }

  /** Builds Movements once a bot has a block registry. Returns true when ready. */
  configureMovements (bot) {
    if (!bot || !bot.pathfinder || !bot.registry) return false
    if (this.configuredBots.has(bot)) return true
    const { Movements } = this.factory()
    const movements = new Movements(bot)
    // PRD F4: simple walking only.
    movements.canDig = this.config.nav.canDig
    movements.allowParkour = this.config.nav.allowParkour
    movements.allowFreeMotion = this.config.nav.allowFreeMotion
    movements.allow1by1towers = false
    movements.allowSprinting = true
    movements.scafoldingBlocks = [] // never place blocks
    movements.canOpenDoors = true
    bot.pathfinder.setMovements(movements)
    this.configuredBots.add(bot)
    return true
  }

  /**
   * Synchronous reachability probe used before walking to a drop point.
   * `getPathTo` blocks the event loop, so keep the timeout small and only call
   * it for explicit pre-flight checks (drop point setup / cleanup start).
   */
  precheck (x, y, z, { timeoutMs = 2000 } = {}) {
    const bot = this.getBot()
    if (!bot || !bot.entity || !bot.pathfinder || !bot.registry) return { ok: true, checked: false }
    if (typeof bot.pathfinder.getPathTo !== 'function') return { ok: true, checked: false }
    try {
      this.configureMovements(bot)
      const { goals } = this.factory()
      const movements = bot.pathfinder.movements
      if (!movements) return { ok: true, checked: false }
      const result = bot.pathfinder.getPathTo(movements, new goals.GoalNear(x, y, z, 0), timeoutMs)
      const status = result && result.status
      const ok = Boolean(result && status === 'success' && Array.isArray(result.path) && result.path.length > 0)
      return { ok, checked: true, status }
    } catch (err) {
      // pathfinder internals changed / world not ready: do not block cleanup.
      this.logger && this.logger.warn(`path precheck failed: ${err.message}`)
      return { ok: true, checked: false, error: err.message }
    }
  }

  async goto (x, y, z, range, { reason = 'goto' } = {}) {    const bot = this.getBot()
    if (!bot || !bot.entity) throw new Error('bot is not in a world')
    for (const [name, value] of Object.entries({ x, y, z })) {
      if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`)
    }
    this.setup(bot)
    if (!this.configureMovements(bot)) throw new Error('bot is not ready yet (no block registry)')
    const { goals } = this.factory()
    const r = Number.isFinite(range) ? range : this.config.nav.range
    if (this.state.active) {
      this.logger && this.logger.warn(`replacing active navigation -> ${x},${y},${z}`)
      this.clearTimer()
    }
    this.state = { active: true, paused: false, goal: { x, y, z, range: r }, startedAt: this.now(), reason }
    this.emitNav({ state: 'started', goal: this.state.goal })
    this.timer = setTimeout(() => this.onTimeout(), this.config.nav.timeoutMs)
    if (this.timer.unref) this.timer.unref()
    bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, r))
    return this.state.goal
  }

  onTimeout () {
    if (!this.state.active) return
    this.logger && this.logger.warn(`goto timeout after ${this.config.nav.timeoutMs}ms -> abort`)
    this.stop('timeout')
  }

  stop (reason = 'stopped') {
    const bot = this.getBot()
    const goal = this.state.goal
    this.clearTimer()
    if (bot && bot.pathfinder) {
      try { bot.pathfinder.stop() } catch {}
      try { bot.pathfinder.setGoal(null) } catch {}
    }
    const wasActive = this.state.active || this.state.paused
    this.state = { active: false, paused: false, goal: null, startedAt: 0, reason }
    if (wasActive) {
      this.emitNav({ state: 'stopped', goal, reason })
    }
  }

  /** Pause for eating; the goal is kept so it can be resumed. */
  pause () {
    if (!this.state.active) return null
    const saved = this.state.goal
    this.clearTimer()
    const bot = this.getBot()
    if (bot && bot.pathfinder) {
      try { bot.pathfinder.stop() } catch {}
    }
    this.state = { active: false, paused: true, goal: saved, startedAt: this.state.startedAt, reason: 'paused' }
    this.emitNav({ state: 'paused', goal: saved })
    return saved
  }

  async resume (goal) {
    if (!goal) return
    await this.goto(goal.x, goal.y, goal.z, goal.range, { reason: 'resume' })
  }

  finish (state, reason) {
    if (!this.state.active && !this.state.paused) return
    const goal = this.state.goal
    const elapsed = this.now() - this.state.startedAt
    this.clearTimer()
    this.state = { active: false, paused: false, goal: null, startedAt: 0, reason }
    this.emitNav({ state, goal, reason, elapsed })
  }

  clearTimer () {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  emitNav (payload) {
    this.emit({ t: 'nav', ...payload })
  }

  snapshot () {
    return { ...this.state }
  }
}

module.exports = { Navigator }
