'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { parseDown, ProtocolError, stateMessage } = require('../src/bridge/protocol')

test('protocol: accepts the frozen downstream messages', () => {
  assert.deepEqual(parseDown({ t: 'goto', x: 1, y: 2, z: 3, range: 2 }), {
    type: 'goto',
    payload: { x: 1, y: 2, z: 3, range: 2 }
  })
  assert.deepEqual(parseDown({ t: 'cmd', text: 'hello' }), { type: 'cmd', payload: { text: 'hello' } })
  assert.deepEqual(parseDown({ t: 'stop' }), { type: 'stop', payload: {} })
  assert.deepEqual(parseDown({ t: 'eat' }), { type: 'eat', payload: {} })
  assert.deepEqual(parseDown({ t: 'setMode', mode: 'auto' }), { type: 'setMode', payload: { mode: 'auto' } })
  assert.deepEqual(parseDown({ t: 'toss' }), { type: 'toss', payload: { mode: 'cleanup', slot: undefined } })
})

test('protocol: rejects unknown types and malformed payloads', () => {
  assert.throws(() => parseDown({ t: 'nope' }), ProtocolError)
  assert.throws(() => parseDown(null), ProtocolError)
  assert.throws(() => parseDown({ t: 'goto', x: 1, y: 'a', z: 3 }), ProtocolError)
  assert.throws(() => parseDown({ t: 'goto', x: 1, y: 2, z: 3, range: 99 }), ProtocolError)
  assert.throws(() => parseDown({ t: 'cmd', text: '' }), ProtocolError)
  assert.throws(() => parseDown({ t: 'cmd', text: 'x'.repeat(257) }), ProtocolError)
  assert.throws(() => parseDown({ t: 'setMode', mode: 'L9' }), ProtocolError)
})

test('protocol: connect validates port and version', () => {
  assert.deepEqual(parseDown({ t: 'connect', host: 'mc.example.com', port: 25565 }), {
    type: 'connect',
    payload: { host: 'mc.example.com', port: 25565 }
  })
  assert.deepEqual(parseDown({ t: 'connect', version: false }), { type: 'connect', payload: { version: false } })
  assert.throws(() => parseDown({ t: 'connect', port: 70000 }), ProtocolError)
})

test('protocol: config actions', () => {
  assert.deepEqual(parseDown({ t: 'config', action: 'get' }), { type: 'config', payload: { action: 'get' } })
  assert.throws(() => parseDown({ t: 'config', action: 'set' }), ProtocolError)
  assert.throws(() => parseDown({ t: 'config', action: 'import', json: 12 }), ProtocolError)
})

test('protocol: v1 extensions (disconnect / waypoint)', () => {
  assert.deepEqual(parseDown({ t: 'disconnect' }), { type: 'disconnect', payload: { reason: 'user' } })
  assert.deepEqual(parseDown({ t: 'waypoint', action: 'go', name: 'afk' }), {
    type: 'waypoint',
    payload: { action: 'go', name: 'afk' }
  })
  assert.throws(() => parseDown({ t: 'waypoint', action: 'go' }), ProtocolError)
})

test('protocol: state message matches §5 shape', () => {
  const msg = stateMessage({
    hp: 20,
    food: 18,
    pos: { x: 1.234, y: 64, z: -2.5 },
    yaw: 1.5,
    nav: false,
    mode: 'L1',
    online: 65000,
    connected: true
  })
  assert.equal(msg.t, 'state')
  assert.equal(msg.hp, 20)
  assert.equal(msg.food, 18)
  assert.deepEqual(msg.pos, [1.23, 64, -2.5])
  assert.equal(msg.nav, false)
  assert.equal(msg.mode, 'L1')
  assert.equal(msg.online, 65)
  assert.equal(msg.connected, true)
})
