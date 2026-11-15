'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Backoff } = require('../src/util/backoff')
const { networkSignature } = require('../src/util/network')

test('backoff: 1s -> 60s cap, doubling', () => {
  const b = new Backoff({ baseMs: 1000, maxMs: 60000 })
  const delays = []
  for (let i = 0; i < 10; i++) delays.push(b.next())
  assert.deepEqual(delays.slice(0, 7), [1000, 2000, 4000, 8000, 16000, 32000, 60000])
  assert.deepEqual(delays.slice(7), [60000, 60000, 60000])
})

test('backoff: never exceeds max even with custom base', () => {
  const b = new Backoff({ baseMs: 500, maxMs: 3000, factor: 3 })
  assert.deepEqual([b.next(), b.next(), b.next()], [500, 1500, 3000])
})

test('backoff: reset returns to 1s (network switch)', () => {
  const b = new Backoff({ baseMs: 1000, maxMs: 60000 })
  b.next()
  b.next()
  b.next()
  b.reset()
  assert.equal(b.next(), 1000)
})

test('networkSignature: ignores loopback and is order independent', () => {
  const ifaces = {
    wlan0: [{ address: '192.168.1.5', internal: false }],
    lo: [{ address: '127.0.0.1', internal: true }]
  }
  assert.equal(networkSignature(() => ifaces), 'wlan0:192.168.1.5')
  const changed = {
    wlan0: [{ address: '192.168.1.5', internal: false }],
    rmnet0: [{ address: '10.0.0.2', internal: false }]
  }
  assert.notEqual(networkSignature(() => ifaces), networkSignature(() => changed))
})
