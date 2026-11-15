'use strict'

/**
 * Screen state authority (PRD §4, revised).
 *
 * Reading the real screen state from Termux requires `dumpsys power`, which is
 * a DUMP-permission call a normal app uid cannot make. Treating that failure as
 * "screen is on" would pin the bot at L2 forever on a real phone, so the
 * authority moved to *events*:
 *
 *   M1  the web UI reports Page Visibility (`visibilitychange`)
 *   M2  ACTION_SCREEN_ON / ACTION_SCREEN_OFF (no permission needed)
 *
 * Fail-safe direction is inverted on purpose: unknown == off. Losing a tier is
 * cheap (keepalive / health / auto-eat are tier-independent), staying at full
 * power all night is not.
 */
class ScreenStateTracker {
  constructor ({ getConfig, now = () => Date.now() }) {
    this.getConfig = getConfig
    this.now = now
    this.reported = null
    this.reportedAt = 0
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

  /** UI visibility report. Authoritative while the reporting client is connected. */
  report (on, at = this.now()) {
    this.reported = Boolean(on)
    this.reportedAt = at
  }

  setClients (count) {
    this.clients = Math.max(0, Number(count) || 0)
    if (this.clients === 0) {
      // The observer is gone; its last report is no longer evidence of anything.
      this.reported = null
      this.reportedAt = 0
    }
  }

  clientConnected () {
    this.setClients(this.clients + 1)
  }

  clientDisconnected () {
    this.setClients(this.clients - 1)
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
    const age = this.now() - this.reportedAt
    if (this.reported !== null && age <= this.config.reportStaleMs) {
      return this.decision(this.reported, 'ui', clientCount)
    }
    // Connected but never reported (or the report went stale): fail-safe off.
    return this.decision(false, 'unknown', clientCount)
  }

  decision (on, source, clientCount) {
    this.set(on, source)
    return { on: this.on, source: this.source, clients: clientCount }
  }

  snapshot () {
    return {
      on: this.on,
      source: this.source,
      clients: this.clients,
      reported: this.reported,
      reportedAt: this.reportedAt
    }
  }
}

module.exports = { ScreenStateTracker }
