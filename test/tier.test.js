'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { PowerTierController } = require('../src/power/tier')
const { makeConfig } = require('./helpers')

function clock () {
  let t = 0
  return { now: () => t, tick: (ms) => { t += ms } }
}

const awake = { battery: 80, charging: false, thermal: 0, screenOn: true, navActive: false, idle: false, powerSave: false }

test('L2 while screen is on', () => {
  const c = clock()
  const tier = new PowerTierController({ config: makeConfig(), now: c.now })
  assert.equal(tier.update(awake), 'L2')
})

test('L1 after screen off + idle, and only after the 10s debounce', () => {
  const c = clock()
  const tier = new PowerTierController({ config: makeConfig(), now: c.now })
  const off = { ...awake, screenOn: false, idle: true }
  assert.equal(tier.update(off), 'L2')
  c.tick(9000)
  assert.equal(tier.update(off), 'L2', 'still debouncing at 9s')
  c.tick(1000)
  assert.equal(tier.update(off), 'L1', 'switch allowed at 10s')
})

test('navigating keeps L2 even with the screen off', () => {
  const c = clock()
  const tier = new PowerTierController({ config: makeConfig(), now: c.now })
  const nav = { ...awake, screenOn: false, navActive: true, idle: false }
  const offIdle = { ...awake, screenOn: false, idle: true }
  assert.equal(tier.update(nav), 'L2')
  c.tick(10500)
  assert.equal(tier.update(offIdle), 'L2', 'debounce starts')
  c.tick(10500)
  assert.equal(tier.update(offIdle), 'L1', 'still -> L1 while idle')
  c.tick(10500)
  assert.equal(tier.update(nav), 'L1', 'nav starts the L2 debounce')
  c.tick(10000)
  assert.equal(tier.update(nav), 'L2', 'nav returns to L2 after debounce')
})

test('L0 at battery < 20', () => {
  const c = clock()
  const tier = new PowerTierController({ config: makeConfig(), now: c.now })
  assert.equal(tier.update({ ...awake, battery: 19 }), 'L2', 'debounce starts')
  c.tick(10000)
  assert.equal(tier.update({ ...awake, battery: 19 }), 'L0')
})

test('L0 on thermal >= MODERATE(2) and on power save', () => {
  const c = clock()
  const tier = new PowerTierController({ config: makeConfig(), now: c.now })
  assert.equal(tier.compute({ ...awake, thermal: 2 }), 'L0')
  assert.equal(tier.compute({ ...awake, powerSave: true }), 'L0')
})

test('L3 at battery < 10 is immediate (no debounce) and latched', () => {
  const c = clock()
  const changes = []
  const tier = new PowerTierController({
    config: makeConfig(),
    now: c.now,
    onChange: (mode, prev, meta) => changes.push({ mode, prev, immediate: meta.immediate })
  })
  assert.equal(tier.update({ ...awake, battery: 9 }), 'L3')
  assert.deepEqual(changes[0], { mode: 'L3', prev: 'L2', immediate: true })
  c.tick(1000)
  assert.equal(tier.update({ ...awake, battery: 15 }), 'L3', 'latched until recovery')
})

test('L3 is skipped while charging', () => {
  const tier = new PowerTierController({ config: makeConfig() })
  assert.equal(tier.compute({ ...awake, battery: 5, charging: true }), 'L0')
})

test('L3 latch clears when charging resumes', () => {
  const c = clock()
  const tier = new PowerTierController({ config: makeConfig(), now: c.now })
  tier.update({ ...awake, battery: 9 })
  assert.equal(tier.mode, 'L3')
  c.tick(10000)
  tier.update({ ...awake, battery: 12, charging: true })
  c.tick(10000)
  assert.equal(tier.update({ ...awake, battery: 12, charging: true }), 'L0')
})

test('manual force L2 overrides battery-based L0 immediately', () => {
  const c = clock()
  const tier = new PowerTierController({ config: makeConfig(), now: c.now })
  tier.update({ ...awake, battery: 15 })
  c.tick(10000)
  tier.update({ ...awake, battery: 15 })
  assert.equal(tier.mode, 'L0')
  assert.equal(tier.setForcedMode('L2'), 'L2')
  c.tick(60000)
  assert.equal(tier.update({ ...awake, battery: 15 }), 'L2')
  assert.equal(tier.setForcedMode(null), 'L0', 'clearing returns to auto immediately')
})

test('L3 still wins over a manual override', () => {
  const c = clock()
  const tier = new PowerTierController({ config: makeConfig(), now: c.now })
  tier.setForcedMode('L2')
  assert.equal(tier.update({ ...awake, battery: 8 }), 'L3')
})

test('stateHz per tier matches the PRD', () => {
  const c = clock()
  const config = makeConfig()
  const tier = new PowerTierController({ config, now: c.now })
  assert.equal(tier.stateHz, 2)
  const off = { ...awake, screenOn: false, idle: true }
  tier.update(off)
  c.tick(10000)
  assert.equal(tier.update(off), 'L1')
  assert.equal(tier.stateHz, 0.2)
  const low = { ...awake, battery: 19 }
  tier.update(low)
  c.tick(10000)
  assert.equal(tier.update(low), 'L0')
  assert.equal(tier.stateHz, 0.05)
})

test('L3 hysteresis: 9% enters, 15% stays (do not flap around 10%)', () => {
  const c = clock()
  const tier = new PowerTierController({ config: makeConfig(), now: c.now })
  assert.equal(tier.update({ ...awake, battery: 9 }), 'L3')
  // Charging status stays false: only the battery threshold can release it.
  assert.equal(tier.update({ ...awake, battery: 11 }), 'L3')
  assert.equal(tier.update({ ...awake, battery: 15 }), 'L3')
  assert.equal(tier.update({ ...awake, battery: 19 }), 'L3')
})

test('L3 hysteresis: charging or >= l3ExitAbove releases the latch', () => {
  const c = clock()
  const tier = new PowerTierController({ config: makeConfig(), now: c.now })
  assert.equal(tier.update({ ...awake, battery: 9 }), 'L3')
  assert.equal(tier.update({ ...awake, battery: 21 }), 'L3', 'release still respects the 10s debounce')
  c.tick(10000)
  assert.equal(tier.update({ ...awake, battery: 21 }), 'L2')
  assert.equal(tier.update({ ...awake, battery: 9 }), 'L3', 'and it can latch again immediately')
})

test('L3 hysteresis: l3ExitAbove is configurable', () => {
  const c = clock()
  const tier = new PowerTierController({
    config: makeConfig({ power: { battery: { l3Below: 10, l3ExitAbove: 35 } } }),
    now: c.now
  })
  assert.equal(tier.update({ ...awake, battery: 9 }), 'L3')
  assert.equal(tier.update({ ...awake, battery: 30 }), 'L3', 'mid-band stays latched')
  assert.equal(tier.update({ ...awake, battery: 36 }), 'L3')
  c.tick(10000)
  assert.equal(tier.update({ ...awake, battery: 36 }), 'L2', 'released only above l3ExitAbove')
})

test('charging + MODERATE thermal still goes L0 (heat does not care about the cable)', () => {
  const c = clock()
  const tier = new PowerTierController({ config: makeConfig(), now: c.now })
  const hot = { ...awake, charging: true, thermal: 2 }
  assert.equal(tier.update(hot), 'L2', 'debounced')
  c.tick(10000)
  assert.equal(tier.update(hot), 'L0')
  assert.equal(tier.update({ ...awake, charging: true, thermal: 0 }), 'L0')
  c.tick(10000)
  assert.equal(tier.update({ ...awake, charging: true, thermal: 0 }), 'L2')
})

test('thermal L0 outranks a manual L2 override', () => {
  const c = clock()
  const tier = new PowerTierController({ config: makeConfig(), now: c.now })
  tier.setForcedMode('L2')
  const hot = { ...awake, thermal: 3 }
  assert.equal(tier.update(hot), 'L2')
  c.tick(10000)
  assert.equal(tier.update(hot), 'L0', 'safety beats the user preference')
  assert.equal(tier.forcedMode, 'L2', 'but the preference is remembered')
  c.tick(10000)
  assert.equal(tier.update(awake), 'L0', 'the debounce starts when the sensor drops')
  c.tick(10000)
  assert.equal(tier.update(awake), 'L2', 'and re-applies once cool')
})

test('unknown screen state is off, not on', () => {
  const c = clock()
  const tier = new PowerTierController({ config: makeConfig(), now: c.now })
  const unknown = { ...awake, screenOn: false, idle: true }
  assert.equal(tier.update(unknown), 'L2')
  c.tick(10000)
  assert.equal(tier.update(unknown), 'L1')
})
