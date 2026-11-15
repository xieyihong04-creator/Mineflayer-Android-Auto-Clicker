# Mineflayer Android Console · v0.1（M1）

Android 上的 Minecraft Java 挂机 bot 控制台。内核 mineflayer，M1 交付 **Termux 直接跑 Node 服务 + localhost WebSocket + 网页 UI**，用于验证 PRD 中全部 P0 功能；M2 再替换为 Compose 前端与前台服务，M3 视需要打包 nodejs-mobile。

> 项目已从 `mineflayer-android-auto-clicker` 更名为 **mineflayer-android-console**：本项目不做任何输入自动化 / 点击器，"auto-clicker" 会误导。GitHub 仓库名需在网页端同步改名（远端仓库改名不改历史）。

```
Compose UI (M2) ──┐
                  │  WebSocket / JSON (localhost, protocol v1)
网页 UI (M1) ─────┤
                  └─ Node: mineflayer + pathfinder + 功耗调度 + 背包/进食
```

## 快速开始（Termux）

```bash
pkg install nodejs-lts
cd ~/mineflayer-android-console      # 仓库若尚未改名，目录名用 mineflayer-android-auto-clicker
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
src/power/tier.js       F7 档位状态机 + 10s 去抖 + L3 迟滞 + 手动覆盖
src/power/screen.js     亮屏权威来源：UI 事件上报，未知/无观察者一律按灭屏
src/power/sources.js    Termux 下的电量/温度/省电信号（sysfs，不再依赖 dumpsys）
src/bot/respawn.js      F9 自动重生 + 回挂机点 + 连续死亡熔断
src/bot/droppoint.js    丢弃点站立安全 + 可达性预检
src/bridge/protocol.js  协议 v1 校验与上行构造
src/bridge/server.js    WS + 静态页面 + 指令分发
web/                    移动端网页控制台（无构建、无外部依赖）
docs/                   真机验收清单
test/                   155 个 node:test 用例
```

## P0 验收对照

| ID | 实现 | 说明 |
|---|---|---|
| F1 | `manager.js` + `util/backoff.js` | 设备码登录；指数退避 1→60s 封顶无限重试；网络接口变化立即重连 |
| F2 | `manager.buildState()` / `restartStateLoop()` | L2 2Hz、L1 0.2Hz、L0 0.05Hz；生命/饱食/坐标/朝向/时长/档位 |
| F3 | `chat.js` + UI | 服务器消息保留 200 条；普通聊天与 `/` 指令共用输入框 |
| F4 | `nav.js` | `GoalNear(x,y,z,range)`，`canDig=false`、`allowParkour=false`、`allowFreeMotion=false`、不搭方块；30s 超时上报并可「停止」 |
| F5 | `eating.js` | 阈值默认 14；腐肉/生鸡/毒马铃薯等黑名单优先；无食物立即告警一次，生命 ≤ `disconnectAtHealth`（默认 8）时停机 |
| F6 | `inventory.js` | 空槽 <3 或 5min 触发；先走到配置的丢弃点，再串行 tossStack/deposit（300ms），最后回原点；到达后复检站立点、掉血即撤、容器满即停；工具/武器/盔甲/食物保留 |
| F7 | `power/tier.js` | L2/L1/L0/L3 + 10s 去抖；UI 显示当前档位并可「强制 L2」 |
| F8 | `scripts/termux-start.sh` | wake-lock、常驻通知、崩溃重启；真实前台服务属 M2 |
| F9 | `respawn.js` | `death` → 延迟 `respawn()` → 走回挂机点；`windowMs` 内连续 3 次 → 停机 + 通知；重连成功同样回挂机点 |

P1 也做了最小版本：挂机点记录/返回、事件通知（掉线/死亡/食物耗尽/背包满）、配置导入导出。

## 功耗分级实现细节

- **信号来源**：`/sys/class/power_supply/*/capacity`（读不到再试 `termux-battery-status`）、`thermal_zone*/temp`、`settings get global low_power`。桌面或测试可用 `MCBOT_MOCK_POWER='{"battery":18,"screenOn":false}'` 模拟。
- **每个外部信号都有第三态，且不会静默等于正常值**：
  - 电量：sysfs 与 `termux-battery-status` 都失败 → `null`，档位按 **L1** 处理（不是“100%”也不会自动 L2）；UI 顶部弹告警。
  - 电量节点名各 ROM 不同（`battery`/`BATTERY`/`bms`/`BAT0`…）：先扫 `/sys/class/power_supply/*/type == Battery`，再退回固定候选目录。
  - **充电是独立一行**：`capacity` 和 `status` 是两个文件，可以一个读得到一个读不到；充电读不到时为 `null`（UI 显示「未知」），并按“未充电”处理——低电量仍会 L3 断开，不会误跳过。
  - `termux-battery-status` 依赖 **Termux:API App + `pkg install termux-api`**，是硬依赖；未安装时降级为 `unavailable` 而不是假装有读数。
  - 温度：所有 `thermal_zone*` 都不可读（zone 编号各 ROM 不同，有的直接拒读目录）→ `null`，温度降档不触发，UI 明示。
  - 启动自检表随 `hello.signals` 下发（`live` / `live(termux-api)` / `mock` / `unavailable` / `no_client`），运行中有变化再推 `{"t":"signals"}`；同一张表也在 `GET /api/health` 里，真机核对不用截图：`curl -s localhost:8765/api/health`。
- **亮屏状态不再是传感器读取，而是事件上报**（评审裁决 #5）：
  - 非 root 的 Termux 调 `dumpsys power` 需要 DUMP 权限，普通 uid 会被拒，所以"读不到就当亮屏"在真机上是常态路径，会让省电整条链路失效。
  - M1：网页 UI 用 Page Visibility API，`visibilitychange` 时发 `{"t":"screen","on":false}`；打开页面立即上报一次，**可见时每 45s 重报一次**（`reportStaleMs` 默认 10 分钟，服务端把任意上行消息都视为该客户端存活）。
  - 多客户端聚合：**任一报 on 即为 on**；某客户端断开时按剩余集合重算，绝不复用已关闭标签页的最后一次上报。
  - M2：Android 侧订阅 `ACTION_SCREEN_ON/OFF`（零权限）。
  - 兜底方向反过来：**无 WS 客户端 = 无观察者 = 按灭屏**；有客户端但没上报过/上报过期 = 也按灭屏。宁可多省一档，因为 keepalive / health / auto-eat 是红线，降档不会把 bot 弄死。
  - 只想要无头模拟时可把 `power.screen.requireClient` 设为 `false`，这时才使用 `MCBOT_MOCK_POWER` 里的 `screenOn` 提示。
- **无观察者不序列化**：L0 且 `uiClients === 0` 时状态循环直接返回，不再为空 socket 集合做 JSON 序列化；其它档位在没有客户端时也跳过 state 推送。
- **降视距**：只发 `settings` 包（`bot.setSettings({viewDistance:'tiny'})`），让服务器少发区块；**不碰本地 world 数据**。
- **红线**：连接/keepalive、`health` 监听、自动进食不因档位停止。L1 只停日志落盘与推送频率，L0 再降视距/裁聊天/停定时清包。
- **L3 带迟滞**：电量 <10% 立即 `disconnect` 并置 `suspended`，**不进入重连循环**；只有充电或回到 `l3ExitAbove`（默认 20%）才退出，避免 9%↔11% 反复开关射频。电量读数丢失不会解除 latch（丢读数不等于恢复）。
- **去抖是不对称的**：升级（更省电的档位）立即生效，降级才等 10s。掉电/过热/熄屏没有理由再等一个周期。
- **两套停机互不覆盖**：F9 熔断和「食物耗尽 + 低血量」都进入 `halted`，**只有手动「连接/重连」能清除**；L3 进出、充电恢复都不会把停机的 bot 拉起来。停机时 L3 分支也不会改写 `status` 或重设 `desiredOnline`。
- **热约束优先于手动覆盖**：`thermal >= MODERATE` 或系统省电模式时强制 L0，即使用户点了「强制 L2」；此时 UI 会收到一条说明，偏好本身仍被记住，降温后自动回到 L2。

### 与 PRD 字面不一致之处（有意为之，均已在代码注释标注）

1. **L0 并非完全停推**：PRD §4 写“屏幕灭时停推”，但 F2 要求 HUD 可查、§4 红线又要求 health 不停。实测停推会让 UI 在掉线/濒死时全盲，因此 L0 改为 0.05Hz 只推精简状态；**没有客户端时完全不序列化**。
2. **L3 与 F1 的冲突**：F1 要求无限重连，L3 要求主动断开。实现为 L3 期间显式关闭重连，离开 L3 恢复。
3. **充电时不触发 L3**（`l3SkipWhileCharging`，默认开）：24/7 挂机通常插电，5% 就断开没有意义。可关掉。**但热约束不豁免**：充电 + `thermal >= MODERATE` 仍走 L0。长期插电请把系统「充电上限」设到 80%，满电 + 高温持续挂机有电池鼓包风险。
4. **背包丢弃点必须显式启用**（`dropPoint.set=true`）：默认坐标 0,64,0 一旦自动清包会把 bot 走到莫名其妙的地方。未设置且空槽 <3 时只通知、不清理，绝不就地丢。
5. **屏幕状态改由事件上报**（见上），不再"读不到就当亮屏"。这是对原 PRD 的修正，也是本轮评审最重要的一条。
6. **丢弃点安全余量**：预检确认目标是真岩浆/真容器（`chest/trapped_chest/barrel/hopper/dropper/dispenser/潜影盒/工作台/熔炉类`）、附近有安全站立点且可达；**到达后再校验一次**站立点（世界可能已变）。丢的过程中任何掉血立即中断并回原点；容器 `emptySlotCount()===0` 或中途装满立即停手，不会对着满箱子假装丢。
7. **容器 deposit 是真实交互**：`openContainer()` + `container.deposit(type, null, count)`，不是往地上扔。漏斗/箱子/木桶在打开后用 `emptySlotCount()` 判断是否已满（0 即中止），漏斗被红石抽空还是塞住都以这个可观测值为准。v0.1 仍建议优先容器类丢点，比岩浆安全。
8. **食物耗尽分级处理**：先立即告警；当生命 ≤ `eat.disconnectAtHealth`（默认 8，0 关闭）直接停机。普通难度下 bot 不会饿死，但空着肚子会被怪打死，F9 熔断只应作为最后一道线。

## 桥接协议 v1

上行：`state` / `chat` / `inv` / `nav` / `mode` / `log` / `signals`（另有 `hello`、`notify`、`auth`、`status`、`error`、`ack`）。

```jsonc
{"t":"state","hp":20,"food":18,"pos":[100.5,64,-200.25],"yaw":0,"nav":false,"mode":"L1","online":3600,"connected":true}
{"t":"chat","ts":1730000000000,"kind":"chat","from":"Steve","text":"hi"}
{"t":"mode","mode":"L0","forced":null,"signals":{"battery":19,"charging":false,"thermal":0,"screenOn":false,"powerSave":false}}
// 启动自检表（hello 内也有一份）；每次变化推一次
{"t":"signals","signals":{
  "battery":{"source":"sysfs|termux-api","status":"live"},      // | "live(termux-api)" | "unavailable" | "mock"
  "thermal":{"source":"sysfs","status":"unavailable"},
  "screen":{"source":"ui-events","status":"no_client"},          // | "live" | "unknown"
  "powerSave":{"source":"settings","status":"live"}
}}
```

下行：`cmd` / `goto` / `stop` / `eat` / `toss` / `setMode` / `connect` / `config`（`protocol.js` 中逐字段校验，非法输入回 `ack ok=false` 且不影响连接）。

```jsonc
{"t":"goto","x":100,"y":64,"z":-200,"range":2}
{"t":"cmd","text":"/spawn"}
{"t":"setMode","mode":"L2"}          // 或 "auto"
{"t":"toss","mode":"cleanup"}        // 或 {"mode":"stack","slot":36}
```

对冻结协议只做了**新增**，没有改字段：`disconnect`（UI 主动断开）、`waypoint`（P1 挂机点）、`screen`（亮屏事件上报，M1 的 Page Visibility）。`hello` 增加 `protoVersion`（当前为 1）和每个 socket 的 `clientId`（多客户端聚合与断线重算用），M2 的 App 可在握手时检测版本错配；页面与服务端版本不一致会在 UI 顶部提示。消息可带 `id`，服务端回 `{"t":"ack","id":...}`。

```jsonc
{"t":"screen","on":false}            // UI 可见性变化
{"t":"ack","id":9,"ok":true,"dropPoint":{"ok":true,"checked":true,"standing":{"x":11,"y":64,"z":10}}}
```

## 开发与验证

```bash
npm test          # 155 个用例：档位状态机/迟滞/不对称去抖/亮屏权威/信号三态/退避/协议/背包安全/丢弃点预检/重生熔断/桥接端到端
npm run check     # 全量 node --check
MCBOT_MOCK_POWER='{"battery":15,"screenOn":false}' npm start   # 不插真机也能看档位
```

M1 已实测：服务启动、静态页、WS 握手、非法指令拒绝、真实 `createBot` 连不上服务器时的 1→2→4s 指数退避、SIGTERM 干净退出；用 mock 电量跑通的档位链路——15% 去抖 10s 后进 L0、`setMode L2` 立即强制、`setMode auto` 回到 L0；`hello.protoVersion=1` 与 `hello.signals` 自检表；UI 上报 `screen on/off` 后 `signals.screenSource` 依次为 `ui`/`ui`，客户端关闭后回到 `no_client`；第二个浏览器标签上报 `on` 时任一为 on，关掉后剩下集合重算；离线时设置丢弃点返回 `checked:false` 并给出"仅保存未校验"提示。

**尚未验证（必须在真机真服收口）**：微软设备码完整授权与 token 刷新、spawn 后的寻路/背包/容器交互、真实进食、重生与熔断、断网/切网、熄屏降档、功耗与 RSS。逐条步骤见 `docs/real-device-checklist.md`。

## 已知限制 / 未验证项

- **需要真实服务器才能验证的部分**：微软设备码完整授权、spawn 后的坐标/背包/寻路、容器 deposit 的实际窗口交互。沙箱里只验证到连接失败与重连路径。
- **Termux:API 是电量的硬依赖**：sysfs `capacity` 在部分机型不可读，最终要落到 `termux-battery-status`；没装 Termux:API App + 包时电量状态为 `unavailable`，档位停在 L1，UI 会明示。省电模式读取失败同理降级，不影响挂机。
- **温度 zone 编号因 ROM 而异**：代码遍历所有 `thermal_zone*` 取最高温，全部拒读则 `unavailable`（不会把“读不到”当成 NONE）。
- 容器丢点推荐漏斗/箱子/木桶；`dropper/dispenser/工作台/熔炉` 也在允许集合内，但只有打开后 `emptySlotCount()>0` 才会继续 deposit。潜影盒同样支持。
- `RSS < 150MB`、`72h 连续在线`、`待机 <3%/h` 属实测指标，当前环境无法测；`MCBOT_MOCK_POWER` 可让档位逻辑在真机上做 A/B。
- `nodejs-mobile` 打包（M3）未做，M2 继续用 Termux。
- WS 只监听 `127.0.0.1` 且无鉴权；**不要把端口暴露到局域网**。

## 风险对策落地

| 风险 | 现状 |
|---|---|
| 国产 ROM 杀后台 | `termux-start.sh` 申请 wake-lock + 常驻通知；电池白名单仍建议手动加 |
| 长期满电 | **醒目提示**把系统「充电上限」设为 80%；充电 + 高温仍会降到 L0（系统设置本身非应用可控） |
| 1.19+ 签名聊天 | 交给 mineflayer，未自研 |
| AFK 踢人 | `afk.enabled` 可选定时甩头/挥手，默认关闭 |
| Node 版本偏旧 | M1/M2 用 Termux 的 Node 22；M3 再处理 |
