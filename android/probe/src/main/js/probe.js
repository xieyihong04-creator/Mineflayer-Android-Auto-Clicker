'use strict'
/*
 * M3 probe: does mineflayer actually run and connect inside nodejs-mobile?
 *
 * Arguments (from MainActivity, all optional -- the page can override them):
 *   argv[2] host      server address                 (default 127.0.0.1)
 *   argv[3] port      server port                    (default 25565)
 *   argv[4] auth      1 = Microsoft device-code login, 0 = offline
 *   argv[5] username  in-game name for offline mode  (default Probe)
 *
 * Everything is reported through http://127.0.0.1:3999/ because nodejs-mobile
 * does not wire stdout anywhere by default. The same JSON is written to
 * probe-result.json next to this script and served at /result.
 *
 * This file is intentionally a probe, not product code: it records what
 * happened and never pretends an unproven step succeeded.
 */

const http = require('http')
const https = require('https')
const fs = require('fs')
const os = require('os')
const net = require('net')
const dns = require('dns')
const path = require('path')

const STATUS_PORT = 3999
// Token cache and last target MUST live outside the extracted bundle: files/node
// is deleted whenever assets/node.zip changes, which used to log the user out on
// every APK update. MainActivity passes filesDir/auth as argv[6].
const AUTH_DIR = process.argv[6] || path.join(__dirname, 'auth-cache')
const AUTH_META = path.join(AUTH_DIR, 'm3probe-meta.json')
const STATE_FILE = path.join(path.dirname(AUTH_DIR), 'probe-state.json')

function loadState () {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch (e) {
    return {}
  }
}

function saveState () {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      host: HOST, port: PORT, user: USERNAME, auth: wantAuth
    }, null, 2))
  } catch (e) {
    // Losing the last target only costs retyping it.
  }
}

// Precedence: intent args (adb) > last saved target > built-in defaults.
const saved = loadState()
let HOST = process.argv[2] || saved.host || '127.0.0.1'
let PORT = Number(process.argv[3] || saved.port || 25565)
let USERNAME = process.argv[5] || saved.user || 'Probe'
let wantAuth = process.argv[4] === '1' || (process.argv[4] !== '0' && !!saved.auth)

const t0 = Date.now()
const status = {
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  argv: process.argv.slice(2),
  node: process.versions.node,
  v8: process.versions.v8,
  platform: process.platform,
  arch: process.arch,
  uv: process.versions.uv,
  target: { host: HOST, port: PORT, auth: wantAuth ? 'microsoft' : 'offline', user: USERNAME },
  steps: [],
  connect: null,
  auth: null,
  authState: 'none',
  authName: null,
  authError: null,
  authDir: AUTH_DIR,
  localIps: localIps()
}

function step (name, ok, detail, elapsed) {
  const entry = { name, ok, ms: elapsed !== undefined ? elapsed : Date.now() - t0 }
  if (detail !== undefined) entry.detail = detail
  status.steps.push(entry)
  status.updatedAt = new Date().toISOString()
  // eslint-disable-next-line no-console
  console.log(`[probe] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`)
  persist()
  return ok
}

function persist () {
  status.updatedAt = new Date().toISOString()
  try {
    fs.writeFileSync(path.join(__dirname, 'probe-result.json'), JSON.stringify(status, null, 2))
  } catch (e) {
    // Best effort: a read-only dir only costs us the file, not the result.
  }
}

/**
 * 'cached' means prismarine-auth already has a token file, so the next connect
 * refreshes silently instead of asking for a device code again.
 */
function authCacheFiles () {
  try {
    return fs.readdirSync(AUTH_DIR).filter((f) => f !== 'm3probe-meta.json')
  } catch (e) {
    return []
  }
}

function readAuthMeta () {
  try {
    return JSON.parse(fs.readFileSync(AUTH_META, 'utf8'))
  } catch (e) {
    return null
  }
}

function writeAuthMeta (name) {
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true })
    fs.writeFileSync(AUTH_META, JSON.stringify({ name, at: new Date().toISOString() }, null, 2))
  } catch (e) {
    // Losing the display name is cosmetic; the token cache still works.
  }
}

function refreshAuthState () {
  if (status.authState === 'pending') return
  const files = authCacheFiles()
  const meta = readAuthMeta()
  if (files.length > 0) {
    status.authState = 'cached'
    status.authName = meta && meta.name ? meta.name : null
  } else {
    status.authState = 'none'
    status.authName = null
  }
}

// A refused or timed-out game socket is NOT a login failure. The old code marked
// every failed attempt as authState='failed', so "ECONNREFUSED 127.0.0.1" showed
// up as "登录失败" even though the tokens were fine.
function isAuthFailure (detail) {
  const d = String(detail || '')
  return /AADSTS|invalid_grant|invalid_client|unauthori[sz]ed|bad login|401|403|auth|Xbox|XSTS|xboxlive|login\.live|login\.microsoftonline|device code|设备码|Failed to (?:obtain|authenticate)/i.test(d)
}

// Server address must be the LAN IP of the machine running Minecraft, not the
// phone. Showing the phone's own IPs makes 127.0.0.1 obviously wrong.
function localIps () {
  const out = []
  try {
    const ifs = os.networkInterfaces()
    for (const name of Object.keys(ifs)) {
      for (const info of ifs[name] || []) {
        if (info.family === 'IPv4' && !info.internal) out.push(info.address)
      }
    }
  } catch (e) {}
  return out
}

let mineflayer = null
let minecraftData = null
let minecraftProtocol = null
try {
  mineflayer = require('mineflayer')
  minecraftData = require('minecraft-data')
  step('require mineflayer', true, require('mineflayer/package.json').version)
} catch (e) {
  step('require mineflayer', false, e.message)
}

try {
  minecraftProtocol = require('minecraft-protocol')
  step('require minecraft-protocol', true, require('minecraft-protocol/package.json').version)
} catch (e) {
  step('require minecraft-protocol', false, e.message)
}

refreshAuthState()

step('runtime', true, {
  node: process.versions.node,
  modules: process.versions.modules,
  gcHint: typeof global.gc === 'function'
})

// ---------------------------------------------------------------- connection

let bot = null
let busy = false
// Cancels the attempt in flight. The page lets the user change the target while
// a 45 s connect is still pending, so a new /run must be able to drop the old one.
let abortCurrent = null

// ------------------------------------------------------------- name resolution
//
// A domain in the address box is often NOT the machine to dial: Java clients
// look for _minecraft._tcp.<domain> first (vanilla, and minecraft-protocol does
// the same). c-ares -- what Node's dns.resolve* uses -- cannot read Android's
// resolver configuration, so on device the lookup can fail while the domain
// still works in the real client. We therefore try the system resolver, then
// DNS-over-HTTPS, and only fall back to the A record.

function withTimeout (promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' timeout ' + ms + 'ms')), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) }
    )
  })
}

function dohQuery (base, name, type) {
  return new Promise((resolve, reject) => {
    const url = base + '?name=' + encodeURIComponent(name) + '&type=' + type
    const req = https.get(url, { headers: { accept: 'application/dns-json' } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (e) { reject(new Error('bad DoH response')) }
      })
    })
    req.setTimeout(4000, () => req.destroy(new Error('DoH timeout')))
    req.on('error', reject)
  })
}

function parseDohSrv (json) {
  if (!json || json.Status !== 0) {
    const err = new Error('dns status ' + (json && json.Status))
    err.code = json && json.Status === 3 ? 'NXDOMAIN' : 'ESERVFAIL'
    throw err
  }
  return (json.Answer || [])
    .filter((a) => a.type === 33)
    .map((a) => {
      const p = String(a.data).trim().split(/\s+/)
      return { priority: +p[0], weight: +p[1], port: +p[2], name: String(p[3]).replace(/\.$/, '') }
    })
}

function pickSrv (records) {
  return records.slice().sort((a, b) => (a.priority - b.priority) || (b.weight - a.weight))[0]
}

async function srvLookup (host) {
  const name = '_minecraft._tcp.' + host
  const attempts = [
    ['system', () => withTimeout(dns.promises.resolveSrv(name), 2500, 'system dns')],
    ['cloudflare', async () => parseDohSrv(await withTimeout(dohQuery('https://cloudflare-dns.com/dns-query', name, 'SRV'), 4500, 'DoH'))],
    ['google', async () => parseDohSrv(await withTimeout(dohQuery('https://dns.google/resolve', name, 'SRV'), 4500, 'DoH'))]
  ]
  let last = null
  for (const [via, fn] of attempts) {
    try {
      const recs = await fn()
      if (recs && recs.length) return { rec: pickSrv(recs), via }
      last = new Error('no SRV record')
      last.code = 'ENODATA'
    } catch (e) {
      last = e
    }
  }
  throw last || new Error('no SRV record')
}

function lookupA (name, cb) {
  const started = Date.now()
  // Prefer IPv4: Android phones often have a routable v6 only on some networks,
  // and dns.lookup() returns ::1 for "localhost" first.
  const attempt = (family) => withTimeout(dns.promises.lookup(name, family ? { family } : {}), 3000, 'A lookup')
  attempt(4).catch(() => attempt(0)).then(
    (res) => {
      step('a ' + name, true, res.address, Date.now() - started)
      cb(res.address)
    },
    (e) => {
      step('a ' + name, false, e.message, Date.now() - started)
      cb(null)
    }
  )
}

// Calls back with the address the socket should really dial.
function resolveServer (host, port, done) {
  const started = Date.now()
  const direct = (h, p, note) => done(h, p, note)
  if (net.isIP(host) !== 0) return direct(host, port, null)

  const aRecord = (name, p, note) => lookupA(name, (ip) => direct(ip || name, p, note))

  if (port !== 25565) {
    // Vanilla only consults SRV when no port was given (25565 is the default).
    return aRecord(host, port, null)
  }
  srvLookup(host).then(
    ({ rec, via }) => {
      const note = rec.name + ':' + rec.port
      step('srv _minecraft._tcp.' + host, true, note + ' · ' + via, Date.now() - started)
      aRecord(rec.name, rec.port, note)
    },
    (e) => {
      const why = e.code === 'NXDOMAIN' ? '域名不存在 (NXDOMAIN)' : (e.code === 'ENODATA' ? '没有 SRV 记录' : e.message)
      step('srv _minecraft._tcp.' + host, false, why, Date.now() - started)
      aRecord(host, port, null)
    }
  )
}

// ---------------------------------------------------------------- version pick
//
// mineflayer's autoVersion takes the server's ping response at face value. When a
// proxy reports a pre-release protocol (389 = 1.13-pre7, seen on device), it
// picks that alias, which has no data directory of its own; minecraft-data then
// serves 1.13 data and minecraft-protocol aborts with "Unsupported protocol
// version '389' (attempted to use '393' data)". So we ping ourselves and only
// accept a version whose data exists and whose protocol number matches,
// falling back to the major version of the one the server reported.

function versionPlayable (version) {
  if (!minecraftData) return false
  try {
    const info = minecraftData.versionsByMinecraftVersion.pc[version]
    const data = minecraftData(version)
    return !!(info && data && data.version && data.version.version === info.version)
  } catch (e) {
    return false
  }
}

function pickVersion (protocol, name) {
  if (!minecraftData) return null
  const mapped = minecraftData.postNettyVersionsByProtocolVersion.pc[protocol] || []
  for (const c of mapped) if (versionPlayable(c.minecraftVersion)) return c.minecraftVersion
  // 389 -> '1.13-pre7' has no data of its own, but its major version does.
  for (const c of mapped) if (c.majorVersion && versionPlayable(c.majorVersion)) return c.majorVersion
  // Only trust the advertised name when it is a bare version string; proxies
  // advertise things like "BungeeCord 1.8.x-26.x", where a regex would pick
  // the wrong end of the range.
  const bare = String(name || '').trim()
  if (/^\d+\.\d+(?:\.\d+)?$/.test(bare) && versionPlayable(bare)) return bare
  return null
}

function resolveVersion (host, port, cb) {
  if (!minecraftProtocol) return cb(null)
  const started = Date.now()
  withTimeout(minecraftProtocol.ping({ host, port, closeTimeout: 8000 }), 12000, 'ping')
    .then(
      (res) => {
        const info = (res && res.version) || {}
        const pick = pickVersion(info.protocol, info.name)
        step('ping ' + host + ':' + port, true,
          (info.name || '?') + ' · protocol ' + info.protocol +
          (pick ? ' → ' + pick : ' → 没有匹配的版本数据'),
          Date.now() - started)
        cb(pick)
      },
      (e) => {
        step('ping ' + host + ':' + port, false, e.message, Date.now() - started)
        cb(null)
      }
    )
}

function connectOnce () {
  if (!mineflayer) {
    status.connect = { ok: false, detail: 'mineflayer did not load' }
    persist()
    return
  }
  if (wantAuth && !USERNAME.includes('@')) {
    // prismarine-auth keys its cache by the account identifier and Microsoft
    // device-code login needs the e-mail; silently reusing "Probe" just fails
    // minutes later with an unhelpful error.
    // Input problem, not a login failure: cached tokens may still be valid.
    status.authError = '微软登录要在“玩家名”里填账号邮箱（例如 you@outlook.com）'
    status.authState = 'none'
    refreshAuthState()
    status.connect = { ok: false, detail: status.authError }
    persist()
    return
  }
  if (busy) return
  busy = true
  status.target = { host: HOST, port: PORT, auth: wantAuth ? 'microsoft' : 'offline', user: USERNAME }
  status.resolved = null
  status.resolveNote = null
  let cancelled = false
  abortCurrent = () => {
    cancelled = true
    busy = false
    abortCurrent = null
  }
  resolveServer(HOST, PORT, (host, port, note) => {
    if (cancelled) return
    resolveVersion(host, port, (version) => {
      if (cancelled) return
      launch(host, port, note, version)
    })
  })
}

function launch (host, port, note, version) {
  // The effective socket target. When it differs from what the user typed, the
  // step list shows both, so "why is it dialling this IP" has an answer.
  status.resolved = host + ':' + port
  if (note) status.resolveNote = note
  const started = Date.now()
  const opts = {
    host,
    port,
    username: USERNAME,
    auth: wantAuth ? 'microsoft' : 'offline'
  }
  // An explicit version stops mineflayer from re-pinging and picking an alias
  // we cannot serve (see version pick above).
  if (version) opts.version = version
  const label = (host + ':' + port) === (HOST + ':' + PORT)
    ? HOST + ':' + PORT
    : host + ':' + port + ' (来自 ' + HOST + ':' + PORT + ')'
  let onAuthWait = null
  if (wantAuth) {
    status.authState = 'pending'
    status.authError = null
    opts.profilesFolder = AUTH_DIR
    opts.onMsaCode = (data) => {
      status.auth = {
        waiting: true,
        userCode: data.user_code,
        url: data.verification_uri,
        message: data.message
      }
      status.authState = 'pending'
      // Typing a device code takes minutes; the 45 s connect window must not
      // kill the attempt while the user is still on microsoft.com/link.
      if (onAuthWait) onAuthWait()
      persist()
    }
  }
  try {
    bot = mineflayer.createBot(opts)
  } catch (e) {
    busy = false
    abortCurrent = null
    status.connect = { ok: false, ms: Date.now() - started, detail: 'createBot threw: ' + e.message }
    persist()
    return
  }

  // One attempt reports once: 'error' and 'end' both fire for a refused socket.
  let finished = false
  const finish = (ok, detail) => {
    if (finished) return
    finished = true
    busy = false
    status.connect = { ok, ms: Date.now() - started, target: HOST + ':' + PORT, auth: wantAuth ? 'microsoft' : 'offline' }
    if (detail !== undefined) status.connect.detail = detail
    if (wantAuth) {
      if (ok) {
        status.authState = 'ok'
        status.authName = (bot && bot.username) || status.authName
        writeAuthMeta(status.authName)
      } else if (isAuthFailure(detail)) {
        status.authState = 'failed'
        status.authError = detail || 'login failed'
      } else {
        // Tokens are fine; the game server was unreachable. Re-read the cache so
        // the card shows 已登录 instead of accusing the login of failing.
        // (refreshAuthState() is a no-op while the state is still 'pending'.)
        status.authState = 'none'
        refreshAuthState()
        status.authError = null
      }
    }
    // Duration of this attempt, not time since boot (the page shows both).
    step('connect ' + label, ok, detail, Date.now() - started)
    try { bot.quit() } catch (e) {}
    bot = null
    abortCurrent = null
    clearTimeout(timer)
  }

  let timer = null
  const arm = (ms, label) => {
    clearTimeout(timer)
    timer = setTimeout(() => finish(false, label), ms)
  }
  arm(45000, 'timeout 45s (no spawn)')
  onAuthWait = () => arm(600000, 'timeout 10min (设备码未完成授权)')
  // Auth happens before the game socket exists, so the 45 s connect window
  // only starts once the client is actually connected.
  bot.once('connect', () => arm(45000, 'timeout 45s (no spawn)'))

  abortCurrent = () => {
    clearTimeout(timer)
    finished = true
    busy = false
    try { bot.quit() } catch (e) {}
    bot = null
    abortCurrent = null
  }
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

// --------------------------------------------------------------------- page

const CSS = `
:root{--bg:#0e1116;--card:#161c24;--line:#242c37;--txt:#e9eef5;--dim:#8e9bab;
--ok:#3ddc97;--bad:#ff6b6b;--warn:#ffc857;--accent:#5aa9ff;--idle:#5d6b7c}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.55 -apple-system,system-ui,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;padding:16px 16px 40px}
main{max-width:640px;margin:0 auto}
h1{margin:0 0 4px;font-size:20px;letter-spacing:.2px}
.sub{margin:0 0 16px;color:var(--dim);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin:0 0 12px}
.card h2{margin:0 0 10px;font-size:13px;font-weight:600;color:var(--dim);letter-spacing:.6px;text-transform:uppercase}
#verdict{border-left:4px solid var(--idle)}
#verdict.ok{border-left-color:var(--ok)}
#verdict.bad{border-left-color:var(--bad)}
#verdict .state{font-size:19px;font-weight:650;margin:0 0 4px}
#verdict.ok .state{color:var(--ok)}
#verdict.bad .state{color:var(--bad)}
#verdict .hint{margin:0;color:var(--dim);font-size:13px;word-break:break-word}
label{display:block;font-size:12px;color:var(--dim);margin:0 0 10px}
.row{display:flex;gap:10px}
.row label{flex:1}
input[type=text],input[type=number]{width:100%;height:48px;margin-top:5px;padding:0 12px;background:#0f141a;
color:var(--txt);border:1px solid var(--line);border-radius:10px;font-size:16px}
input[type=text]:focus,input[type=number]:focus{outline:none;border-color:var(--accent)}
.check{display:flex;align-items:center;gap:10px;font-size:14px;color:var(--txt);margin:2px 0 14px}
.check input{width:20px;height:20px;accent-color:var(--accent)}
button{width:100%;height:50px;border:0;border-radius:12px;background:var(--accent);color:#07131f;
font-size:16px;font-weight:650;letter-spacing:.3px}
button:disabled{background:#2b3542;color:var(--dim)}
ul.steps{list-style:none;margin:0;padding:0}
ul.steps li{display:flex;align-items:flex-start;gap:10px;padding:7px 0;border-top:1px solid var(--line);font-size:13.5px}
ul.steps li:first-child{border-top:0}
.mark{flex:0 0 20px;height:20px;line-height:20px;text-align:center;border-radius:50%;font-size:12px;font-weight:700}
.mark.ok{background:rgba(61,220,151,.16);color:var(--ok)}
.mark.bad{background:rgba(255,107,107,.16);color:var(--bad)}
.name{flex:1;word-break:break-word}
.name small{display:block;color:var(--dim);font-size:12px;word-break:break-word}
.ms{color:var(--dim);font-size:12px;flex:0 0 auto;padding-top:2px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0}
.chip{background:#0f141a;border:1px solid var(--line);border-radius:999px;padding:3px 9px;font-size:12px;color:var(--dim)}
#authbox{background:rgba(255,200,87,.06);border-color:rgba(255,200,87,.3)}
#authbox a{color:var(--warn);word-break:break-all}
#authbox button.ghost{display:none;background:#1d2530;color:var(--dim);height:44px;font-size:14px;margin-top:10px}
small#authhint{display:none;color:var(--warn);font-size:12px;margin:-4px 0 12px}
.subhint{display:block;color:var(--dim);font-size:12px;margin:-4px 0 12px;line-height:1.45}
.subhint.resolved{display:none;color:var(--accent);margin-top:-6px}
#authbox .code{font:600 22px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:2px;color:var(--warn);margin:6px 0}
#authbox a{color:var(--warn)}
details{border-top:1px solid var(--line);margin-top:12px;padding-top:10px}
summary{cursor:pointer;color:var(--dim);font-size:13px}
pre{white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);margin:8px 0 0}
`

const PAGE = `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>M3 探针</title>
<style>${CSS}</style>
</head><body><main>
<h1>M3 探针</h1>
<p class="sub">验证 mineflayer 能否在 nodejs-mobile 里连接服务器。只有 "已连接并 spawn" 才算通过。</p>

<section id="verdict" class="card">
  <p class="state">正在读取状态…</p>
  <p class="hint"></p>
</section>

<section class="card">
  <h2>连接目标</h2>
  <form id="form">
    <div class="row">
      <label>服务器地址
        <input id="host" name="host" type="text" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false">
      </label>
      <label style="flex:0 0 96px">端口
        <input id="port" name="port" type="number" inputmode="numeric" min="1" max="65535">
      </label>
    </div>
    <small id="hosthint" class="subhint"></small>
    <small id="effective" class="subhint resolved"></small>
    <label>玩家名
      <input id="user" name="user" type="text" autocapitalize="off" autocorrect="off" spellcheck="false">
    </label>
    <label class="check"><input id="auth" type="checkbox"> 使用微软登录（正版服）</label>
    <small id="authhint">微软登录时，“玩家名”要填账号邮箱（如 you@outlook.com）</small>
    <button id="go" type="submit">连接</button>
  </form>
</section>

<section id="authbox" class="card">
  <h2>微软登录</h2>
  <p class="hint" id="authmsg"></p>
  <p class="code" id="authcode"></p>
  <p class="hint"><a id="authlink" target="_blank" rel="noreferrer"></a></p>
  <button id="logout" class="ghost" type="button">清除登录缓存</button>
</section>

<section class="card">
  <h2>步骤</h2>
  <ul class="steps" id="steps"></ul>
  <details><summary>原始 JSON</summary><pre id="raw"></pre></details>
</section>

<section class="card">
  <h2>运行环境</h2>
  <p class="chips" id="chips"></p>
</section>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id) }
  var form = $('form'), go = $('go')

  // A require stack can be kilobytes long; the full text stays in 原始 JSON.
  function shorten (s, n) { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s }

  // Defaults come from the server (intent args), the last values typed win.
  var last = {}
  try { last = JSON.parse(localStorage.getItem('m3probe') || '{}') } catch (e) {}

  function verdict (d) {
    var box = $('verdict'), state = box.querySelector('.state'), hint = box.querySelector('.hint')
    box.className = 'card'
    var c = d.connect
    if (!c) {
      state.textContent = '未测试'
      hint.textContent = '填好地址后点“连接”。'
      return
    }
    if (c.ok) {
      box.className = 'card ok'
      state.textContent = '通过 · 已连接并 spawn'
      hint.textContent = '版本 ' + (d.connectVersion || '?') + '，坐标 ' + (d.connectPos ? d.connectPos.join(', ') : '?') +
        '，用时 ' + c.ms + ' ms。门已过，可以开始第 3 步。'
      return
    }
    box.className = 'card bad'
    state.textContent = '未通过'
    var detail = c.detail || ''
    var tip = ''
    if (detail.indexOf('ECONNREFUSED') >= 0) tip = '地址通了但端口没人监听：确认服务端已启动、端口正确，别填 127.0.0.1（那是手机自己）。'
    else if (/ECONNABORTED|ETIMEDOUT|EHOSTUNREACH/.test(detail)) tip = 'TCP 没人回应：这个地址多半不是 Java 版入口（域名常靠 SRV 记录指路）。核对拼写，或直接问服务器要 IP:端口。'
    else if (detail.indexOf('timeout') >= 0) tip = '超时：检查手机与服务端是否同一网络，或服务端防火墙。'
    else if (detail.indexOf('kicked') >= 0) tip = '被踢出：正版服请勾选“微软登录”再试。'
    else if (detail.indexOf('ENOTFOUND') >= 0 || detail.indexOf('EAI_AGAIN') >= 0) tip = '域名解析失败：改用 IP 试试。'
    hint.textContent = shorten(detail, 320) + (tip ? ' — ' + tip : '')
  }

  function steps (d) {
    var ul = $('steps')
    ul.textContent = ''
    if (!d.steps.length) {
      var li = document.createElement('li')
      li.innerHTML = '<span class="mark"></span><span class="name">还没有步骤</span>'
      ul.appendChild(li)
      return
    }
    d.steps.forEach(function (s) {
      var li = document.createElement('li')
      var mark = document.createElement('span')
      mark.className = 'mark ' + (s.ok ? 'ok' : 'bad')
      mark.textContent = s.ok ? '✓' : '✗'
      var name = document.createElement('span')
      name.className = 'name'
      name.textContent = s.name
      if (s.detail !== undefined) {
        var small = document.createElement('small')
        small.textContent = typeof s.detail === 'string' ? shorten(s.detail, 240) : JSON.stringify(s.detail)
        name.appendChild(small)
      }
      var ms = document.createElement('span')
      ms.className = 'ms'
      ms.textContent = s.ms + ' ms'
      li.appendChild(mark); li.appendChild(name); li.appendChild(ms)
      ul.appendChild(li)
    })
  }

  function chips (d) {
    var box = $('chips')
    box.textContent = ''
    ;['node ' + d.node, d.platform + '/' + d.arch, 'v8 ' + d.v8, 'uv ' + d.uv].forEach(function (t) {
      var s = document.createElement('span')
      s.className = 'chip'
      s.textContent = t
      box.appendChild(s)
    })
  }

  function auth (d) {
    var msg = $('authmsg'), code = $('authcode'), link = $('authlink'), out = $('logout')
    var state = d.authState || 'none'
    out.style.display = (state === 'ok' || state === 'cached') ? 'block' : 'none'
    code.style.display = 'none'
    link.style.display = 'none'
    link.removeAttribute('href')
    link.textContent = ''
    if (state === 'pending' && d.auth) {
      msg.textContent = '用手机浏览器打开下面的链接，输入代码完成授权。授权成功后会自动继续连接。'
      code.style.display = 'block'
      code.textContent = d.auth.userCode || ''
      if (d.auth.url) {
        link.style.display = ''
        link.href = d.auth.url
        link.textContent = d.auth.url
      }
    } else if (state === 'ok' || state === 'cached') {
      msg.textContent = '已登录：' + (d.authName || '凭据已保存') +
        '。token 已缓存，再连不会重新要设备码；失效时会自动刷新。' +
        (d.authError ? ' 上次错误：' + d.authError : '')
    } else if (state === 'failed') {
      msg.textContent = '登录失败：' + (d.authError || '看下方步骤里的错误') +
        '。如果是超时或网络错误，先确认手机能上网。'
    } else {
      msg.textContent = '未登录。勾选“使用微软登录”、玩家名填账号邮箱后点连接，会给出设备码。'
    }
  }

  function hostHint (d) {
    var el = $('hosthint')
    var ips = (d.localIps || []).join(', ')
    el.textContent = '填服务器的地址：局域网填电脑的 IP（如 192.168.1.23），公服用服务器给的域名或 IP。' +
      '127.0.0.1 是手机自己。' + (ips ? '手机当前地址：' + ips : '')
  }

  function effective (d) {
    var el = $('effective')
    var typed = d.target ? d.target.host + ':' + d.target.port : ''
    if (d.resolved && typed && d.resolved !== typed) {
      el.style.display = 'block'
      el.textContent = '实际连接：' + d.resolved + (d.resolveNote ? '（SRV → ' + d.resolveNote + '）' : '')
    } else {
      el.style.display = 'none'
    }
  }

  var seen = ''
  function render (d) {
    verdict(d); steps(d); chips(d); auth(d); hostHint(d); effective(d)
    var sig = JSON.stringify([d.steps.length, d.connect, d.auth, d.updatedAt])
    if (sig !== seen) { seen = sig; $('raw').textContent = JSON.stringify(d, null, 2) }
  }

  function tick () {
    fetch('/result', { cache: 'no-store' }).then(function (r) { return r.json() }).then(render).catch(function () {})
  }

  var boot = null
  function fillDefaults (d) {
    if (boot) return
    boot = d
    $('host').value = last.host || d.target.host
    $('port').value = last.port || d.target.port
    $('user').value = last.user || d.target.user
    $('auth').checked = last.auth !== undefined ? !!last.auth : d.target.auth === 'microsoft'
    syncAuthHint()
  }

  fetch('/result', { cache: 'no-store' }).then(function (r) { return r.json() }).then(function (d) {
    fillDefaults(d); render(d)
  })

  function syncAuthHint () {
    $('authhint').style.display = $('auth').checked ? 'block' : 'none'
  }
  $('auth').addEventListener('change', syncAuthHint)

  $('logout').addEventListener('click', function () {
    fetch('/logout', { cache: 'no-store' }).then(tick).catch(function () {})
  })

  form.addEventListener('submit', function (e) {
    e.preventDefault()
    var user = $('user').value.trim()
    if ($('auth').checked && user.indexOf('@') < 0) {
      $('authhint').style.display = 'block'
      $('authhint').textContent = '微软登录需要账号邮箱，例如 you@outlook.com'
      $('user').focus()
      return
    }
    var q = 'host=' + encodeURIComponent($('host').value.trim()) +
      '&port=' + encodeURIComponent($('port').value.trim()) +
      '&user=' + encodeURIComponent($('user').value.trim()) +
      '&auth=' + ($('auth').checked ? '1' : '0')
    try {
      localStorage.setItem('m3probe', JSON.stringify({
        host: $('host').value.trim(), port: $('port').value.trim(),
        user: $('user').value.trim(), auth: $('auth').checked
      }))
    } catch (err) {}
    go.disabled = true
    go.textContent = '连接中…'
    fetch('/run?' + q).then(function () {
      setTimeout(function () { go.disabled = false; go.textContent = '连接'; tick() }, 400)
      tick()
    }).catch(function () { go.disabled = false; go.textContent = '连接' })
  })

  tick()
  setInterval(tick, 1500)
})()
</script></body></html>`

function applyTarget (url) {
  const q = url.searchParams
  let changed = false
  const host = (q.get('host') || '').trim()
  if (host) { HOST = host; changed = true }
  const port = Number(q.get('port'))
  if (Number.isInteger(port) && port > 0 && port < 65536) { PORT = port; changed = true }
  const user = (q.get('user') || '').trim()
  if (user) { USERNAME = user; changed = true }
  if (q.has('auth')) {
    const on = q.get('auth') === '1'
    if (on !== wantAuth) { wantAuth = on; changed = true }
  }
  return changed
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')

  if (url.pathname === '/result') {
    persist()
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(status))
    return
  }

  if (url.pathname === '/logout') {
    if (abortCurrent) abortCurrent()
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true })
    } catch (e) {
      status.authError = 'clear failed: ' + e.message
    }
    status.auth = null
    status.authState = 'none'
    status.authName = null
    status.authError = null
    persist()
  }

  if (url.pathname === '/run') {
    if (abortCurrent) abortCurrent()
    applyTarget(url)
    saveState()
    // A new target invalidates the previous verdict; keep steps as history.
    status.connect = null
    status.auth = null
    status.connectPos = null
    status.connectVersion = null
    status.authError = null
    if (wantAuth) status.authState = 'pending'
    connectOnce()
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(PAGE)
})

server.on('error', (e) => step('http server', false, e.message))
server.listen(STATUS_PORT, '127.0.0.1', () => {
  step('http server on ' + STATUS_PORT, true)
  if (!mineflayer) return
  // With Microsoft login and no cached token, wait for the user to tap 连接;
  // otherwise launching the app would immediately ask for a device code.
  if (wantAuth && status.authState !== 'cached' && status.authState !== 'ok') {
    status.authState = 'none'
    persist()
    return
  }
  connectOnce()
})
