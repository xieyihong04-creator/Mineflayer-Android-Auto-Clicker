# Mineflayer Android Console · v0.1（M1）

Android 上的 Minecraft Java 挂机 bot 控制台。内核 mineflayer。M1 交付 **Termux 直接跑 Node 服务 + localhost WebSocket + 网页 UI**；M2 是**原生 WebView 外壳 + 前台服务 + 原生信号桥**（不做 Compose）；M3 把 nodejs-mobile 打包进 App——**装上 APK 就能挂机，不再需要 Termux**。

> 项目已从 `mineflayer-android-auto-clicker` 更名为 **mineflayer-android-console**：本项目不做任何输入自动化 / 点击器，"auto-clicker" 会误导。GitHub 仓库名需在网页端同步改名（远端仓库改名不改历史）。

```
Android 外壳 (M2) ──┐   WebView 加载 127.0.0.1:<port>
                    │   + specialUse 前台服务保活
                    │   + ACTION_SCREEN_ON/OFF、getCurrentThermalStatus()
网页 UI (M1) ───────┤   isPowerSaveMode() 经 window.mcbotNative 注入
                    │  WebSocket / JSON (localhost, protocol v1)
                    └─ Node: mineflayer + pathfinder + 功耗调度 + 背包/进食
```

## 快速开始（装 APK，M3）

安装 `app-debug.apk`（arm64）→ 打开 → App 自己解压内置 Node 并在 `:node` 进程启动核心 → 页面加载 `127.0.0.1:8765` → 填服务器地址、账号邮箱、勾「使用微软登录」→ 连接。

首次启动要解压约 145 MB 的运行时与版本数据，页面会显示「正在启动内置 Node 核心…（n/120）」。微软登录会弹设备码，授权一次后 token 存在 `filesDir/auth`，升级覆盖安装不丢；探针 APK（另一个包名）里的缓存不会带过来。细节、进程模型与 4 条真机验收见 [`docs/m3-step3.md`](docs/m3-step3.md)。

## 快速开始（Termux，M1 路径仍然可用）

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
src/util/resolve.js     SRV + A 解析（系统 → DoH），握手保留用户输入的域名
src/bot/nav.js          F4 简单寻路（禁挖/禁跑酷/禁自由移动/禁搭方块）
src/bot/eating.js       F5 自动进食（白名单 + 黑名单，耗尽通知）
src/bot/inventory.js    F6 到点清包（串行 300ms、容器 deposit 或岩浆丢）
src/bot/chat.js         F3 最近 200 条（L0 裁到 50）
src/power/tier.js       F7 档位状态机 + 10s 去抖 + L3 迟滞 + 手动覆盖
src/power/screen.js     亮屏权威来源：UI 事件上报，未知/无观察者一律按灭屏
src/power/sources.js    Termux 下的电量/充电/温度/省电信号（sysfs + termux-api，不依赖 dumpsys）
src/bot/respawn.js      F9 自动重生 + 回挂机点 + 连续死亡熔断
src/bot/droppoint.js    丢弃点站立安全 + 可达性预检
src/bridge/protocol.js  协议 v1 校验与上行构造
src/bridge/server.js    WS + 静态页面 + 指令分发
web/                    移动端网页控制台（无构建、无外部依赖）
android/                M2 外壳 + M3 第 3 步：WebView + specialUse FGS + 原生信号桥
android/app/            NodeService(:node 进程) / NodeBundle / libnode JNI 壳
android/libnode.gradle.kts  :app 与 :probe 共用的 libnode.so 下载（版本/ABI 单一来源）
android/probe/          M3 探针：libnode + JNI 最小工程，独立 APK，不进正式包
docs/                   真机验收清单（m3-probe.md / m3-step3.md）
test/                   183 个 node:test 用例
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

## M2 外壳（源码已入仓，未在设备上验证）

### 前置声明（先看这一段，别把下面当成已达成）

- **功耗增量仍未测量。** `<0.5%/h` 是**假设**，不是结论；M1 时只有一次「边打字边看屏」的单帧读数（6.8%/h），不能当 idle 值用。
- **F7 留在 Node，不迁移。** 档位状态机、去抖、迟滞都在 `src/power/`，外壳只送信号。
- **"原生比 Node 省电"未经证明。** 没有任何 A/B 数据，M2 也不打算用这个当卖点。
- **被动功耗日志保持默认开启**（`logs/power-<day>.jsonl`），不要求用户做 A/B；只有测量时才用 `MCBOT_POWER_TELEMETRY=0` 关掉，保证单采样源。
- **`android/` 能编出 debug APK，但没有在设备上跑过。** 本轮在沙箱里装了 `cmdline-tools` + `platforms;android-35` + `build-tools;35.0.0`，`./gradlew assembleDebug` 已本地跑绿（`clean` 后重编同样绿），并用 `aapt2` 核对过 `foregroundServiceType=specialUse` 与 `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` 真的进了清单。**编译通过 ≠ 运行正确**：M2 的五条验收仍全部处于"未验证"，等 APK 装上真机。

### 架构

WebView 外壳加载 `http://127.0.0.1:<port>`（默认 8765，可用 `--es port 18770` 覆盖），不重写 UI、不做 Compose。前台服务只负责保活；原生值通过 `window.mcbotNative` 注入页面，再走已有的 WS 上行，因此协议和档位逻辑都不需要分叉。

| 项 | 做法 | 理由 |
|---|---|---|
| A1 保活 | `foregroundServiceType="specialUse"` + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` | `dataSync` 在 Android 15 有 6h/24h 配额，会把夜间挂机悄悄掐断 |
| A2 权限 | Android 13+ 请求 `POST_NOTIFICATIONS`；首次启动申请电池优化白名单 | 没有通知权限时 FGS 照跑但通知不显示，用户会以为已死 |
| A3 HyperOS | 应用内指引：Termux 与 **Termux:API** 两个包都要「无限制 + 自启动」 | 只设 Termux 时 `termux-battery-status` 会被冻结，表现为信号掉线 |
| A4 亮屏权威 | `ACTION_SCREEN_ON/OFF`（零权限）→ `window.mcbotNative.screen(on)`；Page Visibility 降为兜底 | 熄屏后 WebView 的 `visibilitychange` 不可靠，而 M1 的权威完全依赖它 |
| A5 自愈 | `hello.protoVersion` 预检 + 页面已有重连 | 版本错配时给出"更新代码后重启 npm start"，而不是白屏 |
| P1 温度 | `PowerManager.getCurrentThermalStatus()` → 上行 `thermal` | 主判据；sysfs 基线差值降为 fallback |
| P1 省电 | `PowerManager.isPowerSaveMode()` → 上行 `powerSave` | 补上第五行信号（`settings get global low_power` 在本机读不到） |

原生值 5 分钟没有刷新就视为过期、自动回落 sysfs/settings，避免外壳被杀后把档位永久钉在 L0。外壳每 60s 重发一次不变的 `thermal`/`powerSave` 作为存活证明。

### 协议：仅新增

`thermal`（`value` 为 0–6 整数，对应 `THERMAL_STATUS_*`）与 `powerSave`（`on` 为布尔）两条上行，**没有改动任何既有字段，`protoVersion` 保持 1**。老页面不发这两条消息时行为与 M1 完全一致。

### 验收（全部未验证，功耗不在其中）

| 项 | 判定方式 | 状态 |
|---|---|---|
| APK 可构建 | `./gradlew :app:assembleDebug`（本地与 CI 同一 wrapper） | **已绿**（构建产物 2.0 MB，minSdk 26 / target 35） |
| APK 可安装 | `adb install` + 首次启动 | 未验证 |
| FGS 在 HyperOS 存活 ≥2h | 熄屏 2h 后 `curl -s 127.0.0.1:8765/api/health` 仍有响应 | 未验证 |
| 亮屏信号来自原生广播 | 熄屏后 `signals.screen.status` 仍为 `live`、`screenSource` 为 native | 未验证 |
| `thermal`/`powerSave` 从 unavailable → live | `/api/health` 的 `power.thermalNative`、`powerSaveNative` 非 null | 未验证 |
| WS 自愈 | 杀进程/断网后页面自动回到 `online` | 未验证 |

M2 **不以功耗为验收项**；169 个测试通过只证明 Node 侧契约没坏，**不是省电证据**。

### CI

`.github/workflows/android-build.yml`：push 到本分支 / PR 时用 JDK 17 + 仓库内 gradlew 构建 `assembleDebug`，显式安装 `platforms;android-35`，产物上传为 `mcbot-android-debug`（14 天）。lint 只报告不阻塞。

APK 本身不入库（`.gitignore` 排除 `*.apk` 与 `android/**/build/`）；`dist/` 里放的是**手动打好的 zip 快照**，内含 `app-debug.apk` 与 `BUILD.txt`（commit、CI run、工具链、APK 的 sha256），方便不入 GitHub 的场合直接取用。它是二进制快照，不是每次构建自动更新，用前先看 `BUILD.txt` 对不对得上当前代码。

## M3：nodejs-mobile（探针门已过，第 3 步已实现，4 条真机验收未验证）

**真机结论（2026-11-15 22:06，探针 v10）**：`libnode.so` 在 arm64 Android 上能加载、执行 JS、开 127.0.0.1 端口、写文件；mineflayer 4.39.0 能在 nodejs-mobile 里 require 成功并**连上正版服 spawn**（版本 26.1、坐标 -137.6/35/912.2、2975 ms）。所以第 3 步的禁止条款解除。

**第 3 步做了什么**：`src/` + `node_modules` + `web/` 打成 `assets/node.zip`（解压 145 MB，zip 15.4 MB），Node 跑在私有进程 `:node`，WebView + specialUse 前台服务留在主进程；主进程每 15 s 探一次 `/api/health`，`:node` 的 Node 退出后自杀进程、看门狗拉起新进程（nodejs-mobile 一个进程只能起一次 Node，重启只能换进程），页面用 M1 已有的 WS 重连自愈。APK 80 MB（libnode.so 独占 62 MB），arm64 单 ABI。

**地址解析进入正式 bot**：`src/util/resolve.js` 自己做 SRV（系统 → Cloudflare DoH → Google DoH）+ A（`dns.lookup`），并且**握手包保留用户输入的域名**，只有 socket 连解析出的 IP。TCPShield/NeoProtect 这类按 hostname 路由的代理，收到 IP 会回 `Invalid hostname` 并伪造一个 `protocol 389` 的状态——这正是探针早期 1.13-pre7 报错和 `Invalid hostname` 被踢的根因。回归实测：`mcfallout.net` → `jp.mcfallout.net:25565` → BungeeCord protocol **775**，offline 登录被"正版服认证拒绝"而不是被代理拒绝。

**仍未验证**：装 APK 后的 4 条（无 Termux 冷启动并 spawn、锁屏 30 分钟不掉线、杀 `:node` 自愈、覆盖安装 token 不丢）。**功耗/发热/后台存活时长既不在验收内，也没有任何测量数据。** 细节与风险见 [`docs/m3-step3.md`](docs/m3-step3.md)；探针本身的过程记录（六次真机运行、打包裁剪的三个坑）见 [`docs/m3-probe.md`](docs/m3-probe.md)。

## 功耗分级实现细节

- **信号来源**：`termux-battery-status` 为主（本机 sysfs 被 SELinux 拒）、`thermal_zone*/type+temp` 按白名单选、`settings get global low_power`。桌面或测试可用 `MCBOT_MOCK_POWER='{"battery":18,"screenOn":false}'` 模拟。
- **实测硬件档案（Xiaomi 2509FPN0BC / Android 17 / SDK 37，已冻结，不再猜测）**：
  - `/sys/class/power_supply` 对普通 uid 是 **EACCES（SELinux，无 root 永久不可用）**，所以电量走 `termux-battery-status`（需要 Termux:API **App**，不只是 `pkg install termux-api`）。
  - 电量返回里 `plugged` 与 `status` 是两个独立字段；**放电时 `current` 为正**，符号约定不可靠，因此功率取 `|V*I|`。
  - 温度 96 个 zone，只有 `quiet_therm`（机身）/`battery`、`batt_temp`（电芯）/`charger_therm` 有意义；`cpu-hw-trip-*`（95000 是跳闸阈值）、`vbat`（电压）、`*-bcl-lvl*`、`*-ibat-lvl*`、`-273000`（离线哨兵）必须排除。
  - 待机机身 42.9–44.2 °C、电芯 37.5–38.0 °C —— 绝对阈值会让 bot 永久卡 L0。
- **每个外部信号都有第三态，且不会静默等于正常值**：
  - 电量：sysfs 与 `termux-battery-status` 都失败 → `null`，档位按 **L1** 处理（不是“100%”也不会自动 L2）；UI 顶部弹告警。
  - 电量节点名各 ROM 不同（`battery`/`BATTERY`/`bms`/`BAT0`…）：先扫 `/sys/class/power_supply/*/type == Battery`，再退回固定候选目录。
  - **充电是独立一行**，判定用 `plugged` + `status` 双字段（**不用电流符号**）；两字段冲突时按“未充电”处理（安全侧：低电量照样 L3 断开）。读不到时为 `null`（UI 显示「未知」）。
  - `termux-battery-status` 依赖 **Termux:API App + `pkg install termux-api`**，是硬依赖；未安装时降级为 `unavailable` 而不是假装有读数。
  - 温度：按 `type` 运行时解析白名单（**禁止硬编码 zone 编号**，跨 ROM/重启不稳定），选中的 zone 读不到 → `null`，温度降档不触发，UI 明示。
  - **温度阈值是 baseline 相对增量**：启动后 `baselineWindowMs`（默认 3 分钟）内取中位数作为基线，超过 `l0DeltaC`（默认 7 °C）才进 L0。基线未就绪时 `thermalDelta=null`，**不会**降档（自检表标 `baseline: pending`）。
  - **失败原因进状态字符串**：`unavailable(selinux)` / `unavailable(no-bridge)` / `unavailable(no-zone)`，另有 `battery.bridge` 字段单独标桥的状态；`live(termux-api)` 表示走的 API 而不是 sysfs。不是笼统的 `unavailable`，因为「SELinux 永久拒绝」和「Termux:API 没装」是两种完全不同的处置。
  - 启动自检表随 `hello.signals` 下发，运行中有变化再推 `{"t":"signals"}`；同一张表也在 `GET /api/health` 里，附带 `power`（原始值 + 功率遥测），真机核对不用截图：`curl -s localhost:8765/api/health`。
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
- **热约束优先于手动覆盖**：机身温度高出基线 `l0DeltaC` 或系统省电模式时强制 L0，即使用户点了「强制 L2」；此时 UI 会收到一条说明，偏好本身仍被记住，降温后自动回到 L2。

### 与 PRD 字面不一致之处（有意为之，均已在代码注释标注）

1. **L0 并非完全停推**：PRD §4 写“屏幕灭时停推”，但 F2 要求 HUD 可查、§4 红线又要求 health 不停。实测停推会让 UI 在掉线/濒死时全盲，因此 L0 改为 0.05Hz 只推精简状态；**没有客户端时完全不序列化**。
2. **L3 与 F1 的冲突**：F1 要求无限重连，L3 要求主动断开。实现为 L3 期间显式关闭重连，离开 L3 恢复。
3. **充电时不触发 L3**（`l3SkipWhileCharging`，默认开）：24/7 挂机通常插电，5% 就断开没有意义。可关掉。**但热约束不豁免**：充电 + 高出基线 7 °C 仍走 L0。长期插电请把系统「充电上限」设到 80%，满电 + 高温持续挂机有电池鼓包风险。
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
  "battery":{"source":"sysfs|termux-api","status":"live(termux-api)",
             "bridge":null},                                     // | "unavailable(selinux)" | "unavailable(no-bridge)" | "mock"
  "charging":{"source":"sysfs|termux-api","status":"live(termux-api)"},
  "thermal":{"source":"sysfs","status":"live",
             "baseline":"ready","zone":"quiet_therm","native":null}, // M2 原生时 source=android-native, native=0..6
  "screen":{"source":"ui-events","status":"no_client"},          // | "live" | "unknown"
  "powerSave":{"source":"settings","status":"live"}              // 读不到 -> "unavailable"，按未开启处理；M2 原生时 source=android-native
}}
```

下行：`cmd` / `goto` / `stop` / `eat` / `toss` / `setMode` / `connect` / `config`（`protocol.js` 中逐字段校验，非法输入回 `ack ok=false` 且不影响连接）。

```jsonc
{"t":"goto","x":100,"y":64,"z":-200,"range":2}
{"t":"cmd","text":"/spawn"}
{"t":"setMode","mode":"L2"}          // 或 "auto"
{"t":"toss","mode":"cleanup"}        // 或 {"mode":"stack","slot":36}
```

对冻结协议只做了**新增**，没有改字段：`disconnect`（UI 主动断开）、`waypoint`（P1 挂机点）、`screen`（亮屏事件上报，M1 的 Page Visibility）、`thermal` / `powerSave`（M2 外壳的原生值）。`hello` 增加 `protoVersion`（当前为 1）和每个 socket 的 `clientId`（多客户端聚合与断线重算用），M2 的 App 可在握手时检测版本错配；页面与服务端版本不一致会在 UI 顶部提示。消息可带 `id`，服务端回 `{"t":"ack","id":...}`。

```jsonc
{"t":"screen","on":false}            // UI 可见性变化（M2 由 ACTION_SCREEN_ON/OFF 驱动）
{"t":"thermal","value":2}            // PowerManager 热状态 0-6，MODERATE(2) 起强制 L0
{"t":"powerSave","on":true}          // isPowerSaveMode()
{"t":"ack","id":9,"ok":true,"dropPoint":{"ok":true,"checked":true,"standing":{"x":11,"y":64,"z":10}}}
```

## 开发与验证

```bash
npm test          # 169 个用例：档位状态机/迟滞/不对称去抖/亮屏权威/信号三态/白名单温度/基线增量/退避/协议/背包安全/丢弃点预检/重生熔断/桥接端到端
npm run check     # 全量 node --check
MCBOT_MOCK_POWER='{"battery":15,"screenOn":false}' npm start   # 不插真机也能看档位
MCBOT_DEBUG_PROTOCOL=1 npm start                               # 协议层追踪（默认关，很吵）

# 真机（Termux）：两次 30 分钟，同一探针、同一熄屏条件，分别产出 report.txt
bash scripts/ondevice-once.sh --baseline   # 不跑 bot（减数）
bash scripts/ondevice-once.sh              # 登录后熄屏（被减数），自动配对最近一次 baseline
# 只读诊断（不起 bot）：Termux:API / power_supply / thermal 白名单一次打全
bash scripts/termux-signal-probe.sh 18770
```

M1 已实测：服务启动、静态页、WS 握手、非法指令拒绝、真实 `createBot` 连不上服务器时的 1→2→4s 指数退避、SIGTERM 干净退出；用 mock 电量跑通的档位链路——15% 去抖 10s 后进 L0、`setMode L2` 立即强制、`setMode auto` 回到 L0；`hello.protoVersion=1` 与 `hello.signals` 自检表；UI 上报 `screen on/off` 后 `signals.screenSource` 依次为 `ui`/`ui`，客户端关闭后回到 `no_client`；第二个浏览器标签上报 `on` 时任一为 on，关掉后剩下集合重算；离线时设置丢弃点返回 `checked:false` 并给出"仅保存未校验"提示。

**尚未验证（必须在真机真服收口）**：微软设备码完整授权与 token 刷新、spawn 后的寻路/背包/容器交互、真实进食、重生与熔断、断网/切网、熄屏降档、功耗与 RSS。逐条步骤见 `docs/real-device-checklist.md`。

## 已知限制 / 未验证项

- **需要真实服务器才能验证的部分**：微软设备码完整授权、spawn 后的坐标/背包/寻路、容器 deposit 的实际窗口交互。沙箱里只验证到连接失败与重连路径。
- **Termux:API 是电量的硬依赖**：sysfs `capacity` 在部分机型不可读，最终要落到 `termux-battery-status`；没装 Termux:API App + 包时电量状态为 `unavailable`，档位停在 L1，UI 会明示。省电模式读取失败同理降级，不影响挂机。
- **温度按 `type` 取白名单 zone**（`quiet_therm`/`battery`/`batt_temp`/`charger_therm`），不按编号、不取全局限最高温：`cpu-hw-trip-*` 的 95000 和 `vbat` 的 4017 都是“看起来像温度”的陷阱。白名单全落空则 `unavailable(no-zone)`，不会把“读不到”当成 NONE=0。
- 容器丢点推荐漏斗/箱子/木桶；`dropper/dispenser/工作台/熔炉` 也在允许集合内，但只有打开后 `emptySlotCount()>0` 才会继续 deposit。潜影盒同样支持。
- **功耗目标改为 `<0.5%/h` 的“增量”（假设，未测量）**：本机满容量约 7100 mAh / 27.4 Wh，PRD 的 3%/h = 0.82 W 比整机熄屏 baseline 还高，达标没有意义，所以换成增量 ≈0.14 W。增量 = 开 bot 的 30 分钟功率中位数 − 同条件熄屏 baseline 中位数。**目前一个数都没测，任何“已达标”的说法都不成立。**
- `RSS < 150MB`、`72h 连续在线` 仍属实测指标，当前环境无法测；`MCBOT_MOCK_POWER` 可让档位逻辑在真机上做 A/B。
- **功率/cycle/满容量估算只进 jsonl 日志**（`logs/power-<day>.jsonl`，L0 也照写），不做界面：`DEBUG` 与遥测都不该占用 UI。
- **测量时只能有一个采样源**：bot 内部是 10 s 一条，脚本探针是 60 s 一条；两者同时跑就是 7 次/分 vs 1 次/分，差值里会混进探针本身的开销。所以 `MCBOT_POWER_TELEMETRY=0` 关掉内部日志，`ondevice-once.sh` 启动 bot 时默认带上它，两种模式都只剩脚本的 1 次/分。
- `fullMah` 外推只在 **30–80% 且稳定放电**时记录，充电中/低电量/字段冲突一律 `null`：`charge_counter` 的线性外推在这些区间误差会被放大，会污染容量趋势。
- `nodejs-mobile` 已在真机上证明能连能 spawn（探针 v10），第 3 步也已把 Node 放进 App 的 `:node` 进程；但**应用内自启/锁屏 30 分钟/杀进程自愈/覆盖安装不丢 token 四条仍未验证**。Node 18 已 EOL、mineflayer 声明 `>=22`，实测可用但升级必须锁 `package-lock.json`。
- **挂住但不退出的 Node 不会被强杀**：主进程没有安全的跨进程 kill API，看门狗只能处理"进程已经没了"。表现为页面离线，不会无限重启（上限 10 次）。
- WS 只监听 `127.0.0.1` 且无鉴权；**不要把端口暴露到局域网**。

## 风险对策落地

| 风险 | 现状 |
|---|---|
| 国产 ROM 杀后台 | `termux-start.sh` 申请 wake-lock + 常驻通知；电池白名单仍建议手动加 |
| 长期满电 | **醒目提示**把系统「充电上限」设为 80%；充电 + 高温仍会降到 L0（系统设置本身非应用可控） |
| 1.19+ 签名聊天 | 交给 mineflayer，未自研 |
| AFK 踢人 | `afk.enabled` 可选定时甩头/挥手，默认关闭 |
| Node 版本偏旧 | M1/M2 用 Termux 的 Node 22；M3 再处理 |
