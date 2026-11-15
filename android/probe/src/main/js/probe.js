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
const fs = require('fs')
const path = require('path')

let HOST = process.argv[2] || '127.0.0.1'
let PORT = Number(process.argv[3] || 25565)
let wantAuth = process.argv[4] === '1'
let USERNAME = process.argv[5] || 'Probe'
const STATUS_PORT = 3999

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
  auth: null
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
let busy = false
// Cancels the attempt in flight. The page lets the user change the target while
// a 45 s connect is still pending, so a new /run must be able to drop the old one.
let abortCurrent = null

function connectOnce () {
  if (!mineflayer) {
    status.connect = { ok: false, detail: 'mineflayer did not load' }
    persist()
    return
  }
  if (busy) return
  busy = true
  status.target = { host: HOST, port: PORT, auth: wantAuth ? 'microsoft' : 'offline', user: USERNAME }
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
      persist()
    }
  }
  try {
    bot = mineflayer.createBot(opts)
  } catch (e) {
    busy = false
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
    // Duration of this attempt, not time since boot (the page shows both).
    step('connect ' + HOST + ':' + PORT, ok, detail, Date.now() - started)
    try { bot.quit() } catch (e) {}
    bot = null
    abortCurrent = null
    clearTimeout(timer)
  }

  const timer = setTimeout(() => finish(false, 'timeout 45s (no spawn)'), 45000)
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
#authbox{display:none;background:rgba(255,200,87,.08);border-color:rgba(255,200,87,.35)}
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
    <label>玩家名
      <input id="user" name="user" type="text" autocapitalize="off" autocorrect="off" spellcheck="false">
    </label>
    <label class="check"><input id="auth" type="checkbox"> 使用微软登录（正版服）</label>
    <button id="go" type="submit">连接</button>
  </form>
</section>

<section id="authbox" class="card">
  <h2>微软登录</h2>
  <p class="hint" id="authmsg"></p>
  <p class="code" id="authcode"></p>
  <p class="hint" id="authurl"></p>
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
    else if (detail.indexOf('timeout') >= 0) tip = '超时：检查手机与服务端是否同一网络，或服务端防火墙。'
    else if (detail.indexOf('kicked') >= 0) tip = '被踢出：正版服请勾选“微软登录”再试。'
    else if (detail.indexOf('ENOTFOUND') >= 0 || detail.indexOf('EAI_AGAIN') >= 0) tip = '域名解析失败：改用 IP 试试。'
    hint.textContent = detail + (tip ? ' — ' + tip : '')
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
        small.textContent = typeof s.detail === 'string' ? s.detail : JSON.stringify(s.detail)
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
    var box = $('authbox')
    if (!d.auth) { box.style.display = 'none'; return }
    box.style.display = 'block'
    $('authmsg').textContent = '在任意设备打开下面的链接，输入代码完成授权。'
    $('authcode').textContent = d.auth.userCode || ''
    $('authurl').textContent = d.auth.url || ''
    $('authurl').style.display = 'none'
    if (d.auth.url) {
      $('authurl').style.display = ''
    }
  }

  var seen = ''
  function render (d) {
    verdict(d); steps(d); chips(d); auth(d)
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
  }

  fetch('/result', { cache: 'no-store' }).then(function (r) { return r.json() }).then(function (d) {
    fillDefaults(d); render(d)
  })

  form.addEventListener('submit', function (e) {
    e.preventDefault()
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

  if (url.pathname === '/run') {
    if (abortCurrent) abortCurrent()
    applyTarget(url)
    // A new target invalidates the previous verdict; keep steps as history.
    status.connect = null
    status.auth = null
    status.connectPos = null
    status.connectVersion = null
    connectOnce()
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(PAGE)
})

server.on('error', (e) => step('http server', false, e.message))
server.listen(STATUS_PORT, '127.0.0.1', () => {
  step('http server on ' + STATUS_PORT, true)
  if (mineflayer) connectOnce()
})
