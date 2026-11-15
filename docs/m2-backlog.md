# M2 backlog（M1 代码冻结后只增不改）

M1 已冻结，下面这些**不在 M1 修**，等真机数据回来一起排期。

## 1. 清包停摆的常驻状态位

`warnAbort` 的 10 分钟去重是对的（防刷屏），但持续满箱时只会响一次，界面看起来像「已经好了」，实际清包一直没跑。M2 在 UI 上加一个常驻状态位：`清包：已停摆（目标容器已满，12:31 起）`，只在下次清理成功后清除。日志/通知仍是去重的。

## 2. 关窗残留文案要分两种结果

`closeContainer()` 目前统一提示「已按服务器规则退回背包」。原版逻辑是先把光标物品塞回背包，**塞不下就掉在地上**；而触发清包的场景正好是背包快满，掉落是常见路径。M2 需要区分：

- 退回背包 → 「已退回背包」
- 掉在地上 → 「背包已满，N 个 X 掉在脚边」，并考虑顺手再抛一次或等下次清包

真机观察记录见 `docs/real-device-checklist.md` 第 3 条「关窗残留」。

## 3. 热覆盖 —— 已在 M2 实现（待真机验证）

Node 侧仍保留 sysfs 基线差值作为 fallback；`android/` 外壳上报 `PowerManager.getCurrentThermalStatus()`（上行 `thermal`），原生值可用时作主判据（≥ `power.thermal.nativeL0AtOrAbove`，默认 2=MODERATE 即强制 L0），5 分钟不刷新自动过期回落。**默认阈值 2 是推断**：LIGHT(1) 在现代手机上持续负载就会进入，用它当 L0 会把 bot 长期钉死。真机跑一段后看 `power.thermalNative` 的分布再定。

## 4. powerSave —— 已在 M2 实现（待真机验证）

`settings get global low_power` 在本机返回字符串 `null`（未设置）而不是 0/1，已按 `unavailable` 处理（不当作"已关闭"来降档）。M2 外壳上报 `PowerManager.isPowerSaveMode()`（上行 `powerSave`），信号表第五行从 `unavailable` 变成 `live`。未装外壳时行为与 M1 相同。

## 5. 仍未做

- Node 侧没有独立 PRD 文件，M2 的"前置声明"写在 `README.md` 的「M2 外壳」一节；如果后续补 PRD，需同步。
- 原生 `Termux.RUN_COMMAND`（由应用拉起 Termux 里的 `npm start`）仍是可选项，M2 保持"手动启动 Termux，应用只连接"。

