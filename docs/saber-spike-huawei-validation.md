# Saber × Pi Spike：华为平板验收记录

日期：2026-08-14。此记录证明独立 Saber Spike 的第一条 fixture-only 纵切面可在实机运行；它不代表真实 OCR、Pi 模型或搜韵/CNKGraph 已上线。

## 测试范围与隔离

- 设备：华为 `DBY-W09`，Android 12 / API 31，通过 USB 调试连接 Mac。
- 正式 Saber 包：`com.adilhanney.saber`；独立 Spike 包：`com.adilhanney.saber.spike`，版本 `1.35.1`。两者同时存在，未发生覆盖。
- Mac 本机仅运行 fixture bridge，并通过 `adb reverse tcp:4175 tcp:4175` 提供连接。没有配置模型、Pi、图谱或同步凭据，也没有真实第三方调用。
- 原始笔迹和临时测试笔记只保存在独立 Spike；未写入当前 PWA 仓库或正式 Saber。

## 已验证的设备行为

| 场景 | 观察结果 |
| --- | --- |
| 横屏触摸寻迹 | 落笔后先显示本地“识字中”，随后出现可编辑转写；确认后页边逐字显示“有证据”、有限路径和来源。 |
| 竖屏触摸寻迹 | 在 Android `port` 配置下，落笔约 250ms 显示“识字中”，随后可确认，并出现同样的页边“有证据”回应。测试后恢复平板原有自动旋转设置。 |
| 触控笔 | 测试者已在横屏和竖屏分别书写，均可进入寻迹本地反馈。 |
| 静读模式 | 在关闭 fixture bridge 后新增笔迹，只显示“只保存笔迹，不调用 Pi”；未出现识字、确认或桥接失败。 |
| 笔迹持久化 | 强制停止并重新打开独立 Spike 后，临时笔记及其原始笔迹缩略图仍存在。 |

`有歧义` 与 `有缺口` 已由 Node fixture 和 Flutter Dart live smoke 覆盖；由于 Android shell 不支持中文确认文本注入，尚未分别录制它们的平板 UI。不得用“有证据”截图替代这两条独立证据。

## 可复测入口

在 Mac 上启动 bridge：

```bash
cd /Users/romanrose/Project/shangtu-notebook
node spikes/saber-pi/bridge.mjs
```

连接平板后建立仅本机反向端口：

```bash
adb reverse tcp:4175 tcp:4175
```

合同检查不依赖设备或网络：

```bash
npm run check:saber-isolation
npm run check:saber-spike
npm run check:saber-spike-client
```

## 尚未完成

1. 真实 OCR：需要选择受控服务端 provider，并使用明确同意的华为平板手写样本按 `docs/transcription-experiment.md` 评测。
2. 真实 Pi 模型：只可在服务端经 `npm run preflight:pi` 配置受限 provider；客户端不保存凭据。
3. 搜韵/CNKGraph：需要一个满足 `docs/souyun-cnkgraph-gateway-contract.md` 的内部受控 gateway；不能让 Flutter 或 Pi 直接访问。
4. 平板 `有歧义`、`有缺口` UI 的人工录制，以及正式发布签名流程。
