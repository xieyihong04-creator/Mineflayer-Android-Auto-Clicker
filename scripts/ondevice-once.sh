#!/data/data/com.termux/files/usr/bin/bash
# 一次性真机采集：把人工操作压到「一条命令 + 一次粘贴」。
#
#   bash scripts/ondevice-once.sh          # 默认端口读 config.json
#   MCBOT_PORT=18770 bash scripts/ondevice-once.sh
#
# 做的事：检桥 -> 打硬件档案 -> 起 bot（等设备码登录）-> 30 分钟功率采样
#        -> logs/ondevice-<时间>/report.txt
#
# 探针参数是固定的（60s x 30 次，持 termux-wake-lock），这样后面的对照测量
# 可以把这层探针开销抵消掉。改参数会让历史数据失去可比性。

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="$ROOT/logs/ondevice-$STAMP"
mkdir -p "$RUN_DIR"
REPORT="$RUN_DIR/report.txt"
BOT_LOG="$RUN_DIR/bot.log"
POWER_JSONL="$RUN_DIR/power.jsonl"
POWER_ERR="$RUN_DIR/power.err"

# 固定参数，勿改（见文件头）。
INTERVAL_S=60
DURATION_S=1800
SAMPLES=$((DURATION_S / INTERVAL_S))

PORT="${MCBOT_PORT:-$(node -e "try{const c=JSON.parse(require('fs').readFileSync('config.json','utf8'));process.stdout.write(String((c.ws&&c.ws.port)||8765))}catch{process.stdout.write('8765')}" 2>/dev/null)}"

say () { printf '%s\n' "$*" | tee -a "$REPORT"; }

say "ondevice-once $STAMP"
say "params: interval=${INTERVAL_S}s samples=${SAMPLES} duration=${DURATION_S}s wake-lock=on port=${PORT}"
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

# ------------------------------------------------------------- 3. 起 bot
say ""
say "== 3. bridge + login =="
if curl -s --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  say "FAIL: 端口 $PORT 上已经有服务。先停掉：pkill -f src/index.js"
  exit 1
fi

termux-wake-lock 2>/dev/null || say "WARN: termux-wake-lock failed (sleep may pause sampling)"
nohup node src/index.js >>"$BOT_LOG" 2>&1 &
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

code_line="$(grep -m1 -E "microsoft\.com/link|enter the code" "$BOT_LOG" 2>/dev/null)"
if [ -n "$code_line" ]; then
  say "device code: $code_line"
else
  say "设备码还没出现：另开一个 Termux 会话跑 tail -f $BOT_LOG"
fi
say "现在去 https://www.microsoft.com/link 完成授权；采样会在后台继续，不耽误登录。"

# --------------------------------------------------- 4. 30 分钟功率采样
say ""
say "== 4. power sampling (${SAMPLES} x ${INTERVAL_S}s) =="
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
say "== 5. verdict =="
POWER_JSONL="$POWER_JSONL" PORT="$PORT" BOT_LOG="$BOT_LOG" node <<'NODE' | tee -a "$REPORT"
const fs = require('fs')
const http = require('http')

function median (xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const lines = fs.existsSync(process.env.POWER_JSONL)
  ? fs.readFileSync(process.env.POWER_JSONL, 'utf8').split('\n').filter(Boolean)
  : []
const samples = []
for (const line of lines) {
  try {
    const rec = JSON.parse(line)
    const d = rec.data || {}
    const v = Number(d.voltage)
    const i = Number(d.current)
    const pct = Number(d.percentage)
    const cc = Number(d.charge_counter)
    if (!Number.isFinite(v) || !Number.isFinite(i)) continue
    const watts = Math.abs((v / 1000) * (i / 1e6))
    const fullMah = Number.isFinite(cc) && pct > 0 ? (cc / 1000) / (pct / 100) : null
    const wh = fullMah !== null ? (fullMah / 1000) * (v / 1000) : null
    samples.push({ ts: rec.ts, watts, pct, fullMah, wh })
  } catch {}
}

const watts = samples.map((s) => s.watts)
const whs = samples.map((s) => s.wh).filter((x) => Number.isFinite(x))
const wh = whs.length ? median(whs) : null
const wMed = watts.length ? median(watts) : null
console.log(`samples: ${samples.length}`)
if (wMed !== null) {
  console.log(`power median: ${wMed.toFixed(3)} W  (min ${Math.min(...watts).toFixed(3)} / max ${Math.max(...watts).toFixed(3)})`)
  if (wh) console.log(`pack estimate: ${median(samples.map((s) => s.fullMah).filter(Number.isFinite)).toFixed(0)} mAh -> ${wh.toFixed(1)} Wh`)
  console.log(`estimate: ${((wMed / (wh || 27.4)) * 100).toFixed(2)} %/h  (target < 0.5 %/h, needs calibration)`)
} else {
  console.log('power median: NO DATA - do not fill this in by hand')
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
NODE

say ""
say "report: $REPORT"
say "bot 仍在运行（pid $(cat "$RUN_DIR/bot.pid")），wake-lock 仍持有。"
say "停掉：pkill -f src/index.js && termux-wake-unlock"
say "把上面这段（含 hardware profile）原样贴回，不要手改数字。"
