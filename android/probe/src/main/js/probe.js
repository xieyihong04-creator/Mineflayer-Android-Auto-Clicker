'use strict'
/*
 * M3 probe: does mineflayer actually run and connect inside nodejs-mobile?
 *
 * Arguments (from MainActivity):
 *   argv[2] host      server address                 (default 127.0.0.1)
 *   argv[3] port      server port                    (default 25565)
 *   argv[4] auth      1 = Microsoft device-code login, 0 = offline
 *   argv[5] username  in-game name for offline mode  (default Probe)
 *
 * Everything is reported through http://127.0.0.1:3999/ because nodejs-mobile
 * does not wire stdout anywhere by default. The same JSON is written to
 * probe-result.json next to this script.
 *
 * This file is intentionally a probe, not product code: it records what
 * happened and never pretends an unproven step succeeded.
 */

const http = require('http')
const fs = require('fs')
const path = require('path')

const HOST = process.argv[2] || '127.0.0.1'
const PORT = Number(process.argv[3] || 25565)
let wantAuth = process.argv[4] === '1'
const USERNAME = process.argv[5] || 'Probe'
const STATUS_PORT = 3999

const t0 = Date.now()
const status = {
  startedAt: new Date().toISOString(),
  argv: process.argv.slice(2),
  node: process.versions.node,
  v8: process.versions.v8,
  platform: process.platform,
  arch: process.arch,
  uv: process.versions.uv,
  steps: [],
  connect: null,
  auth: null
}

function step (name, ok, detail) {
  const entry = { name, ok, ms: Date.now() - t0 }
  if (detail !== undefined) entry.detail = detail
  status.steps.push(entry)
  // eslint-disable-next-line no-console
  console.log(`[probe] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`)
  persist()
  return ok
}

function persist () {
  try {
    fs.writeFileSync(path.join(__dirname, 'probe-result.json'), JSON.stringify(status, null, 2))
  } catch (e) {
    // Best effort: a read-only dir only costs us the file, not the result.
  }
}

let mineflayer = null
try {
  mineflayer = require('mineflayer')
  step('require mineflayer', true, require('mineflayer/package.json').version)
} catch (e) {
  step('require mineflayer', false, e.message)
}

try {
  step('require minecraft-protocol', true, require('minecraft-protocol/package.json').version)
} catch (e) {
  step('require minecraft-protocol', false, e.message)
}

step('runtime', true, {
  node: process.versions.node,
  modules: process.versions.modules,
  gcHint: typeof global.gc === 'function'
})

// ---------------------------------------------------------------- connection

let bot = null

function connectOnce () {
  if (!mineflayer) {
    status.connect = { ok: false, detail: 'mineflayer did not load' }
    persist()
    return
  }
  const started = Date.now()
  const opts = {
    host: HOST,
    port: PORT,
    username: USERNAME,
    auth: wantAuth ? 'microsoft' : 'offline'
  }
  if (wantAuth) {
    opts.profilesFolder = path.join(__dirname, 'auth-cache')
    opts.onMsaCode = (data) => {
      status.auth = {
        waiting: true,
        userCode: data.user_code,
        url: data.verification_uri,
        message: data.message
      }
      step('microsoft device code', true, { code: data.user_code, url: data.verification_uri })
    }
  }
  try {
    bot = mineflayer.createBot(opts)
  } catch (e) {
    status.connect = { ok: false, ms: Date.now() - started, detail: 'createBot threw: ' + e.message }
    persist()
    return
  }

  // One attempt reports once: 'error' and 'end' both fire for a refused socket,
  // and the first on-device run showed the same failure twice in steps[].
  let finished = false
  const finish = (ok, detail) => {
    if (finished) return
    finished = true
    status.connect = { ok, ms: Date.now() - started, target: HOST + ':' + PORT, auth: wantAuth ? 'microsoft' : 'offline' }
    if (detail !== undefined) status.connect.detail = detail
    step('connect ' + HOST + ':' + PORT, ok, detail)
    try { bot.quit() } catch (e) {}
    bot = null
  }

  const timer = setTimeout(() => finish(false, 'timeout 45s (no spawn)'), 45000)
  bot.once('spawn', () => {
    clearTimeout(timer)
    const pos = bot.entity && bot.entity.position
    status.connectPos = pos ? [pos.x, pos.y, pos.z].map((n) => Math.round(n * 10) / 10) : null
    status.connectVersion = bot.version
    finish(true, 'spawned')
  })
  bot.on('kicked', (reason) => {
    clearTimeout(timer)
    finish(false, 'kicked: ' + JSON.stringify(reason))
  })
  bot.on('error', (e) => {
    clearTimeout(timer)
    finish(false, 'error: ' + e.message)
  })
  bot.on('end', (reason) => {
    if (status.connect) return
    clearTimeout(timer)
    finish(false, 'end: ' + String(reason))
  })
}

// -------------------------------------------------------------------- report

function render () {
  const body = JSON.stringify(status, null, 2)
  const html = '<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">' +
    '<body style="font:13px/1.5 monospace;background:#101418;color:#e6eaf0;padding:12px">' +
    '<h3 style="margin:0 0 8px">MCBOT M3 probe</h3>' +
    '<pre style="white-space:pre-wrap">' + body.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) + '</pre>' +
    '<p><a style="color:#7fd1a7" href="/run">/run</a> retry connect &nbsp; ' +
    '<a style="color:#7fd1a7" href="/run?auth=1">/run?auth=1</a> retry with Microsoft login</p></body>'
  return { body, html }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/run' && !bot) {
    if (url.searchParams.get('auth') === '1') wantAuth = true
    connectOnce()
  }
  const out = render()
  const wantsJson = url.pathname === '/result' || (req.headers.accept || '').includes('application/json')
  res.writeHead(200, { 'content-type': wantsJson ? 'application/json' : 'text/html; charset=utf-8' })
  res.end(wantsJson ? out.body : out.html)
})
server.on('error', (e) => step('http server', false, e.message))
server.listen(STATUS_PORT, '127.0.0.1', () => {
  step('http server on ' + STATUS_PORT, true)
  if (mineflayer) connectOnce()
})
