'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { ScreenStateTracker } = require('../src/power/screen')
const { makeConfig } = require('./helpers')

function makeTracker (patch = {}, nowFn) {
  const config = makeConfig(patch)
  let clock = 1000
  const now = nowFn || (() => clock)
  const tracker = new ScreenStateTracker({ getConfig: () => config, now })
  return {
    tracker,
    config,
    advance (ms) { clock += ms },
    get now () { return clock }
  }
}

test('screen: no UI client means "off" (no observer, keep saving power)', () => {
  const { tracker } = makeTracker()
  const result = tracker.evaluate({ clientCount: 0 })
  assert.equal(result.on, false)
  assert.equal(result.source, 'no_client')
})

test('screen: a visibility report from a connected UI is authoritative', () => {
  const { tracker } = makeTracker()
  tracker.setClients(1)
  tracker.report(true)
  assert.equal(tracker.evaluate().source, 'ui')
  assert.equal(tracker.evaluate().on, true)

  tracker.report(false)
  const off = tracker.evaluate()
  assert.equal(off.on, false)
  assert.equal(off.source, 'ui')
})

test('screen: connected but never reported -> fail-safe off, not on', () => {
  const { tracker } = makeTracker()
  tracker.setClients(1)
  const result = tracker.evaluate()
  assert.equal(result.on, false)
  assert.equal(result.source, 'unknown')
})

test('screen: a stale report stops counting', () => {
  const { tracker, advance, config } = makeTracker({ power: { screen: { reportStaleMs: 60000 } } })
  tracker.setClients(1)
  tracker.report(true)
  assert.equal(tracker.evaluate().on, true)
  advance(config.power.screen.reportStaleMs + 1)
  const stale = tracker.evaluate()
  assert.equal(stale.on, false)
  assert.equal(stale.source, 'unknown')
})

test('screen: losing the last client discards its report', () => {
  const { tracker } = makeTracker()
  tracker.setClients(1)
  tracker.report(true)
  assert.equal(tracker.evaluate().on, true)
  tracker.setClients(0)
  assert.equal(tracker.reported, null)
  assert.equal(tracker.evaluate().on, false)
})

test('screen: headless mock hint is only honoured when requireClient is off', () => {
  const { tracker, config } = makeTracker()
  assert.equal(tracker.evaluate({ clientCount: 0, fallback: true }).on, false)
  config.power.screen.requireClient = false
  assert.equal(tracker.evaluate({ clientCount: 0, fallback: true }).on, true)
  assert.equal(tracker.evaluate({ clientCount: 0, fallback: true }).source, 'fallback')
})
