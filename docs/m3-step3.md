# M3 第 3 步：应用内置 Node（已实现，4 条真机验收未验证）

探针（`android/probe`）已经在真机上证明 `libnode.so` 能加载、mineflayer 能在里面连上正版服并 spawn。第 3 步把这套东西搬进正式 App：**不再需要 Termux，也不再需要 `npm start`**。

本文只写这一步改了什么、怎么验证的、还差什么。功耗/发热/长时间后台存活依旧**不在验收内**，也不做任何"更省电"的断言。

---

## 一、边界

**做**：`src/` + `node_modules` + `web/` 打进 `assets/node.zip`；App 启动时解压、在私有进程 `:node` 里起 libnode 跑 `src/index.js`；Node 生命周期跟随前台服务；地址解析的 TCPShield 修复进入正式 bot。

**不做**：不重写协议（`protoVersion` 仍是 1）、不动 M2 已验证的 WebView 外壳与原生信号注入、不动电源分档逻辑（`src/power/`）。M1 的 Termux 用法仍然可用，只是不再是唯一路径。

---

## 二、进程模型

```
主进程 dev.mcbot.console
  MainActivity
    WebView → http://127.0.0.1:8765/          （M1 的页面，原样）
    NativeSignals → window.mcbotNative        （M2 的注入，原样）
  BridgeService（specialUse FGS，常驻通知）
    每 15s GET /api/health
    90s 启动宽限 + 连续 4 次失败 + 60s 冷却 → 重新拉起 NodeService
    最多 10 次，避免"一直崩一直重启"掩盖 bug
        │ startService
        ▼
进程 dev.mcbot.console:node
  NodeService
    NodeBundle.ensure()  assets/node.zip → filesDir/node（按摘要戳判断）
    node::Start → entry.js → src/index.js
      HTTP + WebSocket 127.0.0.1:8765（含 web/ 静态页）
      mineflayer / 档位 / 背包 / 进食 …（M1 代码，原样）
```

为什么分开：nodejs-mobile **一个进程只能起一个 Node，且不能重启**。同进程跑的话，bot 一崩就等于整个 App 一起崩；分开后崩的只是 `:node`，主进程的 FGS 把新进程拉起来，页面靠 M1 已有的 WS 重连自愈，UI 不需要知道发生过什么。

只有**一个**前台服务：`:node` 里的服务是普通后台服务，靠主进程的 FGS 保持应用前台状态，避免两条常驻通知。

---

## 三、对应交接的四条要求

### A. 握手修复进入正式 bot

探针里的 v10 修复不会自动出现在 `src/index.js`，所以解析逻辑抽成了 `src/util/resolve.js`，由 `BotManager` 在 `connect()` 时调用：

| 环节 | 行为 |
|---|---|
| SRV | 端口 25565 且地址是域名时才查；系统 `dns.resolveSrv` → Cloudflare DoH → Google DoH（c-ares 在 Android 上不可靠） |
| A 记录 | `dns.lookup`（getaddrinfo/libc，Android 可用），优先 IPv4，失败再试默认 family |
| **握手** | `options.host` **永远是用户输入的域名**；只有 `options.connect` 里 `net.connect(target.port, target.address)` 拨解析结果 |
| 覆盖 tcp_dns | 自己提供 `connect` 后 mineflayer/minecraft-protocol 的 `tcp_dns` 直接让路，不会再拿 SRV 目标覆盖 `options.host` |
| 可见性 | 日志一行：`resolved mcfallout.net:25565 -> srv jp.mcfallout.net:25565 (system) -> 172.65.211.204:25565` |
| 失败 | 解析失败 → `lastError` + 页面上行 `warn` + 走退避重连，不会挂在"connecting" |

回归（沙箱，2026-11-15 22:33，Node 22 + 同一套依赖）：

```
resolved mcfallout.net:25565 -> srv jp.mcfallout.net:25565 (system) -> 172.65.211.204:25565
ping: {"name":"BungeeCord 1.8.x-26.x","protocol":775} players 827
offline 登录 → kicked: "Not authenticated with Minecraft.net"     ← 正版服正常拒绝
```

关键是**最后一个 kick 不是 `Invalid hostname`**，而是正版服的认证拒绝：说明 TCPShield 认可了握手里的域名，路由正确。修复前同一路径表现为 `Unknown #389 · protocol 389` + `Invalid hostname`。

### B. Node 放独立进程 `:node`

见上。`NodeService` 在 `:node`，`BridgeService` + WebView 在主进程，两者只通过 127.0.0.1 的 WS 通信，协议零改动。

### C. token 迁移：不做跨包名搬迁

探针（`dev.mcbot.console.probe`）与正式 App（`dev.mcbot.console`）是不同的应用数据目录，`filesDir` 互相读不到，**探针里那个 `Xieh.` 缓存搬不过来**。正式 App 首次启动需要重新登录一次（设备码，约一分钟），这是可接受的成本，不为它造导出/导入机制。

正式 App **内部**跨版本升级要稳：

| 路径 | 内容 | 升级覆盖安装时 |
|---|---|---|
| `filesDir/node/` | 解压后的 bundle（`entry.js` + `src/` + `web/` + `node_modules/`） | **会被删掉重建**（`node.zip` 的 SHA-256 变了就重解压） |
| `filesDir/config.json` | 服务器/玩家名/档位配置 | 保留 |
| `filesDir/logs/` | `bot-*.log`、`power-*.jsonl`、`node-boot.log`、`crash.log` | 保留 |
| `filesDir/auth/` | 微软 token 缓存（`prismarine-auth` 的 `profilesFolder`） | 保留 |

`entry.js` 把 `filesDir` 通过 argv 交给 Node，`src/index.js` 认 `MCBOT_STATE_DIR`；`profilesFolder` 会被钉到 `filesDir/auth`（默认的 `./.auth` 会按 CWD 解析，Android 上的 CWD 是 `/`）。

### D. node 包只解压一份 + 版本戳

- App 的 APK 里 **一个** `lib/arm64-v8a/libnode.so`（62,475,584 B）+ **一个** `assets/node.zip`（15,439,175 B），已用 `unzip -l` 核对。探针 APK 是另一个独立 APK，二者不会被合并进同一个包。
- 解压目录带 `.bundle-ok` 戳，内容是 `node.zip` 的 SHA-256 前 16 位：只有 bundle 变了才重解压，否则每次启动不做 145 MB 的无用 IO。
- ABI 只有 `arm64-v8a`；要跑模拟器才加 `x86_64`（APK 直接翻倍）。
- `libnode.so` 的下载放在 `android/libnode.gradle.kts`，`:app` 与 `:probe` 共用，避免两边 Node 版本/ABI 漂移。

---

## 四、体积与构建

| 项 | 数值 | 怎么得到 |
|---|---|---|
| App bundle（解压后） | **145 MB / 6295 个文件** | `:app:bundleNode` |
| `assets/node.zip` | **15,439,175 B** | `:app:nodeAsset` |
| debug APK | **80,025,110 B** | `:app:assembleDebug` |
| 其中 `libnode.so` | 62,475,584 B | nodejs-mobile v18.20.4，arm64 |

构建期校验（沿用探针那套，改由 `bundle-node.sh` 的 `app` 模式调用）：`npm ci` → 按 `dataPaths` 裁剪 `minecraft-data`（保留全部 `pc/*` + 两个 `common`）→ 对 66 个可玩版本逐个编译 serializer → `require('mineflayer')` → 再拷 `src/`、`web/`、`entry.js`。任何一步失败在 CI/本机就炸，不会到手机上才炸。

CI（`.github/workflows/android-build.yml`）的 `apk` job 现在也装 `ndk;27.0.12077973` 与 `cmake;3.22.1`，构建时间与产物都变大（APK ~80 MB，上传仍是 14 天）。

---

## 五、验收（4 条，全部未验证）

设备侧判定，按顺序做。**编译通过不等于能用**，这 4 条要装到手机上才算数。

| # | 场景 | 判定方式 | 状态 |
|---|---|---|---|
| 1 | 无 Termux 冷启动 | 强制停止 App → 打开 → 不装 Termux、不跑 `npm start`，页面应在 1–3 分钟内进入可操作状态；填 `mcfallout.net` / 邮箱 / 勾微软登录 → `connect.ok=true, detail="spawned"`（端口 8765 的 `/api/health`、页面 HUD 的 `online`） | 未验证 |
| 2 | 锁屏 30 分钟不掉线 | 熄屏 30 分钟后回到 App：HUD 仍 `online`、`onlineSince` 连续；`/api/health` 的 `clients` 恢复 ≥1；期间无重连日志 | 未验证 |
| 3 | 手动杀 `:node` 自愈 | `adb shell ps -A \| grep mcbot` 找 `:node` pid → `adb shell kill <pid>` → 60–120 s 内 `/api/health` 恢复响应，`files/logs/node-boot.log` 出现第二次 `bundle ready`；页面自动回 `online` | 未验证 |
| 4 | 覆盖安装 token 不丢 | `adb install -r` 新 APK（bundle 摘要变化会重解压）→ 打开 App，登录卡片显示 `已登录：<名字>`，不弹设备码 | 未验证 |

调试入口（都是文件，nodejs-mobile 的 stdout 不进 logcat）：

```bash
adb forward tcp:8765 tcp:8765
curl -s 127.0.0.1:8765/api/health
adb shell run-as dev.mcbot.console cat files/logs/node-boot.log
adb shell run-as dev.mcbot.console cat files/logs/crash.log
```

---

## 六、已知限制 / 风险

- **Node 18 已 EOL**（nodejs-mobile 只有 v18.20.4），mineflayer 声明 `>=22`。实测可用，但上游任何一次升级都可能踩 18 不支持的语法/API。要长期用必须锁 `package-lock.json` 并冻结升级。
- **挂住但不退出的 Node 不会被强杀。** 主进程没有安全的跨进程 kill API；`NodeService` 只在 Node 退出时自杀，看门狗负责拉起"进程已经没了"的情况。若 Node 活着但 HTTP 不响应，表现为页面离线 + 看门狗计数，不会无限重启（10 次上限）。
- **首次启动慢**：解压 145 MB 后才能起 Node，页面会显示"正在启动内置 Node 核心…（n/120）"。
- **APK ~80 MB**：libnode.so 占 62 MB，无法回避（除非改方案）。
- **两个进程的内存都在**：主进程（WebView）+ `:node`（Node + mineflayer）。低内存机型上 `:node` 更容易被回收，靠看门狗自愈。
- **Doze / OEM 杀后台**：FGS + 电池优化白名单是唯一手段，已在应用内引导；HyperOS 的自启动/后台弹出权限仍需手动给。
- **功耗增量仍未测量**：本步没有做任何省电优化，也没有 A/B 数据。`<0.5%/h` 依旧是假设。

---

## 七、本地怎么复跑

```bash
npm test                                   # 183 个测试（含 12 个地址解析用例）
cd android && ./gradlew :app:bundleNode     # 只验证 bundle（不下载 libnode）
./gradlew :app:assembleDebug                # 出 APK（首次会下载 libnode ~100 MB）
./gradlew :probe:assembleDebug              # 探针仍可单独构建
```

bundle 的快速自检（不需要手机）：解压 `assets/node.zip` 后

```bash
node entry.js /tmp/state        # 然后用 curl 127.0.0.1:8765/api/health
```
