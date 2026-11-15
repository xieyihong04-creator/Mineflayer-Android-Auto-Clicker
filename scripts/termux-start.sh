#!/data/data/com.termux/files/usr/bin/bash
# M1 启动脚本：Termux 保活 + 崩溃重启 + 常驻通知。
# 用法：bash scripts/termux-start.sh
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

# 让 Termux 不被立刻挂起（等效于 F8 的"缺权限时显式告警"）。
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock || true
else
  echo "[warn] 未安装 Termux:API，无法申请 wake-lock（pkg install termux-api）"
fi

notify () {
  if command -v termux-notification >/dev/null 2>&1; then
    termux-notification --title "MC 挂机" --content "$1" --priority low >/dev/null 2>&1 || true
  fi
}

if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "[info] 已生成 config.json，请先填写服务器地址与账号，或直接打开网页配置"
fi

notify "服务启动，控制台 http://127.0.0.1:8765"

while true; do
  node src/index.js
  code=$?
  echo "[warn] node exited with $code, restarting in 3s"
  notify "进程退出（$code），3 秒后自动重启"
  sleep 3
done
