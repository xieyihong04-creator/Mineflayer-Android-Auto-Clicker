# M3 探针：nodejs-mobile 可行性

交接单里"现在可并行做"的两项。**结论先写：门还没过。** 探针证明的是"同一份代码在 Node 18.20.4 上能连上服务器、APK 能构建"，**没有**证明"libnode.so 在 Android 上起得来并连上"——后者需要真机，本沙箱没有。

## 一、实测事实（2026-11-15，均可复现）

| 项 | 结果 | 怎么得到的 |
|---|---|---|
| nodejs-mobile 最新版 | **v18.20.4**，2024-10-07 发布 | GitHub releases |
| 内置 Node | **18.20.4**（Node 官方已于 2025-04-30 EOL，不再有安全更新） | 发布说明 |
| 支持的 ABI | `armeabi-v7a`、`arm64-v8a`、`x86_64`（`x86` 已停） | 发布 zip |
| 产物形态 | **不是 AAR**：zip 里是 `bin/<abi>/libnode.so` + `include/node/*.h`，要自己写 JNI 壳调 `node::Start` | 官方 Android 指南 |
| 编译用 NDK | **r24** | `readelf -p .note.android.ident libnode.so` |
| ELF 段对齐 | **0x1000（4 KB）**，不是 16 KB | `readelf -lW libnode.so` |
| 运行时限制 | **一个进程只能有一个 Node 实例，且不支持重启** | 官方指南明确写死 |
| mineflayer 声明要求 | `engines: node >= 22` | `npm view mineflayer engines` |
| mineflayer 实测（Node 18.20.4） | **能连上并 spawn**，1.20.1 正版服务端，905 ms | 本机 `probe3.js` |
| 依赖树原生模块 | **0 个**（无 `*.node`、无 `binding.gyp`、无 `gypfile`） | 遍历 98 个包 |
| `minecraft-data` 体积 | **895 MB**（PC 499 + Bedrock 395） | `du -sh` |
| 保留（全部 `pc/*` + 两个 `common`，其余 bedrock 删除） | **130 MB** | 同上 |
| 完整 node 包（含 node_modules） | **130 MB / 7042 个文件** | `bundle-node.sh` |
| 打进 APK 的 `node.zip` | **15.4 MB**（数据是 JSON，压缩率约 8:1） | Gradle `nodeAsset` |
| 探针 APK（arm64 单 ABI） | **79.9 MB**（其中 libnode.so 62.4 MB） | `:probe:assembleDebug` |

## 二、探针怎么用

装上打开就行，不需要 adb：App 解压 node 包 → 启动 libnode → **自己加载 `http://127.0.0.1:3999/`** 那个页面。页面本身就是操作界面：

- **连接目标**：服务器地址、端口、玩家名、`使用微软登录` 勾选框，点“连接”。地址会被记住，改目标时上一次还在进行的连接会被取消（45 s 超时的那次不会挡住新的一次）。地址框下面直接印出手机自己的局域网地址，方便对照——填 `127.0.0.1` 一定连不上。
- **判定卡**：`未测试` / `通过 · 已连接并 spawn`（带版本与坐标）/ `未通过`（原样错误 + 一句建议，例如 ECONNREFUSED 提示“别填 127.0.0.1，那是手机自己”）。
- **步骤**：逐条 ✓/✗，带各自耗时；`原始 JSON` 折叠在下面。
- **运行环境**：node / 平台 / v8 / uv。
- 勾了微软登录会多出一块设备码卡片（链接 + 代码）。

### 微软登录（持久化）

- **token 缓存放在 `files/auth`**，不在解压出来的 `files/node` 里——后者会因 `node.zip` 变更被整个删除，早先那样放会导致每次更新 APK 都要重新登录。
- **“玩家名”填账号邮箱**（`you@outlook.com`）。填了 `Probe` 这类名字会立刻在页面上被挡下来，而不是连了几分钟才报错。
- 第一次登录：页面出现设备码 + `microsoft.com/link` 链接，点链接用真实浏览器打开（127.0.0.1 以外的 URL 交给系统浏览器，不在 WebView 里跳）。授权完成后自动继续连接。**设备码等待期是 10 分钟**，不会被连接用的 45 s 超时打断；只有客户端真的连上服务器之后才开始算 45 s。
- 之后启动：读到缓存就**静默刷新**，不再要设备码；卡片显示 `已登录：<名字>` 与「清除登录缓存」（`/logout`，换账号用）。
- 没有缓存时**不会**一开 App 就弹设备码，等你点「连接」。
- 目标（host/port/玩家名/是否登录）同时写入 `files/probe-state.json`，重启 App 后自动填回。
- 只有 AADSTS / invalid_grant / 401/403 / Xbox / 设备码超时这类错误才算「登录失败」。`ECONNREFUSED`、`timeout`、`kicked` 属于连接问题，卡片仍显示 `已登录`——早先版本把这些统统写成「登录失败」，会误导人去反复重登。

升级安装会自动换掉页面：App 用 `assets/node.zip` 的 SHA-256 决定要不要重新解压（早期版本只写了个固定的 `.bundle-ok`，于是装了新 APK 仍在跑旧的 `files/node/probe.js`，界面看起来"没变"）。WebView 同时设为 `LOAD_NO_CACHE`，并在 targetSdk 35 的 edge-to-edge 下给系统栏留出内边距。

必须记住：**`127.0.0.1` 是手机自己**。要连 PC 上的服务端就填局域网 IP（`ipconfig` / `ip addr`），手机和 PC 在同一 Wi-Fi。

### 域名与 SRV

官方客户端对域名会先查 `_minecraft._tcp.<域名>` 的 SRV 记录，服务器真正的入口往往在记录里（例如 `mcfallout.net` → `jp.mcfallout.net:25565`，而 `mcfallout.net` 的 A 记录是 Cloudflare 的网页地址）。minecraft-protocol 也会做这个查询，但它用的是 Node 的 `dns.resolveSrv`（c-ares），在 Android 上不保证可用。上一版在真机上最终拨的是 A 记录地址：要么这条 SRV 不存在（域名拼错也会这样），要么设备上的 `resolveSrv` 没成功——两种情况从界面上都看不出来，只能干等 40 秒。现在把解析过程变成可见步骤，并且不依赖 c-ares 一定能用。

所以探针自己先解析，再把结果交给 mineflayer（传 IP，避开它内部的 c-ares 查询）：

- 端口不是 25565 时按原样直连，不查 SRV（和官方客户端一致）。
- 端口 25565 且地址是域名时：系统 `dns.resolveSrv` → Cloudflare DoH → Google DoH，依次尝试。
- 拿到 SRV 后，再用 `dns.lookup` 解析目标名（优先 IPv4），页面上会多出两行步骤：`srv _minecraft._tcp.<域名>` 与 `a <目标名>`。
- 连接目标卡里显示「实际连接：<IP:端口>（SRV → <目标>）」，能直接看出拨到了哪。
- 域名拼错会显示 `域名不存在 (NXDOMAIN)`，不用再等 40 秒去猜。

也可以先用 adb 预填（页面里还能改）：

```bash
adb install -r probe-debug.apk
adb shell am start -n dev.mcbot.console.probe/.MainActivity \
  --es host 192.168.1.10 --ei port 25565 --es auth 0 --es user Probe
# 正版服：--es auth 1，或页面里勾“使用微软登录”
```

结果同时落在 `files/probe-result.json`，`/result` 返回同一份 JSON（`adb forward tcp:3999 tcp:3999` 后可本机取）。判定只有一条：

- `connect.ok=true` 且 `detail="spawned"` → **门过了**，可以开始第 3 步
- `kicked: "invalid session"` → 服务器是正版模式，勾微软登录重跑
- `ECONNREFUSED` → 地址通、端口没人监听（多半填了 `127.0.0.1`）
- `timeout` → 路由/防火墙；`spawned` 之外的一切都不算过

## 三、门的状态

| 断言 | 状态 | 证据 |
|---|---|---|
| mineflayer 依赖树无原生模块 | **已证明** | 98 个包，零 `.node`/`binding.gyp` |
| mineflayer 能在 Node 18.20.4 上加载并 spawn | **已证明** | 本机 vanilla 1.20.1，905 ms；探针脚本 1247 ms |
| 探针 APK 能构建 | **已证明（本地 + CI）** | 本机 `:probe:assembleDebug` 绿；CI run 43707042963 的 `probe` job 绿，产物 `mcbot-m3-probe`（26.9 MB zip） |
| JNI 符号接了 `node::Start` | **已证明（静态）** | `libnative-lib.so` 导入 `_ZN4node5StartEiPPc`，`libnode.so` 导出同名符号 |
| **libnode.so 在 Android 上起得来** | **已证明（真机，2026-11-15）** | 探针页面返回 `node 18.20.4 / v8 10.2.154.26-node.37 / platform android / arch arm64 / uv 1.44.2`，HTTP 服务与 JSON 落盘都正常 |
| **mineflayer 在 nodejs-mobile 里能加载** | **已证明（真机，2026-11-15 11:44）** | `require mineflayer` ok（4.39.0，191 ms）、`require minecraft-protocol` ok（1.68.0），随后 `createBot` 真的发出了 TCP 连接 |
| **Android 上 mineflayer 能连上并 spawn** | **未验证** | 当次目标是手机自己的 `127.0.0.1:25565`，没有任何服务端监听，报 `ECONNREFUSED` —— 这是**测试环境**问题，不是代码路径；需指向真实服务端复跑 |

### 真机第一次运行已经证明了什么

`require('mineflayer')` 失败，但**探针本身跑起来了**：`node`/`v8`/`platform=android`/`arch=arm64`/`uv` 全部有值，`http server on 3999` 成功，结果文件写进了 `files/node/`。也就是说：

- **libnode.so 在这个 arm64 设备上加载、启动、执行 JS、开 TCP 监听、写文件都正常**——门的一半过了，而且是此前最不确定的一半（4 KB 对齐在 4 KB 页设备上不是问题）。
- 失败点在**我们自己的打包裁剪**，不在 nodejs-mobile。`createBot` 都没走到。

按交接单的禁止条款：**第 3 步（正式集成）仍不启动**，等真机跑出 `connect.ok=true, detail="spawned"`。

## 四、上真机前必须看的两个风险

1. **16 KB 页**：libnode.so 是 NDK r24 构建、4 KB 对齐。设备若是 16 KB 页内核，加载会直接失败。先查：
   ```bash
   adb shell getconf PAGE_SIZE     # 4096 才有戏；16384 就是硬阻塞
   ```
   真撞上只能等 nodejs-mobile 用 NDK r27+ 重编（上游 r24 之后没再发版），或者换方案（Termux 继续用）。
2. **Node 18 已 EOL**：没有安全更新，且 mineflayer 声明 `>=22`。这次实测能跑，但上游任何一次依赖升级都可能踩到 18 不支持的语法/API。真要长期用 M3，得给 `package-lock.json` 上锁并冻结升级。

## 五、对第 3 步的设计约束（先记下来，别到时候返工）

- **一个进程只能起一次 Node，且不能重启**：Node 崩溃 = 只能整进程重启。所以"服务活则 Node 活"要做成"同一个进程里 FGS 与 Node 共存"，Node 异常退出时**不要**试图在进程内重启（会直接 abort）。
- **stdout 不通 logcat**：M1 的 `logger` 写文件照常可用，但真实日志要自己接到 logcat 或 HTTP。
- **assets 体积**：`node_modules` 全量 41 MB（其中 minecraft-data 已裁到 1.6 MB）。若还要支持多版本，裁剪策略要跟着版本选择走。
- **ABI**：只打 `arm64-v8a` 就够；要 emulator 再加 `x86_64`，APK 会翻倍。

## 六、真机第一次运行暴露的打包 bug（已修，`prepare-bundle.js`）

两次失败都不是 nodejs-mobile 的问题，而是我把 `minecraft-data` 裁错了。现在裁剪和校验都放在 `android/probe/tools/prepare-bundle.js`，构建期就会炸，不再等手机上才发现。

1. **`bedrock/common` 不能删。** `minecraft-data/lib/supportsFeature.js` 与 `index.js` 在加载时就 `require('../minecraft-data/data/bedrock/common/*.json')`，哪怕只连 PC 服务端。第一次真机报的就是 `Cannot find module .../bedrock/common/features.json`。
2. **不能按版本名字删目录。** `data.js` 是懒加载，但一个版本的数据并不在自己的目录里：`dataPaths.json` 里 `1.20.1` 的 `blocks` 指向 `pc/1.20`、`attributes` 指向 `pc/1.17`、`windows` 指向 `pc/1.16.1`。删目录必须按 `dataPaths` 的引用集合来，否则被保留的版本也会在 `createBot` 时炸（第二次是 `.../pc/26.1/blocks.json`）。
3. **最新版本目录也要留。** `server.version: false` 是默认值（`src/config.js:10`），mineflayer 先用"最新的已知版本"发握手包再协商，所以 `dataPaths` 里最后一个版本（当前 `26.1`）必须存在。
4. **只留"目标 + 最新"仍然不够。** 第三次真机运行（2026-11-15 21:46）里，服务器协商出来的是 **1.13**，`createBot` 立刻炸在 `.../pc/1.13/blocks.json`。版本是服务器在 ping 响应里决定的，客户端无法预知。现在 `pc/*` 全量保留（104 MB 原始 JSON，压完只多约 8 MB），并且构建期对 **66 个版本** 逐个编译 play 态 serializer（跳过 `1.10-pre1` 这类上游数据本身不一致的预发布别名），任何一个版本取不到数据都会让构建失败。

现在的校验会：把目标版本与最新版本的每个懒加载字段全部读一遍（缺文件即抛）、对全部版本编译 protodef serializer、并 `require('mineflayer')` 成功。等价于把 `createBot` 的初始化路径在构建机上先走一遍。

本地已用 APK 里那份 `assets/node.zip` 解包、在同一 Node 18.20.4 上对 1.20.1 服务端复跑：`require mineflayer ok`、`{"ok":true,"detail":"spawned"}`。真机结论等下一次安装。

### 第二次真机运行（2026-11-15 11:44）

打包裁剪修好后：`require('mineflayer')` 191 ms 成功、`minecraft-protocol` 192 ms 成功、`createBot` 走到了建立 TCP 连接这一步，目标 `127.0.0.1:25565` 返回 `ECONNREFUSED`。

这条错误恰恰说明链路是对的：**不是加载失败、不是 JNI 崩溃、不是权限被拒**，而是连接被明确拒绝——手机上根本没有服务端在 25565 监听。探针默认 host 是 `127.0.0.1`，必须显式传真实服务端地址：

```bash
adb shell am start -n dev.mcbot.console.probe/.MainActivity \
  --es host 192.168.1.10 --ei port 25565 --es auth 0 --es user Probe
```

`ECONNREFUSED` 与"超时"不同：前者说明包到了对端并被拒绝（地址通、端口没人听），后者才是路由/防火墙问题。所以下一步只需要换 host，不需要改任何代码。

### 第三次真机运行（2026-11-15 21:46，v7）

用域名 `mcfallout.net` 连接：`srv _minecraft._tcp.mcfallout.net → jp.mcfallout.net:25565 · cloudflare`（93 ms，走的是 DoH 而不是 c-ares）、`a jp.mcfallout.net → 172.65.211.204`（20 ms），随后 `connect 172.65.211.204:25565` 真正建立到 TCPShield 入口。**域名解析这一环在真机上已经通了**，之前拨到 Cloudflare 网页地址的问题没有再出现。

这次失败换了地方：服务器协商出 **1.13**，`createBot` 在构造 serializer 时找不到 `pc/1.13/blocks.json`——就是上面第 4 条裁剪 bug。与网络、nodejs-mobile、登录都无关。v8 全量保留 `pc/*` 并在构建期逐个版本验证，真机结果待下一次安装。
