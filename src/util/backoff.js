'use strict'

/**
 * Exponential reconnect backoff: base, 2x, 4x ... capped (default 1s -> 60s).
 * F1: "断线指数退避重连 1→60s 封顶，无限重试".
 */
class Backoff {
  constructor ({ baseMs = 1000, maxMs = 60000, factor = 2 } = {}) {
    this.baseMs = baseMs
    this.maxMs = maxMs
    this.factor = factor
    this.attempt = 0
  }

  /** Returns the delay for the next attempt (and advances the counter). */
  next () {
    const raw = this.baseMs * Math.pow(this.factor, this.attempt)
    this.attempt += 1
    return Math.min(raw, this.maxMs)
  }

  /** Delay that would be used, without advancing. */
  peek () {
    return Math.min(this.baseMs * Math.pow(this.factor, this.attempt), this.maxMs)
  }

  /** Reset after a successful spawn / network change (立即重连). */
  reset () {
    this.attempt = 0
  }
}

module.exports = { Backoff }
