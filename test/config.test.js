'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ConfigStore, normalize, DEFAULTS } = require('../src/config')

test('defaults satisfy the PRD: eat threshold 14, 200 chat, 300ms toss gap, 3 empty slots', () => {
  const { config, errors } = normalize({})
  assert.deepEqual(errors, [])
  assert.equal(config.eat.threshold, 14)
  assert.equal(config.power.chatLimit, 200)
  assert.equal(config.power.chatLimitL0, 50)
  assert.equal(config.inv.tossGapMs, 300)
  assert.equal(config.inv.minEmptySlots, 3)
  assert.equal(config.inv.intervalMs, 300000)
  assert.equal(config.nav.timeoutMs, 30000)
  assert.equal(config.reconnect.baseMs, 1000)
  assert.equal(config.reconnect.maxMs, 60000)
  assert.equal(config.power.debounceMs, 10000)
  assert.equal(config.power.viewDistance.l0, 'tiny')
})

test('F4 flags are hard-locked even if the config file tries to enable them', () => {
  const { config } = normalize({ nav: { canDig: true, allowParkour: true, allowFreeMotion: true } })
  assert.equal(config.nav.canDig, false)
  assert.equal(config.nav.allowParkour, false)
  assert.equal(config.nav.allowFreeMotion, false)
})

test('invalid values are reported and repaired', () => {
  const { config, errors } = normalize({
    server: { port: 99999, version: 12, host: 5 },
    power: { battery: { l0Below: 20, l3Below: 30 } },
    inv: { dropPoint: { type: 'void' } },
    ws: { port: 'abc' }
  })
  assert.ok(errors.length >= 4)
  assert.equal(config.server.port, 25565)
  assert.equal(config.server.version, false)
  assert.ok(config.power.battery.l3Below < config.power.battery.l0Below)
  assert.equal(config.inv.dropPoint.type, 'lava')
  assert.equal(config.ws.port, 8765)
})

test('debounce cannot be configured below the PRD floor of 10s', () => {
  const { config } = normalize({ power: { debounceMs: 200 } })
  assert.equal(config.power.debounceMs, 10000)
})

test('config store persists and reloads (import/export round trip)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-'))
  const file = path.join(dir, 'config.json')
  const store = new ConfigStore(file)
  store.load()

  store.save({
    server: { host: 'mc.example.com', username: 'me@example.com' },
    eat: { threshold: 12 },
    inv: { dropPoint: { set: true, type: 'container', x: 10, y: 64, z: -3 } }
  })

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(raw.server.host, 'mc.example.com')
  assert.equal(raw.eat.threshold, 12)
  assert.equal(raw.inv.dropPoint.type, 'container')

  const reloaded = new ConfigStore(file)
  reloaded.load()
  assert.equal(reloaded.config.server.host, 'mc.example.com')
  assert.equal(reloaded.config.inv.dropPoint.set, true)

  // Unknown keys survive so forward-compatible configs are not destroyed.
  reloaded.save({ futureOption: true })
  assert.equal(reloaded.config.futureOption, true)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('a corrupt config file fails loudly instead of booting with junk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-'))
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, '{not json')
  const store = new ConfigStore(file)
  assert.throws(() => store.load(), /config parse error/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('empty defaults are usable for tests', () => {
  assert.equal(DEFAULTS.server.port, 25565)
  assert.equal(DEFAULTS.auth.type, 'microsoft')
})
