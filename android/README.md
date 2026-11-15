# M2 外壳（android/）

WebView 外壳 + `specialUse` 前台服务 + 原生信号桥。**这里只负责保活和送信号，UI 与档位逻辑仍在 `web/` 和 `src/`。**

> **状态：源码未编译。** 开发沙箱里没有 Android SDK（无 `ANDROID_HOME`、无 `sdkmanager`/`platform-tools`），因此没有任何一次 `assemble` 或真机安装。下面给出的构建命令是按标准 AGP 工程写的，第一次真正构建时如果报错，请按报错修，不要假定它已经能用。

## 构建

需要 JDK 17+（本机有 21）、Android SDK Platform 35 + Build-Tools 35，以及一个可以联网的 Gradle（`gradle/wrapper/gradle-wrapper.properties` 指向 8.10.2，但 wrapper jar 没有入库）：

```bash
cd android
gradle wrapper --gradle-version 8.10.2   # 首次，生成 gradlew + wrapper jar
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

没装 Android SDK 时可用命令行工具：

```bash
sdkmanager "platforms;android-35" "build-tools;35.0.0" "platform-tools"
```

## 运行前提

1. Termux 里跑起 Node 核心：`npm start`（默认端口 8765）。
2. 端口不是 8765 时，用 intent extra 覆盖（会记住）：
   `adb shell am start -n dev.mcbot.console/.MainActivity --ei port 18770`
3. Termux **和 Termux:API** 两个包都要：省电策略「无限制」+ 自启动。只设 Termux 时 `termux-battery-status` 会被冻结，页面表现为信号 `unavailable`。
4. 应用首次启动会申请通知权限和电池优化白名单；HyperOS 还需在最近任务里给本应用加锁。

## 设计要点

| 文件 | 作用 |
|---|---|
| `MainActivity.kt` | WebView 加载 `http://127.0.0.1:<port>`；`/api/health` 预检（含 `protoVersion`）；权限申请；HyperOS 指引；每 60s 重发 `thermal`/`powerSave` |
| `BridgeService.kt` | `foregroundServiceType="specialUse"`，无时间配额；**不用 `dataSync`**（Android 15 有 6h/24h 上限） |
| `NativeSignals.kt` | `ACTION_SCREEN_ON/OFF`、`addThermalStatusListener`、`ACTION_POWER_SAVE_MODE_CHANGED` |
| `res/xml/network_security_config.xml` | 只对 `127.0.0.1`/`localhost` 允许明文，其余一律禁止 |

信号注入走 `evaluateJavascript`，目标对象由页面自己安装（`web/app.js` 里的 `window.mcbotNative`）：

```js
window.mcbotNative.init({ screenOn, thermal, powerSave })  // 页面加载完成时
window.mcbotNative.screen(on)                              // 亮/灭屏广播
window.mcbotNative.thermal(0..6)                           // 热状态变化
window.mcbotNative.powerSave(on)                           // 省电模式变化
```

页面收到后通过已有 WS 上行 `screen` / `thermal` / `powerSave`，协议仍为 v1（仅新增）。

### 两个容易踩的坑

- **不要调用 `webView.onPause()`/`onStopLoading()`**：熄屏时 JS 若被暂停，45s 心跳就停了，服务端会把客户端判为过期。
- **信号会过期**：Node 侧 5 分钟收不到原生值就回落 sysfs/settings。外壳因此每 60s 重发一次当前值（即使没变），这既是存活证明，也避免"应用被杀后档位永久钉在 L0"。

## 验收（未验证）

按 README「M2 外壳」一节的五条走。**功耗不在 M2 验收内**；测试数量或代码存在都不构成省电证据。
