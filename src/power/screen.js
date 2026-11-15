'use strict'

/**
 * Screen state authority (PRD §4, revised twice).
 *
 * Reading the real screen state from Termux requires `dumpsys power`, which is
 * a DUMP-permission call a normal app uid cannot make. Treating that failure as
 * "screen is on" would pin the bot at L2 forever on a real phone, so the
 * authority moved to *events*:
 *
 *   M1  the web UI reports Page Visibility (`visibilitychange` + heartbeat)
 *   M2  ACTION_SCREEN_ON / ACTION_SCREEN_OFF (no permission needed)
 *
 * Aggregation across clients: **any client reporting "on" wins**, so a phone
 * tab in the background cannot cancel a desktop tab that is visibly open.
 * When a client disconnects the remaining set is re-evaluated immediately.
 *
 * Fail-safe direction is inverted on purpose: unknown == off. Losing a tier is
 * cheap (keepalive / health / auto-eat are tier-independent), staying at full
 * power all night is not.
 */
class ScreenStateTracker {
  constructor ({ getConfig, now = () => Date.now() }) {
    this.getConfig = getConfig
    this.now = now
    this.reports = new Map() // clientId -> { on, at }
    this.clients = 0
    this.on = false
    this.source = 'unknown'
    this.changedAt = now()
  }

  get config () {
    return this.getConfig().power.screen
  }

  set (on, source) {
    if (on !== this.on) this.changedAt = this.now()
    this.on = on
    this.source = source
    return { on, source }
  }

  /** UI visibility report for one client. */
  report (clientId = 'default', on, at = this.now()) {
    this.reports.set(clientId, { on: Boolean(on), at })
  }

  /** Any upstream traffic proves the observer is alive: refresh its timestamp. */
  touch (clientId = 'default', at = this.now()) {
    const entry = this.reports.get(clientId)
    if (!entry) return false
    entry.at = at
    return true
  }

  removeClient (clientId) {
    this.reports.delete(clientId)
  }

  setClients (count) {
    this.clients = Math.max(0, Number(count) || 0)
    if (this.clients === 0) this.reports.clear()
  }

  /**
   * @param {object} opts
   * @param {number} [opts.clientCount]
   * @param {boolean|null} [opts.fallback] mock/desktop hint, only used headless
   * @returns {{on:boolean, source:string, clients:number}}
   */
  evaluate ({ clientCount = this.clients, fallback = null } = {}) {
    if (clientCount === 0) {
      // No UI attached: nobody can look at the HUD, so keep the cheapest tier.
      if (!this.config.requireClient && typeof fallback === 'boolean') {
        return this.decision(fallback, 'fallback', clientCount)
      }
      return this.decision(false, 'no_client', clientCount)
    }

    const now = this.now()
    const fresh = [...this.reports.values()].filter((r) => now - r.at <= this.config.reportStaleMs)
    if (fresh.length > 0) {
      // Any visible tab means the user is looking at the HUD.
      return this.decision(fresh.some((r) => r.on), 'ui', clientCount)
    }
    // Connected but never reported (or every report went stale): fail-safe off.
    return this.decision(false, 'unknown', clientCount)
  }

  decision (on, source, clientCount) {
    this.set(on, source)
    return { on: this.on, source: this.source, clients: clientCount }
  }

  snapshot () {
    const reports = {}
    for (const [id, entry] of this.reports) reports[id] = { ...entry }
    return {
      on: this.on,
      source: this.source,
      clients: this.clients,
      reports
    }
  }
}

module.exports = { ScreenStateTracker }
