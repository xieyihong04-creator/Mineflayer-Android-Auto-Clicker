# Mineflayer Android 挂机端 · v0.1（M1）

Android 上的 Minecraft Java 挂机 bot 控制台。内核 mineflayer，M1 交付 **Termux 直接跑 Node 服务 + localhost WebSocket + 网页 UI**，用于验证 PRD 中全部 P0 功能；M2 再替换为 Compose 前端与前台服务，M3 视需要打包 nodejs-mobile。

```
Compose UI (M2) ──┐
                  │  WebSocket / JSON (localhost, protocol v1)
网页 UI (M1) ─────┤
                  └─ Node: mineflayer + pathfinder + 功耗调度 + 背包/进食
```

## 快速开始（Termux）

```bash
pkg install nodejs-lts
cd ~/mineflayer-android-auto-clicker
npm ci
cp config.example.json config.json   # 或直接留空，打开网页里填
npm start
# 手机浏览器打开 http://127.0.0.1:8765
```

保活 + 崩溃重启 + 常驻通知：

```bash
pkg install termux-api        # 需要同时安装 Termux:API App
bash scripts/termux-start.sh
```

首次微软登录：点「连接」后，网页顶部会出现设备码与链接（`microsoft.com/link`），在浏览器输码授权即可；token 缓存在 `.auth/`，之后重启不需要再登。

## 目录

```
src/index.js            启动：配置、功耗轮询、HTTP/WS 服务
src/bot/manager.js      连接生命周期、退避重连、网络切换、档位副作用
src/bot/nav.js          F4 简单寻路（禁挖/禁跑酷/禁自由移动/禁搭方块）
src/bot/eating.js       F5 自动进食（白名单 + 黑名单，耗尽通知）
src/bot/inventory.js    F6 到点清包（串行 300ms、容器 deposit 或岩浆丢）
src/bot/chat.js         F3 最近 200 条（L0 裁到 50）
src/power/tier.js       F7 档位状态机 + 10s 去抖 + 手动覆盖
src/power/sources.js    Termux 下的电量/温度/亮屏/省电信号（sysfs + dumpsys）
src/bridge/protocol.js  协议 v1 校验与上行构造
src/bridge/server.js    WS + 静态页面 + 指令分发
web/                    移动端网页控制台（无构建、无外部依赖）
test/                   83 个 node:test 用例
```

## P0 验收对照

| ID | 实现 | 说明 |
|---|---|---|
| F1 | `manager.js` + `util/backoff.js` | 设备码登录；指数退避 1→60s 封顶无限重试；网络接口变化立即重连 |
| F2 | `manager.buildState()` / `restartStateLoop()` | L2 2Hz、L1 0.2Hz、L0 0.05Hz；生命/饱食/坐标/朝向/时长/档位 |
| F3 | `chat.js` + UI | 服务器消息保留 200 条；普通聊天与 `/` 指令共用输入框 |
| F4 | `nav.js` | `GoalNear(x,y,z,range)`，`canDig=false`、`allowParkour=false`、`allowFreeMotion=false`、不搭方块；30s 超时上报并可「停止」 |
| F5 | `eating.js` | 阈值默认 14；腐肉/生鸡/毒马铃薯等黑名单优先；无食物只通知一次 |
| F6 | `inventory.js` | 空槽 <3 或 5min 触发；先走到配置的丢弃点，再串行 tossStack（300ms），最后回原点；工具/武器/盔甲/食物保留 |
| F7 | `power/tier.js` | L2/L1/L0/L3 + 10s 去抖；UI 显示当前档位并可「强制 L2」 |
| F8 | `scripts/termux-start.sh` | wake-lock、常驻通知、崩溃重启；真实前台服务属 M2 |

P1 也做了最小版本：挂机点记录/返回、事件通知（掉线/死亡/食物耗尽/背包满）、配置导入导出。

## 功耗分级实现细节

- **信号来源**：`/sys/class/power_supply/*/capacity`、`thermal_zone*/temp`、`dumpsys power`、`settings get global low_power`。任一项读不到都不会崩，退化为“未知/安全默认值”。桌面或测试可用 `MCBOT_MOCK_POWER='{"battery":18,"screenOn":false}'` 模拟。
- **降视距**：只发 `settings` 包（`bot.setSettings({viewDistance:'tiny'})`），让服务器少发区块；**不碰本地 world 数据**。
- **红线**：连接/keepalive、`health` 监听、自动进食不因档位停止。L1 只停日志落盘与推送频率，L0 再降视距/裁聊天/停定时清包。
- **L3**：电量 <10% 立即 `disconnect` 并置 `suspended`，**不进入重连循环**；充电或回到 20% 以上才恢复。

### 与 PRD 字面不一致之处（有意为之，均已在代码注释标注）

1. **L0 并非完全停推**：PRD §4 写“屏幕灭时停推”，但 F2 要求 HUD 可查、§4 红线又要求 health 不停。实测停推会让 UI 在掉线/濒死时全盲，因此 L0 改为 0.05Hz 只推精简状态。
2. **L3 与 F1 的冲突**：F1 要求无限重连，L3 要求主动断开。实现为 L3 期间显式关闭重连，离开 L3 恢复。
3. **充电时不触发 L3**（`l3SkipWhileCharging`，默认开）：24/7 挂机通常插电，5% 就断开没有意义。可关掉。
4. **背包丢弃点必须显式启用**（`dropPoint.set=true`）：默认坐标 0,64,0 一旦自动清包会把 bot 走到莫名其妙的地方。
5. **屏幕状态在 Termux 里只能靠 `dumpsys power`**，某些 ROM 会拒绝；读不到时按“亮屏”处理（不误降档）。

## 桥接协议 v1

上行：`state` / `chat` / `inv` / `nav` / `mode` / `log`（另有 `hello`、`notify`、`auth`、`status`、`error`、`ack`）。

```jsonc
{"t":"state","hp":20,"food":18,"pos":[100.5,64,-200.25],"yaw":0,"nav":false,"mode":"L1","online":3600,"connected":true}
{"t":"chat","ts":1730000000000,"kind":"chat","from":"Steve","text":"hi"}
{"t":"mode","mode":"L0","forced":null,"signals":{"battery":19,"charging":false,"thermal":0,"screenOn":false,"powerSave":false}}
```

下行：`cmd` / `goto` / `stop` / `eat` / `toss` / `setMode` / `connect` / `config`（`protocol.js` 中逐字段校验，非法输入回 `ack ok=false` 且不影响连接）。

```jsonc
{"t":"goto","x":100,"y":64,"z":-200,"range":2}
{"t":"cmd","text":"/spawn"}
{"t":"setMode","mode":"L2"}          // 或 "auto"
{"t":"toss","mode":"cleanup"}        // 或 {"mode":"stack","slot":36}
```

对冻结协议只做了**新增**，没有改字段：`disconnect`（UI 主动断开）与 `waypoint`（P1 挂机点）。消息可带 `id`，服务端回 `{"t":"ack","id":...}`。

## 开发与验证

```bash
npm test          # 83 个用例：档位状态机/退避/协议/背包/进食/寻路超时/桥接端到端
npm run check     # 全量 node --check
MCBOT_MOCK_POWER='{"battery":15,"screenOn":false}' npm start   # 不插真机也能看档位
```

M1 已实测：服务启动、静态页、WS 握手、非法指令拒绝、真实 `createBot` 连不上服务器时的 1→2→4s 指数退避、SIGTERM 干净退出；以及用 mock 电量跑通的档位链路——开机 L0（15%）、`setMode L2` 立即强制、`setMode auto` 回到 L0、`setMode L1` 再强制，`ack` 与 `mode` 广播均正确。

## 已知限制 / 未验证项

- **需要真实服务器才能验证的部分**：微软设备码完整授权、spawn 后的坐标/背包/寻路、容器 deposit 的实际窗口交互。沙箱里只验证到连接失败与重连路径。
- `RSS < 150MB`、`72h 连续在线`、`待机 <3%/h` 属实测指标，当前环境无法测；`MCBOT_MOCK_POWER` 可让档位逻辑在真机上做 A/B。
- Termux 的 `dumpsys power` / `settings` 在部分国产 ROM 上需要额外权限；失败会自动降级，不影响挂机。
- `nodejs-mobile` 打包（M3）未做，M2 继续用 Termux。
- WS 只监听 `127.0.0.1` 且无鉴权；**不要把端口暴露到局域网**。

## 风险对策落地

| 风险 | 现状 |
|---|---|
| 国产 ROM 杀后台 | `termux-start.sh` 申请 wake-lock + 常驻通知；电池白名单仍建议手动加 |
| 长期满电 | 文档提示开 80% 充电上限（系统设置，非应用可控） |
| 1.19+ 签名聊天 | 交给 mineflayer，未自研 |
| AFK 踢人 | `afk.enabled` 可选定时甩头/挥手，默认关闭 |
| Node 版本偏旧 | M1/M2 用 Termux 的 Node 22；M3 再处理 |
