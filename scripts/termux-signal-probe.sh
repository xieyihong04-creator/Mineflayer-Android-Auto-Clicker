#!/data/data/com.termux/files/usr/bin/bash
# 真机信号探针：只读，不改配置、不起服务、不碰 bot。
# 用法：
#   bash scripts/termux-signal-probe.sh          # 服务没起也能跑
#   bash scripts/termux-signal-probe.sh 18770    # 顺便把 /api/health 的 signals 打出来
# 输出整段贴回即可。

PORT="${1:-}"

line() { printf '\n===== %s =====\n' "$1"; }

line "device"
getprop ro.product.manufacturer 2>/dev/null
getprop ro.product.model 2>/dev/null
getprop ro.build.version.release 2>/dev/null
getprop ro.build.version.sdk 2>/dev/null
getprop ro.build.display.id 2>/dev/null
getprop ro.miui.ui.version.name 2>/dev/null
uname -a 2>/dev/null

line "termux-api"
if command -v termux-battery-status >/dev/null 2>&1; then
  echo "package: installed"
else
  echo "package: MISSING (pkg install termux-api)"
fi
if command -v termux-battery-status >/dev/null 2>&1; then
  # 只给 10s，App 没装时这条会挂住
  timeout 10 termux-battery-status 2>&1 || echo "termux-battery-status: FAILED/timeout (Termux:API App 没装？)"
fi

line "power_supply nodes"
ls -1 /sys/class/power_supply/ 2>&1
for d in /sys/class/power_supply/*; do
  [ -d "$d" ] || continue
  echo "--- $d"
  printf 'type    = '; cat "$d/type" 2>&1
  printf 'online  = '; cat "$d/online" 2>&1
  printf 'capacity= '; cat "$d/capacity" 2>&1
  printf 'status  = '; cat "$d/status" 2>&1
done

line "thermal zones"
for z in /sys/class/thermal/thermal_zone*; do
  [ -d "$z" ] || continue
  printf '%s  type=' "$(basename "$z")"; cat "$z/type" 2>&1 | tr -d '\n'
  printf '  temp='; cat "$z/temp" 2>&1
done

line "power_save setting"
settings get global low_power 2>&1
settings get system power_save_mode 2>&1

if [ -n "$PORT" ]; then
  line "bridge /api/health signals (port $PORT)"
  curl -s --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>&1 || echo "no response (服务没起 / 端口不对)"
  echo
fi
