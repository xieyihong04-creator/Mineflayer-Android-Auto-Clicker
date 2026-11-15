'use strict'

/* global WebSocket, location, Blob, URL, document, window */

const els = {
  connDot: document.getElementById('conn-dot'),
  connText: document.getElementById('conn-text'),
  modePill: document.getElementById('mode-pill'),
  modeBtn: document.getElementById('mode-btn'),
  authBanner: document.getElementById('auth-banner'),
  authUrl: document.getElementById('auth-url'),
  authCode: document.getElementById('auth-code'),
  signalBanner: document.getElementById('signal-banner'),
  signalDetail: document.getElementById('signal-detail'),
  hp: document.getElementById('hp'),
  food: document.getElementById('food'),
  pos: document.getElementById('pos'),
  yaw: document.getElementById('yaw'),
  uptime: document.getElementById('uptime'),
  empty: document.getElementById('empty'),
  serverLabel: document.getElementById('server-label'),
  inHost: document.getElementById('in-host'),
  inPort: document.getElementById('in-port'),
  inVersion: document.getElementById('in-version'),
  inUser: document.getElementById('in-user'),
  btnConnect: document.getElementById('btn-connect'),
  btnDisconnect: document.getElementById('btn-disconnect'),
  statusText: document.getElementById('status-text'),
  navText: document.getElementById('nav-text'),
  btnStop: document.getElementById('btn-stop'),
  btnEat: document.getElementById('btn-eat'),
  btnClean: document.getElementById('btn-clean'),
  btnSaveWp: document.getElementById('btn-save-wp'),
  btnGoWp: document.getElementById('btn-go-wp'),
  inX: document.getElementById('in-x'),
  inY: document.getElementById('in-y'),
  inZ: document.getElementById('in-z'),
  inRange: document.getElementById('in-range'),
  btnGoto: document.getElementById('btn-goto'),
  chatLog: document.getElementById('chat-log'),
  chatCount: document.getElementById('chat-count'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  invList: document.getElementById('inv-list'),
  invEmpty: document.getElementById('inv-empty'),
  powerSrc: document.getElementById('power-src'),
  pBattery: document.getElementById('p-battery'),
  pCharging: document.getElementById('p-charging'),
  pThermal: document.getElementById('p-thermal'),
  pScreen: document.getElementById('p-screen'),
  pSaver: document.getElementById('p-saver'),
  pMode: document.getElementById('p-mode'),
  configJson: document.getElementById('config-json'),
  btnConfigLoad: document.getElementById('btn-config-load'),
  btnConfigSave: document.getElementById('btn-config-save'),
  btnConfigExport: document.getElementById('btn-config-export'),
  dpType: document.getElementById('dp-type'),
  dpX: document.getElementById('dp-x'),
  dpY: document.getElementById('dp-y'),
  dpZ: document.getElementById('dp-z'),
  btnDpHere: document.getElementById('btn-dp-here'),
  logTail: document.getElementById('log-tail'),
  logCount: document.getElementById('log-count'),
  toasts: document.getElementById('toasts')
}

const CHAT_LIMIT = 200
const PROTO_VERSION = 1
const state = {
  ws: null,
  connected: false,
  reconnectDelay: 500,
  status: 'offline',
  mode: 'L2',
  forced: null,
  signals: {},
  config: null,
  chat: [],
  logs: [],
  inv: { items: [], empty: null },
  lastState: null,
  lastStateAt: 0,
  ackSeq: 0,
  waypointName: 'afk',
  signalTable: null,
  screenOn: false,
  screenSource: 'unknown'
}

// ------------------------------------------------------------------ utilities

function fmtTime (ts) {
  const d = new Date(ts || Date.now())
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtUptime (ms) {
  if (!ms || ms < 0) return '--'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  return `${m}m${String(sec).padStart(2, '0')}s`
}

function prettify (name) {
  if (!name) return ''
  return name.replace(/_/g, ' ')
}

function toast (message, level = 'info', ttl = 3200) {
  const div = document.createElement('div')
  div.className = `toast ${level}`
  div.textContent = message
  els.toasts.appendChild(div)
  setTimeout(() => {
    div.remove()
  }, ttl)
}

// ------------------------------------------------------------------------- ws

function wsUrl () {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws`
}

function connectWs () {
  const ws = new WebSocket(wsUrl())
  state.ws = ws

  ws.addEventListener('open', () => {
    state.connected = true
    state.reconnectDelay = 500
    renderConn()
    reportScreen()
  })

  ws.addEventListener('message', (event) => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }
    handleMessage(msg)
  })

  ws.addEventListener('close', () => {
    state.connected = false
    renderConn()
    const delay = state.reconnectDelay
    state.reconnectDelay = Math.min(delay * 2, 5000)
    setTimeout(connectWs, delay)
  })

  ws.addEventListener('error', () => {
    try { ws.close() } catch {}
  })
}

function send (msg) {
  if (!state.ws || state.ws.readyState !== 1) {
    toast('控制台未连接', 'warn')
    return Promise.resolve({ ok: false })
  }
  const id = ++state.ackSeq
  const payload = { ...msg, id }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 20000)
    const onMessage = (event) => {
      let data
      try {
        data = JSON.parse(event.data)
      } catch {
        return
      }
      if (data.t === 'ack' && data.id === id) {
        clearTimeout(timer)
        state.ws.removeEventListener('message', onMessage)
        if (!data.ok) toast(data.error || '操作失败', 'warn')
        resolve(data)
      }
    }
    state.ws.addEventListener('message', onMessage)
    state.ws.send(JSON.stringify(payload))
  })
}

// -------------------------------------------------------------------- handlers

function handleMessage (msg) {
  switch (msg.t) {
    case 'hello':
      applyHello(msg)
      break
    case 'state':
      applyState(msg)
      break
    case 'mode':
      applyMode(msg)
      break
    case 'status':
      state.status = msg.status && msg.status.status ? msg.status.status : state.status
      renderStatus()
      break
    case 'chat':
      addChat(msg)
      break
    case 'inv':
      applyInv(msg)
      break
    case 'nav':
      applyNav(msg)
      break
    case 'log':
      addLog(msg)
      break
    case 'notify':
      toast(msg.msg, msg.level === 'warn' ? 'warn' : 'info', 5000)
      break
    case 'auth':
      showAuth(msg)
      break
    case 'config':
      if (msg.config) applyConfig(msg.config)
      break
    case 'signals':
      applySignals(msg.signals)
      break
    case 'error':
      toast(msg.msg, 'warn')
      break
    default:
      break
  }
}

function applyHello (msg) {
  if (msg.protoVersion !== undefined && msg.protoVersion !== PROTO_VERSION) {
    toast(`协议版本不匹配：服务端 v${msg.protoVersion}，页面 v${PROTO_VERSION}`, 'warn', 8000)
  }
  if (msg.status) {
    state.status = msg.status.status || state.status
    renderStatus()
  }
  if (msg.mode) applyMode(msg.mode)
  if (msg.signals) applySignals(msg.signals)
  if (msg.config) applyConfig(msg.config)
  if (Array.isArray(msg.chat)) {
    state.chat = msg.chat.slice(-CHAT_LIMIT)
    renderChat()
  }
  if (msg.inv) applyInv(msg.inv)
  if (msg.live === false) {
    state.status = 'suspended'
  }
  if (msg.status && msg.status.suspended) state.status = 'suspended'
  if (Array.isArray(msg.logs)) {
    state.logs = msg.logs.slice(-80)
    renderLogs()
  }
  if (msg.config && msg.config.server) fillConnectForm(msg.config.server)
}

function applyState (s) {
  state.lastState = s
  state.lastStateAt = Date.now()
  if (s.connected && state.status !== 'online') state.status = 'online'
  if (!s.connected && state.status === 'online') state.status = 'offline'
  els.hp.textContent = s.hp == null ? '--' : `${Math.round(s.hp * 10) / 10}`
  els.food.textContent = s.food == null ? '--' : String(s.food)
  els.pos.textContent = s.pos ? `${s.pos[0]} / ${s.pos[1]} / ${s.pos[2]}` : '--'
  els.yaw.textContent = s.yaw == null ? '--' : `${Math.round((s.yaw * 180) / Math.PI)}°`
  els.uptime.textContent = fmtUptime(s.online)
  if (state.inv && state.inv.empty != null) els.empty.textContent = String(state.inv.empty)
  if (s.empty != null) els.empty.textContent = String(s.empty)
  if (s.mode) applyMode({ mode: s.mode, forced: s.forced })
  if (s.pos) {
    if (!els.inX.value) els.inX.value = Math.round(s.pos[0])
    if (!els.inY.value) els.inY.value = Math.round(s.pos[1])
    if (!els.inZ.value) els.inZ.value = Math.round(s.pos[2])
  }
  renderStatus()
}

function applyMode (mode) {
  if (!mode) return
  state.mode = mode.mode || state.mode
  state.forced = mode.forced || null
  state.signals = mode.signals || state.signals
  els.modePill.textContent = state.mode
  els.modePill.className = `pill ${state.mode}`
  els.pMode.textContent = state.mode
  els.modeBtn.textContent = state.forced ? '恢复自动档位' : '强制 L2'
  els.modeBtn.dataset.forced = state.forced ? '1' : '0'
  renderSignals()
}

function renderSignals () {
  const s = state.signals || {}
  els.pBattery.textContent = s.battery == null ? '--' : `${s.battery}%`
  els.pCharging.textContent = s.charging == null ? '未知' : (s.charging ? '是' : '否')
  els.pThermal.textContent = s.thermal == null ? '--' : `T${s.thermal}`
  const screenMap = { ui: 'UI 上报', no_client: '无观察者', unknown: '未知→按灭', fallback: '模拟' }
  els.pScreen.textContent = `${s.screenOn ? '亮' : '灭'}（${screenMap[s.screenSource] || s.screenSource || '--'}）`
  els.pSaver.textContent = s.powerSave ? '开' : '关'
  els.powerSrc.textContent = s.source === 'mock' ? '模拟信号' : 'Android 信号'
}

const SIGNAL_LABELS = { battery: '电量', charging: '充电', thermal: '温度', screen: '屏幕', powerSave: '省电模式' }

/**
 * Startup self-check table from `hello` / `{t:'signals'}`. Every external
 * signal has a third "unavailable" state; showing "100%" or "T0" when the
 * sensor could not be read is exactly the bug this banner exists to prevent.
 */
function applySignals (table) {
  if (!table) return
  state.signalTable = table
  const missing = []
  const isUnavailable = (entry) => String((entry || {}).status || '').startsWith('unavailable')
  for (const [key, label] of Object.entries(SIGNAL_LABELS)) {
    const entry = table[key] || {}
    if (isUnavailable(entry)) missing.push(`${label}不可用`)
    else if (key === 'screen' && entry.status === 'unknown') missing.push('屏幕状态未知（按灭屏处理）')
  }
  const hints = []
  const batteryStatus = String((table.battery || {}).status || '')
  if (batteryStatus.startsWith('unavailable')) {
    hints.push(batteryStatus.includes('selinux')
      ? '电量 sysfs 被 SELinux 拒绝（无 root 无解），需走 Termux:API：pkg install termux-api 并安装 Termux:API App'
      : '电量需安装 Termux:API（pkg install termux-api）且允许 Termux:API 读取电池')
  }
  if (String((table.charging || {}).status || '').startsWith('unavailable')) {
    hints.push('充电状态读不到：低电量仍会断开，不会跳过 L3')
  }
  const thermal = table.thermal || {}
  if (String(thermal.status || '').startsWith('unavailable')) {
    hints.push('温度区不可读（SELinux 或无可识别 zone），L0 温度降档不会触发')
  } else if (thermal.baseline === 'pending') {
    hints.push('温度基线采集中，热降档暂不生效（约 3 分钟）')
  }
  if (String((table.powerSave || {}).status || '').startsWith('unavailable')) {
    hints.push('省电模式读不到（settings 不可用），按未开启处理')
  }
  if (missing.length) {
    els.signalDetail.textContent = `${missing.join('、')}。${hints.join('；')}`
    els.signalBanner.classList.remove('hidden')
  } else if (hints.length) {
    // Only a hint (baseline pending / power save unreadable): keep it visible,
    // it is not "everything is fine".
    els.signalDetail.textContent = hints.join('；')
    els.signalBanner.classList.remove('hidden')
  } else {
    els.signalBanner.classList.add('hidden')
  }
}

function renderStatus () {
  const map = {
    online: '在线',
    connecting: '连接中',
    reconnecting: '重连中',
    offline: '离线',
    suspended: 'L3 已断开',
    halted: '已停机（熔断）'
  }
  const text = map[state.status] || state.status
  els.connText.textContent = text
  els.connDot.className = `dot ${state.status === 'online' ? 'online' : state.status === 'offline' || state.status === 'suspended' || state.status === 'halted' ? 'offline' : 'connecting'}`
  const detail = []
  if (state.lastState && state.lastState.extra) {
    if (state.lastState.extra.status) detail.push(state.lastState.extra.status)
    if (state.lastState.extra.forced) detail.push(`强制${state.lastState.extra.forced}`)
  }
  els.statusText.textContent = detail.join(' · ')
  els.serverLabel.textContent = state.config && state.config.server.host
    ? `${state.config.server.host}:${state.config.server.port}`
    : '未配置'
  const phase = state.status === 'online' || state.status === 'connecting' || state.status === 'reconnecting'
  els.btnConnect.disabled = phase
}

function addChat (msg) {
  state.chat.push(msg)
  if (state.chat.length > CHAT_LIMIT) state.chat.splice(0, state.chat.length - CHAT_LIMIT)
  const nearBottom = els.chatLog.scrollTop + els.chatLog.clientHeight >= els.chatLog.scrollHeight - 40
  els.chatLog.appendChild(chatNode(msg))
  while (els.chatLog.childElementCount > CHAT_LIMIT) els.chatLog.firstElementChild.remove()
  els.chatCount.textContent = String(state.chat.length)
  if (nearBottom) els.chatLog.scrollTop = els.chatLog.scrollHeight
}

function chatNode (msg) {
  const div = document.createElement('div')
  div.className = `msg ${msg.kind || 'chat'}`
  const time = document.createElement('span')
  time.className = 'time'
  time.textContent = fmtTime(msg.ts)
  div.appendChild(time)
  if (msg.from) {
    const who = document.createElement('span')
    who.className = 'who'
    who.textContent = msg.kind === 'action' ? `* ${msg.from}` : `<${msg.from}>`
    div.appendChild(who)
  }
  const text = document.createElement('span')
  text.textContent = msg.text
  div.appendChild(text)
  return div
}

function renderChat () {
  els.chatLog.innerHTML = ''
  for (const msg of state.chat) els.chatLog.appendChild(chatNode(msg))
  els.chatLog.scrollTop = els.chatLog.scrollHeight
  els.chatCount.textContent = String(state.chat.length)
}

function applyInv (msg) {
  state.inv = { items: msg.items || [], empty: msg.empty == null ? state.inv.empty : msg.empty }
  els.invList.innerHTML = ''
  const items = state.inv.items
  if (!items.length) {
    const span = document.createElement('span')
    span.className = 'muted'
    span.textContent = '背包为空'
    els.invList.appendChild(span)
  } else {
    items.sort((a, b) => b.count - a.count)
    for (const item of items) {
      const chip = document.createElement('div')
      chip.className = 'inv-item'
      const name = document.createElement('b')
      name.textContent = prettify(item.name)
      const cnt = document.createElement('span')
      cnt.className = 'cnt'
      cnt.textContent = `x${item.count}`
      chip.appendChild(name)
      chip.appendChild(cnt)
      els.invList.appendChild(chip)
    }
  }
  els.invEmpty.textContent = state.inv.empty == null ? '' : `空槽 ${state.inv.empty}`
  els.empty.textContent = state.inv.empty == null ? '--' : String(state.inv.empty)
}

function applyNav (msg) {
  const map = {
    started: '前往中',
    reached: '已到达',
    stopped: '已停止',
    failed: '寻路失败',
    paused: '已暂停（进食）',
    progress: '寻路中'
  }
  let text = map[msg.state] || '空闲'
  if (msg.state === 'failed' && msg.reason) text += `：${msg.reason}`
  if (msg.state === 'stopped' && msg.reason && msg.reason !== 'user') text += `：${msg.reason}`
  els.navText.textContent = text
  if (msg.state === 'failed' || msg.state === 'stopped' && msg.reason === 'timeout') {
    toast(`寻路结束：${msg.reason || msg.state}`, 'warn')
  }
}

function addLog (entry) {
  state.logs.push(entry)
  if (state.logs.length > 120) state.logs.splice(0, state.logs.length - 120)
  renderLogs()
}

function renderLogs () {
  els.logCount.textContent = `${state.logs.length} 条`
  els.logTail.textContent = state.logs
    .map((l) => `${fmtTime(l.ts)} ${String(l.level || 'info').toUpperCase()} ${l.msg}`)
    .join('\n')
  els.logTail.scrollTop = els.logTail.scrollHeight
}

function showAuth (msg) {
  els.authBanner.classList.remove('hidden')
  els.authCode.textContent = msg.code || '--------'
  if (msg.url) {
    els.authUrl.href = msg.url
    els.authUrl.textContent = msg.url
  }
  toast('需要微软设备码登录', 'info', 8000)
}

function applyConfig (config) {
  state.config = config
  els.configJson.value = JSON.stringify(config, null, 2)
  fillConnectForm(config.server)
  const dp = config.inv && config.inv.dropPoint
  if (dp) {
    els.dpType.value = dp.type || 'lava'
    els.dpX.value = dp.x
    els.dpY.value = dp.y
    els.dpZ.value = dp.z
  }
  renderStatus()
}

function fillConnectForm (server) {
  if (!server) return
  if (document.activeElement !== els.inHost) els.inHost.value = server.host || ''
  if (document.activeElement !== els.inPort) els.inPort.value = server.port || 25565
  if (document.activeElement !== els.inVersion) els.inVersion.value = server.version || ''
  if (document.activeElement !== els.inUser) els.inUser.value = server.username || ''
  els.serverLabel.textContent = server.host ? `${server.host}:${server.port}` : '未配置'
}

// --------------------------------------------------------------------- actions

els.btnConnect.addEventListener('click', async () => {
  const host = els.inHost.value.trim()
  if (!host) return toast('请填写服务器地址', 'warn')
  state.status = 'connecting'
  renderStatus()
  await send({
    t: 'connect',
    host,
    port: Number(els.inPort.value) || 25565,
    version: els.inVersion.value.trim() || false,
    username: els.inUser.value.trim() || undefined
  })
})

els.btnDisconnect.addEventListener('click', async () => {
  await send({ t: 'disconnect', reason: 'user' })
})

els.modeBtn.addEventListener('click', async () => {
  const forced = els.modeBtn.dataset.forced === '1'
  await send({ t: 'setMode', mode: forced ? 'auto' : 'L2' })
  toast(forced ? '已恢复自动档位' : '已强制 L2（10s 去抖不生效）', 'info')
})

els.btnStop.addEventListener('click', () => send({ t: 'stop' }))
els.btnEat.addEventListener('click', async () => {
  const res = await send({ t: 'eat' })
  if (res && res.ok === false) toast(res.error || '进食失败', 'warn')
})
els.btnClean.addEventListener('click', async () => {
  const res = await send({ t: 'toss', mode: 'cleanup' })
  if (res && res.ok === false) toast(res.error || '清理失败', 'warn')
})

els.btnGoto.addEventListener('click', () => {
  const x = Number(els.inX.value)
  const y = Number(els.inY.value)
  const z = Number(els.inZ.value)
  if (![x, y, z].every(Number.isFinite)) return toast('坐标无效', 'warn')
  send({ t: 'goto', x, y, z, range: Number(els.inRange.value) || 2 })
})

els.btnSaveWp.addEventListener('click', async () => {
  const name = window.prompt('挂机点名称', state.waypointName || 'afk')
  if (!name) return
  state.waypointName = name
  const res = await send({ t: 'waypoint', action: 'save', name })
  if (res && res.ok) toast(`已记录挂机点 ${name}`, 'info')
})

els.btnGoWp.addEventListener('click', async () => {
  const res = await send({ t: 'waypoint', action: 'go', name: state.waypointName || 'afk' })
  if (res && res.ok === false) toast(res.error || '没有这个挂机点', 'warn')
})

els.chatForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const text = els.chatInput.value.trim()
  if (!text) return
  send({ t: 'cmd', text })
  els.chatInput.value = ''
})

els.btnConfigLoad.addEventListener('click', () => send({ t: 'config', action: 'get' }))

els.btnConfigSave.addEventListener('click', async () => {
  let parsed
  try {
    parsed = JSON.parse(els.configJson.value)
  } catch (err) {
    return toast(`JSON 格式错误：${err.message}`, 'warn')
  }
  const res = await send({ t: 'config', action: 'set', patch: parsed })
  if (res && res.ok) toast('配置已保存', 'info')
})

els.btnConfigExport.addEventListener('click', () => {
  const blob = new Blob([els.configJson.value], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'mcbot-config.json'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
})

els.btnDpHere.addEventListener('click', () => {
  const pos = els.pos.textContent.split(' / ').map(Number)
  if (pos.length !== 3 || !pos.every(Number.isFinite)) return toast('当前没有坐标', 'warn')
  const patch = {
    inv: {
      dropPoint: {
        set: true,
        type: els.dpType.value,
        x: Math.floor(pos[0]),
        y: Math.floor(pos[1]),
        z: Math.floor(pos[2])
      }
    }
  }
  els.dpX.value = patch.inv.dropPoint.x
  els.dpY.value = patch.inv.dropPoint.y
  els.dpZ.value = patch.inv.dropPoint.z
  send({ t: 'config', action: 'set', patch }).then((res) => {
    if (res && res.ok) toast('丢弃点已设为当前位置', 'info')
  })
})

// keep uptime ticking even between state pushes (L0 pushes 0.05Hz)
setInterval(() => {
  if (state.lastState) {
    const extra = state.lastState.connected ? Date.now() - state.lastStateAt : 0
    els.uptime.textContent = fmtUptime((state.lastState.online || 0) + extra)
  }
}, 1000)

// Screen authority. M2: the Android shell runs a WebView and calls
// window.mcbotNative.screen(on) from ACTION_SCREEN_ON/OFF, which needs no
// permission and keeps working while the page is hidden. M1 fallback:
// `visibilitychange` (desktop browser / plain Termux). Unknown always degrades
// to off. While an observer is active we re-report every 45s so the server
// never treats it as stale (server also refreshes on any upstream message).
const SCREEN_HEARTBEAT_MS = 45000
let nativeShell = false

function sendUp (msg) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(msg))
}

function applyScreen (on, source) {
  state.screenOn = Boolean(on)
  state.screenSource = source
  sendUp({ t: 'screen', on: state.screenOn })
}

function reportVisibility () {
  applyScreen(!document.hidden, 'ui')
}

// Re-assert whatever the current authority says (WS opened / heartbeat).
function reportScreen () {
  if (nativeShell) sendUp({ t: 'screen', on: state.screenOn })
  else reportVisibility()
}

// Called from native via evaluateJavascript. Installed before init so an
// early broadcast is never lost; `init` carries the current device state.
window.mcbotNative = {
  init (payload) {
    nativeShell = true
    const p = payload || {}
    if (typeof p.screenOn === 'boolean') applyScreen(p.screenOn, 'native')
    else if (state.connected) sendUp({ t: 'screen', on: state.screenOn })
    if (Number.isInteger(p.thermal)) sendUp({ t: 'thermal', value: p.thermal })
    if (typeof p.powerSave === 'boolean') sendUp({ t: 'powerSave', on: p.powerSave })
  },
  screen (on) {
    nativeShell = true
    applyScreen(on, 'native')
  },
  thermal (value) {
    if (Number.isInteger(value)) sendUp({ t: 'thermal', value })
  },
  powerSave (on) {
    if (typeof on === 'boolean') sendUp({ t: 'powerSave', on })
  }
}

document.addEventListener('visibilitychange', () => {
  // Native broadcast wins; the WebView's own visibility also goes false while
  // the screen is off with the shell alive, but it is a weaker signal.
  if (nativeShell) return
  reportVisibility()
})
setInterval(() => {
  if (!state.connected) return
  if (nativeShell) sendUp({ t: 'screen', on: state.screenOn })
  else if (!document.hidden) reportVisibility()
}, SCREEN_HEARTBEAT_MS)

renderConn()
function renderConn () {
  if (!state.connected) {
    els.connText.textContent = '控制台断开'
    els.connDot.className = 'dot offline'
  } else {
    renderStatus()
  }
}

connectWs()
