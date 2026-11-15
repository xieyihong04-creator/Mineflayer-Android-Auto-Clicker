#!/data/data/com.termux/files/usr/bin/bash
# 一次性真机采集：把人工操作压到「一条命令 + 一次粘贴」。
#
#   bash scripts/ondevice-once.sh --baseline   # 熄屏 30 min，不跑 bot（减数）
#   bash scripts/ondevice-once.sh              # 登录一次，然后熄屏 30 min（被减数）
#
# 两种模式必须同条件：都熄屏、都不碰手机、同一个充电状态、别改间隔。
# 探针参数固定 60s x 30 次 + wake-lock，且测量期间关掉 bot 内部的 10s 功率
# 日志（MCBOT_POWER_TELEMETRY=0），保证两种模式都只有「1 次/分」这一个采样源。
# 否则 bot-ON 会多出 6 次/分的探针开销，差值就不可解释了。

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

MODE="bot"
case "${1:-}" in
  --baseline) MODE="baseline" ;;
  "") MODE="bot" ;;
  -h|--help)
    echo "usage: bash scripts/ondevice-once.sh [--baseline]"
    exit 0
    ;;
  *)
    echo "unknown argument: $1 (use --baseline or nothing)"
    exit 2
    ;;
esac

STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="$ROOT/logs/ondevice-$MODE-$STAMP"
mkdir -p "$RUN_DIR"
REPORT="$RUN_DIR/report.txt"
BOT_LOG="$RUN_DIR/bot.log"
POWER_JSONL="$RUN_DIR/power.jsonl"
POWER_ERR="$RUN_DIR/power.err"

# 固定参数，勿改（见文件头）。
INTERVAL_S=60
DURATION_S=1800
SAMPLES=$((DURATION_S / INTERVAL_S))
SPAWN_WAIT_S=900

PORT="${MCBOT_PORT:-$(node -e "try{const c=JSON.parse(require('fs').readFileSync('config.json','utf8'));process.stdout.write(String((c.ws&&c.ws.port)||8765))}catch{process.stdout.write('8765')}" 2>/dev/null)}"

say () { printf '%s\n' "$*" | tee -a "$REPORT"; }

say "ondevice-once mode=$MODE $STAMP"
say "params: interval=${INTERVAL_S}s samples=${SAMPLES} duration=${DURATION_S}s wake-lock=on probe=termux-battery-status bot-telemetry=off"
say ""

# ---------------------------------------------------------------- 1. 检桥
say "== 1. Termux:API bridge =="
if ! command -v termux-toast >/dev/null 2>&1; then
  say "FAIL: termux-toast not found. Fix: pkg install termux-api (App 也要装)"
  exit 1
fi
if ! timeout 10 termux-toast -g middle "ondevice-once: bridge ok" >/dev/null 2>&1; then
  {
    echo "FAIL: Termux:API 10 秒内没有应答。按顺序检查："
    echo "1) 安装 Termux:API **App**（F-Droid），只装 pkg 不够"
    echo "2) HyperOS 设置 -> 应用设置 -> 应用管理 -> Termux:API"
    echo "   - 省电策略：无限制"
    echo "   - 自启动：允许"
    echo "   - 后台弹出界面：允许"
    echo "3) Termux 本体同样设为「无限制」"
    echo "4) 单独验证：termux-battery-status 应返回 JSON"
    echo "5) 重新运行本脚本"
  } | tee -a "$REPORT"
  exit 1
fi
say "bridge ok"

# ------------------------------------------------------- 2. 硬件档案 + 温度
say ""
say "== 2. hardware profile =="
{
  echo "-- device"
  getprop ro.product.model 2>/dev/null
  getprop ro.product.manufacturer 2>/dev/null
  getprop ro.build.display.id 2>/dev/null
  getprop ro.build.version.release 2>/dev/null
  getprop ro.build.version.sdk 2>/dev/null

  echo "-- power_supply (expected: EACCES / SELinux, use termux-api instead)"
  ls -ld /sys/class/power_supply 2>&1
  ls /sys/class/power_supply 2>&1 | head -20

  echo "-- termux-battery-status"
  timeout 10 termux-battery-status 2>&1

  echo "-- thermal whitelist (by type, never by zone number)"
  for z in /sys/class/thermal/thermal_zone*; do
    [ -d "$z" ] || continue
    t="$(cat "$z/type" 2>/dev/null)" || continue
    case "$t" in
      quiet_therm|battery|batt_temp|charger_therm)
        printf '%s  type=%s  temp=%s\n' "$(basename "$z")" "$t" "$(cat "$z/temp" 2>/dev/null)"
        ;;
    esac
  done
} | tee -a "$REPORT"

# ---------------------------------------------------- 3. 起 bot（或确认没起）
say ""
if [ "$MODE" = "bot" ]; then
  say "== 3. bridge + login =="
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    say "FAIL: 端口 $PORT 上已经有服务。先停掉：pkill -f src/index.js"
    exit 1
  fi

  termux-wake-lock 2>/dev/null || say "WARN: termux-wake-lock failed (sleep may pause sampling)"
  # 测量期只留脚本这一个采样源。
  MCBOT_POWER_TELEMETRY=0 nohup node src/index.js >>"$BOT_LOG" 2>&1 &
  BOT_PID=$!
  echo "$BOT_PID" >"$RUN_DIR/bot.pid"

  started=0
  i=0
  while [ "$i" -lt 60 ]; do
    i=$((i + 1))
    if curl -s --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      started=1
      break
    fi
    kill -0 "$BOT_PID" 2>/dev/null || break
    sleep 1
  done
  if [ "$started" -ne 1 ]; then
    say "FAIL: bot 没起来（pid $BOT_PID）。日志末尾："
    tail -n 30 "$BOT_LOG" 2>/dev/null | tee -a "$REPORT"
    exit 1
  fi
  say "bot started (pid $BOT_PID), bridge http://127.0.0.1:$PORT"
  say "bot 内部功率日志已关闭（MCBOT_POWER_TELEMETRY=0），采样只由本脚本做。"

  code_line="$(grep -m1 -E "microsoft\.com/link|enter the code" "$BOT_LOG" 2>/dev/null)"
  if [ -n "$code_line" ]; then
    say "device code: $code_line"
  else
    say "设备码还没出现：另开一个 Termux 会话跑 tail -f $BOT_LOG"
  fi

  # 采样必须在 spawn 之后开始：登录 + 加载世界是一次性尖峰，混进 30 分钟
  # 会把整段中位数抬高，而 baseline 没有这段尖峰。
  say ""
  say "等待 spawn（最多 ${SPAWN_WAIT_S}s）；设备码授权完成后会自动继续："
  spawned=0
  waited=0
  while [ "$waited" -lt "$SPAWN_WAIT_S" ]; do
    if curl -s --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"status":"online"'; then
      spawned=1
      break
    fi
    kill -0 "$BOT_PID" 2>/dev/null || break
    sleep 5
    waited=$((waited + 5))
    if [ $((waited % 60)) -eq 0 ]; then
      say "  ...${waited}s: 仍在等待 spawn（auth/status 见 $BOT_LOG）"
    fi
  done
  if [ "$spawned" -ne 1 ]; then
    say "FAIL: ${SPAWN_WAIT_S}s 内没有 spawn，不开始采样（不采没有意义的数字）。"
    say "看 auth 横幅或 $BOT_LOG；修好后重跑本脚本。"
    exit 1
  fi
  say "spawn ok at +${waited}s。**现在熄屏、不要碰手机**，采样从此刻开始。"
else
  say "== 3. baseline mode: no bot =="
  # baseline 必须是「手机本身」：bot 还在跑就等于没做对照。
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    say "FAIL: 端口 $PORT 上有服务在跑，baseline 失去意义。先 pkill -f src/index.js"
    exit 1
  fi
  if command -v pgrep >/dev/null 2>&1 && pgrep -f "node src/index.js" >/dev/null 2>&1; then
    say "FAIL: 还有 node src/index.js 在跑，baseline 失去意义。先 pkill -f src/index.js"
    exit 1
  fi
  termux-wake-lock 2>/dev/null || say "WARN: termux-wake-lock failed (sleep may pause sampling)"
  say "没有 bot 在跑。**现在熄屏、不要碰手机、不要充电**，与 bot-ON 那轮保持同一条件。"
fi

# --------------------------------------------------- 4. 30 分钟功率采样
say ""
say "== 4. power sampling (${SAMPLES} x ${INTERVAL_S}s, single sampler) =="
i=0
while [ "$i" -lt "$SAMPLES" ]; do
  i=$((i + 1))
  ts="$(date +%s)"
  out="$(timeout 10 termux-battery-status 2>>"$POWER_ERR")" || out=""
  if [ -n "$out" ]; then
    printf '{"ts":%s,"data":%s}\n' "$ts" "$out" >>"$POWER_JSONL"
    say "[$i/$SAMPLES] $(date +%H:%M:%S) $out"
  else
    say "[$i/$SAMPLES] $(date +%H:%M:%S) <termux-battery-status failed>"
  fi
  [ "$i" -lt "$SAMPLES" ] && sleep "$INTERVAL_S"
done

# --------------------------------------------------------------- 5. report
say ""
say "== 5. verdict ($MODE) =="
BASELINE_JSONL=""
if [ "$MODE" = "bot" ]; then
  # 自动找最近一份 baseline 的原始采样，免得手算减法。不看旧报告文本，只重算。
  BASELINE_JSONL="$(ls -1t "$ROOT"/logs/ondevice-baseline-*/power.jsonl 2>/dev/null | head -1)"
fi
POWER_JSONL="$POWER_JSONL" BASELINE_JSONL="$BASELINE_JSONL" MODE="$MODE" PORT="$PORT" BOT_LOG="$BOT_LOG" node <<'NODE' | tee -a "$REPORT"
const fs = require('fs')
const http = require('http')

function median (xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// Same guards as src/power/sources.js: full-pack extrapolation only with
// UNPLUGGED + DISCHARGING in the flat 30-80% band.
function parseSamples (file) {
  if (!file || !fs.existsSync(file)) return []
  const out = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try {
      const rec = JSON.parse(line)
      const d = rec.data || {}
      const v = Number(d.voltage)
      const i = Number(d.current)
      const pct = Number(d.percentage)
      const cc = Number(d.charge_counter)
      if (!Number.isFinite(v) || !Number.isFinite(i)) continue
      const plugged = String(d.plugged || '').toUpperCase()
      const status = String(d.status || '').toUpperCase()
      const discharging = plugged.includes('UNPLUGGED') && status === 'DISCHARGING'
      const watts = Math.abs((v / 1000) * (i / 1e6))
      const fullMah = discharging && pct >= 30 && pct <= 80 && Number.isFinite(cc) && cc > 0
        ? (cc / 1000) / (pct / 100)
        : null
      out.push({ watts, pct, fullMah, wh: fullMah ? (fullMah / 1000) * (v / 1000) : null })
    } catch {}
  }
  return out
}

const mine = parseSamples(process.env.POWER_JSONL)
const watts = mine.map((s) => s.watts)
const wMed = watts.length ? median(watts) : null
const wh = median(mine.map((s) => s.wh).filter(Number.isFinite))
const fullMah = median(mine.map((s) => s.fullMah).filter(Number.isFinite))
const estPctPerHour = wMed !== null && wh ? (wMed / wh) * 100 : null

console.log(`samples: ${mine.length}${mine.length ? `  (pct ${Math.min(...mine.map((s) => s.pct))}-${Math.max(...mine.map((s) => s.pct))})` : ''}`)
if (wMed !== null) {
  console.log(`${process.env.MODE === 'baseline' ? 'baseline' : 'bot-ON'} median: ${wMed.toFixed(3)} W  (min ${Math.min(...watts).toFixed(3)} / max ${Math.max(...watts).toFixed(3)})`)
  if (fullMah) console.log(`pack estimate: ${fullMah.toFixed(0)} mAh -> ${wh.toFixed(1)} Wh  (only 30-80% discharging samples)`)
  if (estPctPerHour) console.log(`total draw: ${estPctPerHour.toFixed(2)} %/h  (whole device, NOT the bot increment)`)
} else {
  console.log(`${process.env.MODE === 'baseline' ? 'baseline' : 'bot-ON'} median: NO DATA - do not fill this in by hand`)
}

if (process.env.MODE === 'bot') {
  const base = parseSamples(process.env.BASELINE_JSONL)
  if (base.length) {
    const bWatts = base.map((s) => s.watts)
    const bMed = median(bWatts)
    const bWh = median(base.map((s) => s.wh).filter(Number.isFinite)) || wh
    const deltaW = wMed !== null ? wMed - bMed : null
    console.log(`baseline file: ${process.env.BASELINE_JSONL}`)
    console.log(`baseline median: ${bMed.toFixed(3)} W (n=${base.length})`)
    if (deltaW !== null) {
      console.log(`increment: ${deltaW.toFixed(3)} W -> ${bWh ? ((deltaW / bWh) * 100).toFixed(2) : '?'} %/h  (target < 0.5 %/h)`)
    }
  } else {
    console.log('increment: no baseline run found - run --baseline first, then this again')
  }

  const log = fs.existsSync(process.env.BOT_LOG) ? fs.readFileSync(process.env.BOT_LOG, 'utf8') : ''
  const spawn = /spawned|bot is online/i.test(log)
  const loginErr = (log.match(/login (rejected|failed)[^\n]*/i) || [])[0] || null
  console.log(`spawn: ${spawn ? 'YES' : 'NO'}${loginErr ? `  login error: ${loginErr}` : ''}`)

  http.get(`http://127.0.0.1:${process.env.PORT}/api/health`, (res) => {
    let body = ''
    res.on('data', (c) => { body += c })
    res.on('end', () => {
      let h = {}
      try { h = JSON.parse(body) } catch {}
      console.log(`status: ${h.status || 'unknown'}  mode: ${h.mode || 'unknown'}`)
      console.log('signals:')
      for (const key of ['battery', 'charging', 'thermal', 'screen', 'powerSave']) {
        const row = (h.signals || {})[key] || {}
        console.log(`  ${key.padEnd(10)} ${row.status || 'missing'}${row.bridge ? `  bridge=${row.bridge}` : ''}${row.baseline ? `  baseline=${row.baseline}` : ''}${row.zone ? `  zone=${row.zone}` : ''}`)
      }
      if (h.power) {
        console.log(`power: battery=${h.power.battery} charging=${h.power.charging} thermalDelta=${h.power.thermalDelta} thermalC=${h.power.thermalCelsius} baselineC=${h.power.thermalBaselineC}`)
      }
    })
  }).on('error', (e) => console.log(`health request failed: ${e.message}`))
}
NODE

say ""
say "report: $REPORT"
if [ "$MODE" = "bot" ]; then
  say "bot 仍在运行（pid $(cat "$RUN_DIR/bot.pid")），wake-lock 仍持有。"
  say "停掉：pkill -f src/index.js && termux-wake-unlock"
  say "把 baseline 和 bot-ON 两份 report 一起贴回，不要手改数字。"
else
  say "wake-lock 仍持有（baseline 与 bot-ON 条件一致）。"
  say "接着跑 bot-ON：bash scripts/ondevice-once.sh"
  say "两份 report 一起贴回，不要手改数字。"
fi
