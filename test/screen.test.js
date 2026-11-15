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
  tracker.report('ui-1', true)
  assert.equal(tracker.evaluate().source, 'ui')
  assert.equal(tracker.evaluate().on, true)

  tracker.report('ui-1', false)
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
  tracker.report('ui-1', true)
  assert.equal(tracker.evaluate().on, true)
  advance(config.power.screen.reportStaleMs + 1)
  const stale = tracker.evaluate()
  assert.equal(stale.on, false)
  assert.equal(stale.source, 'unknown')
})

test('screen: an upstream message refreshes the report timestamp (touch)', () => {
  const { tracker, advance, config } = makeTracker({ power: { screen: { reportStaleMs: 60000 } } })
  tracker.setClients(1)
  tracker.report('ui-1', true)
  // A chatty client (state poll acks, pings) must not be punished for not
  // re-sending `screen` itself.
  advance(config.power.screen.reportStaleMs - 1000)
  assert.equal(tracker.touch('ui-1'), true)
  advance(3000)
  const result = tracker.evaluate()
  assert.equal(result.on, true)
  assert.equal(result.source, 'ui')
})

test('screen: touch of a client that never reported changes nothing', () => {
  const { tracker } = makeTracker()
  tracker.setClients(1)
  assert.equal(tracker.touch('ghost'), false)
  assert.equal(tracker.evaluate().source, 'unknown')
})

test('screen: multi-client any-on-wins (background phone + visible desktop)', () => {
  const { tracker } = makeTracker()
  tracker.setClients(2)
  tracker.report('phone', false)
  tracker.report('desktop', true)
  assert.equal(tracker.evaluate().on, true)

  tracker.report('desktop', false)
  assert.equal(tracker.evaluate().on, false)
})

test('screen: removing one client re-aggregates the remaining set', () => {
  const { tracker } = makeTracker()
  tracker.setClients(2)
  tracker.report('phone', true)
  tracker.report('desktop', false)
  assert.equal(tracker.evaluate().on, true)
  tracker.removeClient('phone')
  tracker.setClients(1)
  const result = tracker.evaluate()
  assert.equal(result.on, false)
  assert.equal(result.source, 'ui')
})

test('screen: losing the last client discards its report', () => {
  const { tracker } = makeTracker()
  tracker.setClients(1)
  tracker.report('ui-1', true)
  assert.equal(tracker.evaluate().on, true)
  tracker.setClients(0)
  assert.deepEqual(tracker.snapshot().reports, {})
  assert.equal(tracker.evaluate().on, false)
})

test('screen: headless mock hint is only honoured when requireClient is off', () => {
  const { tracker, config } = makeTracker()
  assert.equal(tracker.evaluate({ clientCount: 0, fallback: true }).on, false)
  config.power.screen.requireClient = false
  assert.equal(tracker.evaluate({ clientCount: 0, fallback: true }).on, true)
  assert.equal(tracker.evaluate({ clientCount: 0, fallback: true }).source, 'fallback')
})
