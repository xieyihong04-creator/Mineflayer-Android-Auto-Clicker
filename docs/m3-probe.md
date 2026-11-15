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
| 裁剪后（只留 1.20.1 + common） | **1.6 MB** | 同上 |
| 完整 node 包（含 node_modules） | **41 MB / 5554 个文件** | `bundle-node.sh` |
| 打进 APK 的 `node.zip` | **7.1 MB** | Gradle `nodeAsset` |
| 探针 APK（arm64 单 ABI） | **69 MB**（其中 libnode.so 62.4 MB） | `:probe:assembleDebug` |

## 二、探针怎么用

```bash
adb install -r probe-debug.apk
# 离线连（服务器 online-mode=false 才成立）
adb shell am start -n dev.mcbot.console.probe/.MainActivity \
  --es host 192.168.1.10 --ei port 25565 --es auth 0 --es user Probe
# 微软设备码登录（走的是和 M1/M2 完全相同的 onMsaCode 路径）
adb shell am start -n dev.mcbot.console.probe/.MainActivity \
  --es host 你的服务器 --ei port 25565 --es auth 1
```

结果只有一个出口：**`http://127.0.0.1:3999/`**（手机浏览器直接打开，或 `adb forward tcp:3999 tcp:3999` 后在本机看）。因为 nodejs-mobile 默认不把 stdout 接到 logcat，探针自己起 HTTP 服务报状态，同时把同一份 JSON 写到 `files/probe-result.json`。

页面里 `/run` 重试连接，`/run?auth=1` 重试并走设备码。判定看 `steps[]` 与 `connect.ok`：

- `steps` 里 `require mineflayer` 失败 → nodejs-mobile 装不下 mineflayer（门直接关上）
- `connect.ok=true` 且 `detail="spawned"` → **门过了**，可以开始第 3 步
- `kicked: "invalid session"` → 服务器是正版模式，需要 `auth=1` 重跑
- `spawned` 之外的一切都不算过

## 三、门的状态

| 断言 | 状态 | 证据 |
|---|---|---|
| mineflayer 依赖树无原生模块 | **已证明** | 98 个包，零 `.node`/`binding.gyp` |
| mineflayer 能在 Node 18.20.4 上加载并 spawn | **已证明** | 本机 vanilla 1.20.1，905 ms；探针脚本 1247 ms |
| 探针 APK 能构建 | **已证明（本地 + CI）** | 本机 `:probe:assembleDebug` 绿；CI run 43707042963 的 `probe` job 绿，产物 `mcbot-m3-probe`（26.9 MB zip） |
| JNI 符号接了 `node::Start` | **已证明（静态）** | `libnative-lib.so` 导入 `_ZN4node5StartEiPPc`，`libnode.so` 导出同名符号 |
| **libnode.so 在 Android 上起得来** | **未验证** | 需要真机 |
| **Android 上 mineflayer 能连上** | **未验证** | 同上 |

按交接单的禁止条款：**第 3 步（正式集成）不启动。** 在真机上跑出 `connect.ok=true, detail="spawned"` 之前，`android/app` 里不许出现 libnode 相关代码。

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
