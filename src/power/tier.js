'use strict'

const MODES = ['L0', 'L1', 'L2', 'L3']
const RANK = { L2: 3, L1: 2, L0: 1, L3: 0 }

/**
 * F7 / PRD §4 power tier state machine.
 *
 * Rules, in priority order:
 *   1. L3  battery < 10% (unless charging) -> immediate, latched, no debounce
 *   2. manual forced tier (UI "强制 L2")  -> immediate
 *   3. L0  battery < 20% / thermal >= MODERATE / power-save
 *   4. L1  screen off && not navigating && idle for >= idleMs
 *   5. L2  everything else (screen on, navigating, or moving)
 *
 * Every automatic switch is debounced (>= 10s) so a flickering sensor cannot
 * bounce the tier. L3 and manual overrides bypass the debounce.
 */
class PowerTierController {
  constructor ({ config, now = () => Date.now(), onChange = null }) {
    this.config = config
    this.now = now
    this.onChange = onChange
    this.mode = 'L2'
    this.candidate = 'L2'
    this.candidateSince = now()
    this.lastChangeAt = now()
    this.forcedMode = config.power.forcedMode || null
    this.l3Latched = false
    this.lastSignals = {
      battery: null,
      charging: false,
      thermal: 0,
      screenOn: true,
      navActive: false,
      idle: false,
      powerSave: false
    }
  }

  compute (signals) {
    const p = this.config.power
    const battery = Number.isFinite(signals.battery) ? signals.battery : null
    const charging = Boolean(signals.charging)
    const skipL3 = charging && p.battery.l3SkipWhileCharging

    if (this.l3Latched) {
      const recovered = charging || (battery !== null && battery >= p.battery.l0Below)
      if (!recovered) return 'L3'
      this.l3Latched = false
    }

    if (battery !== null && battery < p.battery.l3Below && !skipL3) {
      return 'L3'
    }

    if (this.forcedMode) return this.forcedMode

    if (battery !== null && battery < p.battery.l0Below) return 'L0'
    if (Number(signals.thermal) >= p.thermal.l0AtOrAbove) return 'L0'
    if (signals.powerSave) return 'L0'

    if (!signals.screenOn && !signals.navActive && signals.idle) return 'L1'

    // Screen off but still moving (knockback, elevator, water) or navigating:
    // PRD L2 = "屏幕亮 或 正在寻路"; movement without nav is still activity.
    return 'L2'
  }

  /** Feed new sensor values. Returns the active mode (may still be the old one while debouncing). */
  update (signals) {
    this.lastSignals = { ...this.lastSignals, ...signals }
    const next = this.compute(this.lastSignals)

    if (next === 'L3' && this.mode !== 'L3') {
      this.l3Latched = true
      return this.apply('L3', true)
    }
    if (next === this.mode) {
      this.candidate = next
      return this.mode
    }
    if (next === this.candidate) {
      if (this.now() - this.candidateSince >= this.config.power.debounceMs) {
        return this.apply(next, false)
      }
      return this.mode
    }
    this.candidate = next
    this.candidateSince = this.now()
    return this.mode
  }

  apply (mode, immediate) {
    if (mode === this.mode) return this.mode
    const prev = this.mode
    this.mode = mode
    this.candidate = mode
    this.lastChangeAt = this.now()
    this.candidateSince = this.now()
    if (this.onChange) this.onChange(mode, prev, { immediate })
    return mode
  }

  /** UI override. null clears the override. Both are immediate (explicit user intent). */
  setForcedMode (mode) {
    if (mode !== null && !['L2', 'L1', 'L0'].includes(mode)) {
      throw new Error('forced mode must be L2, L1, L0 or null')
    }
    this.forcedMode = mode
    this.config.power.forcedMode = mode
    if (mode !== null) return this.apply(mode, true)
    // Returning to auto: recompute and apply now instead of waiting 10s.
    return this.apply(this.compute(this.lastSignals), true)
  }

  resetL3 () {
    this.l3Latched = false
    this.apply(this.compute(this.lastSignals), true)
  }

  get stateHz () {
    return this.config.power.stateHz[this.mode] || 2
  }

  get snapshot () {
    return {
      mode: this.mode,
      forced: this.forcedMode,
      candidate: this.candidate,
      lastChangeAt: this.lastChangeAt,
      signals: this.lastSignals,
      rank: RANK[this.mode]
    }
  }
}

module.exports = { PowerTierController, MODES, RANK }
