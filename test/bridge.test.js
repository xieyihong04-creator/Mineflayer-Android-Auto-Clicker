'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const WebSocket = require('ws')
const { BridgeServer } = require('../src/bridge/server')
const { BotManager } = require('../src/bot/manager')
const { PowerTierController } = require('../src/power/tier')
const { normalize } = require('../src/config')
const { FakeBot, makeConfig, fakeLogger, navStub } = require('./helpers')

function httpGet (port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    }).on('error', reject)
  })
}

/**
 * Buffers every server message from the moment the socket opens, so a `hello`
 * that races the listener registration is not lost.
 */
function createClient (ws) {
  const queue = []
  const waiters = new Set()
  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    queue.push(msg)
    for (const waiter of [...waiters]) waiter.check(msg)
  })
  return {
    ws,
    wait (predicate, timeoutMs = 2000) {
      const index = queue.findIndex(predicate)
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0])
      return new Promise((resolve, reject) => {
        const waiter = {
          check (msg) {
            if (!predicate(msg)) return
            clearTimeout(timer)
            waiters.delete(waiter)
            const i = queue.indexOf(msg)
            if (i >= 0) queue.splice(i, 1)
            resolve(msg)
          }
        }
        const timer = setTimeout(() => {
          waiters.delete(waiter)
          reject(new Error('timeout waiting for message'))
        }, timeoutMs)
        waiters.add(waiter)
      })
    }
  }
}

async function setup (t) {
  const config = makeConfig({
    server: { host: 'mc.example.com', port: 25565, username: 'Tester' },
    power: { logToFile: false }
  })
  const store = {
    config,
    saves: [],
    save (patch) {
      const { config, errors } = normalize(patch, this.config)
      if (errors.length) throw new Error(errors.join('; '))
      this.saves.push(patch)
      this.config = config
      return this.config
    }
  }
  const logger = fakeLogger()
  const tier = new PowerTierController({ config })
  const bots = []
  const manager = new BotManager({
    configStore: store,
    logger,
    tier,
    nav: navStub(),
    createBot: () => {
      const bot = new FakeBot()
      bots.push(bot)
      return bot
    },
    networkWatcher: { start: () => {}, stop: () => {} }
  })
  tier.onChange = (mode, prev) => manager.applyModeActions(mode, prev)
  manager.start()

  const server = new BridgeServer({
    manager,
    configStore: store,
    logger,
    webRoot: path.join(__dirname, '..', 'web'),
    host: '127.0.0.1',
    port: 0
  })
  await server.start()

  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
  const client = createClient(ws)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  t.after(async () => {
    try { ws.close() } catch {}
    manager.destroy()
    await server.close()
  })
  return { manager, server, client, ws, bots, store, tier }
}

test('bridge: serves the web UI and health endpoint', async (t) => {
  const { server } = await setup(t)
  const page = await httpGet(server.port, '/')
  assert.equal(page.status, 200)
  assert.match(page.body, /挂机控制台/)
  const css = await httpGet(server.port, '/style.css')
  assert.equal(css.status, 200)
  const health = await httpGet(server.port, '/api/health')
  assert.equal(JSON.parse(health.body).ok, true)
  const missing = await httpGet(server.port, '/nope.js')
  assert.equal(missing.status, 404)
  const traversal = await httpGet(server.port, '/..%2f..%2fetc%2fpasswd')
  assert.notEqual(traversal.status, 200)
})

test('bridge: new client gets a hello with protocol, config, mode and state', async (t) => {
  const { client } = await setup(t)
  const hello = await client.wait((m) => m.t === 'hello')
  assert.equal(hello.protocol, 1)
  assert.equal(hello.mode.mode, 'L2')
  assert.equal(hello.config.server.host, 'mc.example.com')
  assert.ok(Array.isArray(hello.chat))
  assert.ok(hello.status)
})

test('bridge: spawn broadcasts state and chat, commands are acked', async (t) => {
  const { client, ws, bots, manager } = await setup(t)
  await client.wait((m) => m.t === 'hello')

  const statePromise = client.wait((m) => m.t === 'state' && m.connected === true)
  manager.connect()
  bots[0].emit('spawn')
  const state = await statePromise
  assert.equal(state.hp, 20)
  assert.equal(state.food, 20)
  assert.equal(state.mode, 'L2')

  const chatPromise = client.wait((m) => m.t === 'chat' && m.text === 'hi there')
  bots[0].emit('messagestr', '<Steve> hi there', 'chat')
  const chat = await chatPromise
  assert.equal(chat.from, 'Steve')

  ws.send(JSON.stringify({ t: 'cmd', text: 'hello server', id: 1 }))
  const ack = await client.wait((m) => m.t === 'ack' && m.id === 1)
  assert.equal(ack.ok, true)
  assert.deepEqual(bots[0].chatCalls, ['hello server'])
})

test('bridge: invalid command is rejected without killing the socket', async (t) => {
  const { client, ws } = await setup(t)
  await client.wait((m) => m.t === 'hello')
  ws.send(JSON.stringify({ t: 'goto', x: 'nope', y: 2, z: 3, id: 3 }))
  const ack = await client.wait((m) => m.t === 'ack' && m.id === 3)
  assert.equal(ack.ok, false)
  assert.match(ack.error, /goto.x/)
  assert.equal(ws.readyState, WebSocket.OPEN)
})

test('bridge: setMode persists the manual override and broadcasts the new mode', async (t) => {
  const { client, ws, store } = await setup(t)
  await client.wait((m) => m.t === 'hello')
  ws.send(JSON.stringify({ t: 'setMode', mode: 'L2', id: 4 }))
  const ack = await client.wait((m) => m.t === 'ack' && m.id === 4)
  assert.equal(ack.ok, true)
  assert.equal(store.config.power.forcedMode, 'L2')
  const mode = await client.wait((m) => m.t === 'mode' && m.forced === 'L2')
  assert.equal(mode.mode, 'L2')
})

test('bridge: config get/set round trip', async (t) => {
  const { client, ws, store } = await setup(t)
  await client.wait((m) => m.t === 'hello')

  ws.send(JSON.stringify({ t: 'config', action: 'set', patch: { eat: { threshold: 10 } }, id: 5 }))
  const ack = await client.wait((m) => m.t === 'ack' && m.id === 5)
  assert.equal(ack.ok, true)
  assert.equal(store.config.eat.threshold, 10)
  const configMsg = await client.wait((m) => m.t === 'config' && m.action === 'set')
  assert.equal(configMsg.config.eat.threshold, 10)

  ws.send(JSON.stringify({ t: 'config', action: 'set', patch: { server: { port: 99999 } }, id: 6 }))
  const bad = await client.wait((m) => m.t === 'ack' && m.id === 6)
  assert.equal(bad.ok, false)
})

test('bridge: hello carries protoVersion and health reports it', async (t) => {
  const { client, server } = await setup(t)
  const hello = await client.wait((m) => m.t === 'hello')
  assert.equal(hello.protoVersion, 1)
  const health = JSON.parse((await httpGet(server.port, '/api/health')).body)
  assert.equal(health.protoVersion, 1)
  assert.equal(health.clients, 1)
  // The self-check table is reachable without a browser, which is what the
  // real-device step 4 needs (`curl -s localhost:8765/api/health`).
  assert.equal(health.signals.charging.status !== undefined, true)
  assert.equal(health.signals.battery.status, 'unavailable')
})

test('bridge: screen visibility reports are accepted and drive the tier', async (t) => {
  const { client, ws, manager } = await setup(t)
  await client.wait((m) => m.t === 'hello')
  assert.equal(manager.uiClients, 1)

  ws.send(JSON.stringify({ t: 'screen', on: true, id: 11 }))
  const ack = await client.wait((m) => m.t === 'ack' && m.id === 11)
  assert.equal(ack.ok, true)
  assert.equal(manager.tier.lastSignals.screenOn, true)
  assert.equal(manager.tier.lastSignals.screenSource, 'ui')

  ws.send(JSON.stringify({ t: 'screen', on: false, id: 12 }))
  await client.wait((m) => m.t === 'ack' && m.id === 12)
  assert.equal(manager.tier.lastSignals.screenOn, false)

  ws.send(JSON.stringify({ t: 'screen', on: 'nope', id: 13 }))
  const bad = await client.wait((m) => m.t === 'ack' && m.id === 13)
  assert.equal(bad.ok, false)
})

test('bridge: closing the last socket returns the screen authority to "no client"', async (t) => {
  const { client, ws, manager } = await setup(t)
  await client.wait((m) => m.t === 'hello')
  ws.send(JSON.stringify({ t: 'screen', on: true, id: 21 }))
  await client.wait((m) => m.t === 'ack' && m.id === 21)
  assert.equal(manager.tier.lastSignals.screenOn, true)
  ws.close()
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(manager.uiClients, 0)
  assert.deepEqual(manager.screen.snapshot().reports, {})
})

test('bridge: hello carries a per-client id and the startup signal table', async (t) => {
  const { client } = await setup(t)
  const hello = await client.wait((m) => m.t === 'hello')
  assert.match(hello.clientId, /^ui-\d+$/)
  assert.ok(hello.signals, 'self-check table is sent on handshake')
  // The socket is registered before hello, so the page is a client that has
  // not reported visibility yet -> unknown, never "assume on".
  assert.equal(hello.signals.screen.status, 'unknown')
  for (const key of ['battery', 'charging', 'thermal', 'powerSave']) {
    assert.ok(['unavailable', 'live', 'mock', 'live(termux-api)'].includes(hello.signals[key].status))
  }
})

test('bridge: multi-client screen aggregation is any-on-wins, and disconnect re-aggregates', async (t) => {
  const { client, ws, manager, server } = await setup(t)
  const hello1 = await client.wait((m) => m.t === 'hello')
  const second = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
  const client2 = createClient(second)
  await new Promise((resolve, reject) => {
    second.once('open', resolve)
    second.once('error', reject)
  })
  await client2.wait((m) => m.t === 'hello')
  assert.equal(manager.uiClients, 2)

  // desktop tab visible, phone tab in the background: any-on-wins
  ws.send(JSON.stringify({ t: 'screen', on: true, id: 31 }))
  await client.wait((m) => m.t === 'ack' && m.id === 31)
  second.send(JSON.stringify({ t: 'screen', on: false, id: 32 }))
  await client2.wait((m) => m.t === 'ack' && m.id === 32)
  assert.equal(manager.tier.lastSignals.screenOn, true)

  // closing the background tab must recompute from the remaining set
  second.close()
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(manager.uiClients, 1)
  assert.deepEqual(Object.keys(manager.screen.snapshot().reports), [hello1.clientId])
  assert.equal(manager.tier.lastSignals.screenOn, true, 'remaining observer still wins')
})

test('bridge: M2 native thermal/powerSave messages drive the manager and health', async (t) => {
  const { client, ws, manager, server } = await setup(t)
  await client.wait((m) => m.t === 'hello')

  ws.send(JSON.stringify({ t: 'thermal', value: 2, id: 31 }))
  const ack = await client.wait((m) => m.t === 'ack' && m.id === 31)
  assert.equal(ack.ok, true)
  assert.equal(manager.native.thermal, 2)
  assert.equal(manager.signalTable().thermal.source, 'android-native')

  ws.send(JSON.stringify({ t: 'powerSave', on: true, id: 32 }))
  await client.wait((m) => m.t === 'ack' && m.id === 32)
  assert.equal(manager.native.powerSave, true)
  assert.equal(manager.signalTable().powerSave.status, 'live')

  const health = JSON.parse((await httpGet(server.port, '/api/health')).body)
  assert.equal(health.power.thermalNative, 2)
  assert.equal(health.power.powerSaveNative, true)
  assert.equal(health.signals.thermal.native, 2)

  ws.send(JSON.stringify({ t: 'thermal', value: 9, id: 33 }))
  const bad = await client.wait((m) => m.t === 'ack' && m.id === 33)
  assert.equal(bad.ok, false)
  assert.equal(manager.native.thermal, 2, 'a rejected value must not be stored')
})
