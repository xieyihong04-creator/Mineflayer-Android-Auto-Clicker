'use strict'

const EventEmitter = require('node:events')
const { DEFAULTS, normalize } = require('../src/config')

function makeConfig (patch = {}) {
  return normalize(patch, DEFAULTS).config
}

class FakePosition {
  constructor (x, y, z) { this.x = x; this.y = y; this.z = z }
  clone () { return new FakePosition(this.x, this.y, this.z) }
  distanceTo (other) {
    const dx = this.x - other.x
    const dy = this.y - other.y
    const dz = this.z - other.z
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }
}

function makeItem (name, count = 1, slot = 10, foodPoints = 0) {
  return {
    name,
    count,
    slot,
    type: slot,
    displayName: name,
    foodPoints
  }
}

class FakeBot extends EventEmitter {
  constructor ({ pos = new FakePosition(0, 64, 0) } = {}) {
    super()
    this.username = 'Tester'
    this.health = 20
    this.food = 20
    this.registry = { version: '1.20.1', itemsByName: {}, foodsByName: null }
    this.entity = { position: pos.clone(), yaw: 0, pitch: 0 }
    this.settings = { viewDistance: 'normal' }
    this.setSettingsCalls = []
    this.chatCalls = []
    this.tossed = []
    this.consumeCalls = 0
    this.consumeImpl = async () => { this.consumeCalls += 1 }
    this.inventory = {
      slots: new Array(46).fill(null),
      items: () => this.inventory.slots.filter(Boolean)
    }
    this.pathfinder = {
      goals: [],
      setGoal: (goal) => { this.pathfinder.goals.push(goal) },
      stop: () => { this.pathfinder.stopped = true },
      setMovements: (m) => { this.pathfinder.movements = m }
    }
    this.setSettings = (patch) => {
      this.setSettingsCalls.push(patch)
      Object.assign(this.settings, patch)
    }
    this.chat = (text) => this.chatCalls.push(text)
    this.tossStack = async (item) => { this.tossed.push(item.name) }
    this.consume = () => this.consumeImpl()
    this.loadPlugin = () => { this.pluginLoaded = true }
    this.quitCalls = []
    this.quit = (reason) => { this.quitCalls.push(reason); this.emit('end', reason) }
    this.end = () => { this.emit('end', 'ended') }
  }

  addItem (name, count = 1, slot) {
    const nextSlot = slot === undefined ? this.inventory.slots.findIndex((s, i) => i >= 9 && i <= 44 && !s) : slot
    this.inventory.slots[nextSlot] = makeItem(name, count, nextSlot)
    return this.inventory.slots[nextSlot]
  }
}

function fakeLogger () {
  const entries = []
  return {
    entries,
    info: (msg) => entries.push(['info', msg]),
    warn: (msg) => entries.push(['warn', msg]),
    error: (msg) => entries.push(['error', msg]),
    debug: (msg) => entries.push(['debug', msg]),
    recent: () => [],
    setFileEnabled: () => {}
  }
}

const navStub = () => ({
  active: false,
  setup: () => {},
  goto: async () => ({}),
  stop: () => {},
  pause: () => null,
  resume: async () => {},
  snapshot: () => ({}),
  emit: () => {}
})

module.exports = { makeConfig, FakeBot, FakePosition, fakeLogger, navStub, makeItem }
