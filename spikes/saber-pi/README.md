# Saber × Pi 独立技术 Spike

状态：第一条纵切面已完成，默认 fixture-only；这不是 Saber fork，也不是当前 PWA 的迁移分支。

华为平板的可复核验收矩阵见 [Saber Spike 华为平板验收记录](../../docs/saber-spike-huawei-validation.md)。

## 先说清楚：当前版本不是 Saber

当前仓库里没有 Saber 的 Flutter 源码、`pubspec.yaml`、Git submodule、编译产物或 GPL-3.0 文件副本。Saber 只被当作外部候选底座调查过；当前可运行的代码全部位于 `spikes/saber-pi/`，是 bridge、fixture 和未来 adapter 的行为合同。

运行以下检查可以确认这个边界：

```bash
npm run check:saber-isolation
```

换句话说，现在验证的是“Pi 能否安全接在 Saber 旁边”，不是“我们已经把 Saber 集成进来了”。真正的 Saber 实验版本应在独立的 Saber fork/实验仓库中创建；那个仓库再通过 HTTP/本地受控服务调用这里约定的 bridge，不把 Saber 源码带回本仓库。

## 独立 Saber 工作区

当前已在本仓库之外建立独立工作区：

```text
/Users/romanrose/Project/saber-pi-experiment
branch: experiment/pi-companion
upstream: https://github.com/saber-notes/saber.git
upstream baseline: 34c57e51fb97ad23b781d7f681beaa821746b8ef (v1.35.1+1)
local Spike HEAD: 52ac983e9dcd99b499dc83786401b00ac62fa776
```

该目录包含 Saber 自己的 GPL-3.0 源码和 Flutter submodule，但不属于本仓库，不会被当前仓库的 Git 提交或构建包含。可在另一台机器上复现为：

```bash
git clone https://github.com/saber-notes/saber.git saber-pi-experiment
cd saber-pi-experiment
git switch -c experiment/pi-companion
```

当前机器通过 Saber 自带的 Flutter submodule 已验证 Flutter 3.44.9 / Dart 3.12.2。独立工作区中已增加未推送的 Dart companion adapter：`lib/data/pi_companion/pi_companion_client.dart`、`lib/pages/editor/pi_companion_panel.dart`，并在 `Editor.onDrawEnd` 接入 `EditorExporter.screenshotPage`。这只是外部 GPL 工作区的实验改动，仍没有复制到当前仓库。adapter 只把 PNG、页 ID、笔迹段 ID 和用户确认文本发送到本 Spike bridge，不接管 Saber 的确定性能力。

## 结论：先做 companion bridge

本轮选择独立 companion bridge，而不是 fork Saber 或修改 Saber 主仓库：

- Saber 是 Flutter/Dart 单体应用。页面由 `EditorPage` 持有，笔迹由 `Stroke` 保存点序、压力、工具和页面索引，`EditorHistory` 管理撤销/重做；这些确定性能力适合作为底座继续由 Saber 负责。
- 当前上游没有可发现的插件/extension API。停笔、当前页、当前 stroke segment 和页边覆盖层都位于编辑器内部；直接接入需要 fork 并持续维护 Flutter 改动。
- Saber 已有当前页 PNG 导出能力，足够先验证“数字墨水保持在 Saber，派生识别/回应走受控服务端”的桥接边界。
- Saber 仓库是 GPL-3.0。本仓库不包含 Saber 源码、submodule、二进制或复制的实现；上游只在独立临时目录中以 pinned commit 做架构检查。若未来 fork，必须建立独立仓库/分支，保留许可证、版权/修改声明和对应源代码交付义务。

因此，Spike 的系统边界是：

```text
Saber note page
  ├─ strokes / undo / render / local save / sync
  ├─ pen-up: local awakening (immediate, local-only)
  └─ current page PNG + confirmed text
       ↓ companion bridge (fixture now, controlled service later)
     /spike/saber-pi/v1/transcribe
     /spike/saber-pi/v1/seek
       ↓
     existing transcription contract + constrained Pi fixture
       ↓
     editable transcription OR evidence / ambiguity / gap margin result
```

## 第一条可验证纵切面

运行：

```bash
npm run check:saber-spike
```

这条检查使用一个最小 PNG fixture 模拟 Saber 当前页导出的笔迹区域，并验证：

1. `pen_up` 后先记录本地 `local_awakening`，然后才调用转写 bridge；
2. 转写返回现有可编辑 `transcription` 合同，且明确 `originalInk: "retained_by_saber"`；
3. 没有用户确认文本时，寻迹请求被拒绝；
4. 用户确认后，成功分支返回固定来源和有界路径 `李白 → 作者 → 将进酒`；
5. 修改为夹具外问题时只返回证据缺口；
6. `mode: "quiet"` 和非合同路由都不会触发 bridge/Pi；
7. fixture 中的来源 URL 仅为合同测试占位，不能作为产品事实来源。

也可以单独启动本地 fixture bridge：

```bash
node spikes/saber-pi/bridge.mjs
```

它只开放两个 POST 路径，默认不读取任何模型、Pi、CNKGraph 或同步凭据，也不访问网络。

如果受控服务端已按现有转写合同配置好 provider，运维人员才可在 Node 进程中显式选择它：

```bash
SABER_PI_TRANSCRIPTION_PROVIDER=huawei-handwriting \
SABER_PI_TRANSCRIPTION_MODEL_ID=handwriting-v1 \
node spikes/saber-pi/bridge.mjs
```

这只会把 PNG 交给现有 `transcribeInk` 服务端 adapter；华为 token、endpoint 和 project ID 仍只来自该进程的 `HUAWEI_OCR_*` 环境变量，绝不发送到 Saber。未设置 `SABER_PI_TRANSCRIPTION_PROVIDER` 时始终使用 fixture；显式选择 provider 但缺少其服务端配置时，返回既有的安全 `vision_unconfigured`，不会伪装成 fixture 识别结果。本 Spike 尚未填入这些变量或发起真实 OCR 请求。

## Client adapter harness

`client.mjs` 是当前 Flutter adapter 的跨语言行为合同；Dart 实现位于独立 Saber 工作区，JS 文件仍保留为当前仓库的轻量合同测试。它通过注入的 transport 调用 bridge，并把状态限制为：`rest`、`awakening`、`awaiting_confirmation`、`ready`、`quiet`。运行：

```bash
npm run check:saber-spike-client
```

该 harness 验证本地苏醒回调在任何 transport 调用之前发生；转写结果只进入待确认派生层；确认前不能寻迹；寻迹后原始 PNG 引用仍由 Saber 侧持有；静读不调用 transport。独立工作区的纯 Dart smoke 可运行：

```bash
cd /Users/romanrose/Project/saber-pi-experiment
./submodules/flutter/bin/cache/dart-sdk/bin/dart \
  --packages=.dart_tool/package_config.json tool/check_pi_companion.dart
```

它验证本地苏醒、确认门、原笔迹保留、证据结果、静读零调用，以及转写失败后回到可恢复的 `ready` 状态。页边 overlay 对三分支分别显示证据正文/来源/路径、歧义说明/候选和证据缺口说明；session 还会丢弃迟到的旧笔迹响应，避免覆盖当前段结果。当前 UI 接入仍是开发期 overlay，不写 `.sbn2`。

跨进程验证需要先在当前仓库启动 fixture bridge：

```bash
cd /Users/romanrose/Project/shangtu-notebook
node spikes/saber-pi/bridge.mjs

# 另一个终端
cd /Users/romanrose/Project/saber-pi-experiment
./submodules/flutter/bin/cache/dart-sdk/bin/dart \
  --packages=.dart_tool/package_config.json tool/check_pi_companion_live.dart
```

该 live smoke 直接验证 Dart client 与 Node bridge 的 UTF-8 请求/响应、成功响应的 schema/页 ID/笔迹段 ID/阶段绑定、transcribe 不携带确认文本、seek 才携带用户确认文本、无 `Authorization` 头、PNG data URL、证据/歧义/缺口三分支和静读边界。

## Bridge 合同

请求共有字段：

```json
{
  "pageId": "note-01-page-01",
  "strokeSegmentId": "segment-01",
  "mode": "seek",
  "image": { "mimeType": "image/png", "data": "data:image/png;base64,..." }
}
```

`/transcribe` 返回现有 `{ status, transcription, providerStatus }` 形状的外层 envelope；`transcription.text` 和 `candidates` 只是可编辑派生层，不能覆盖 Saber 原笔迹。

`/seek` 额外要求：

```json
{ "confirmedText": "李白写过《将进酒》吗？" }
```

返回 `outcome.kind` 为 `evidence`、`ambiguous` 或 `gap`。桥接层不创建聊天消息；未来 Flutter 适配器应把它映射为页边回应。Pi 只在服务端处理用户确认后的文本；客户端不保存任何模型、图谱或 Pi 凭据。

## 当前缺口与下一步

- 当前 JS harness、Dart smoke、独立 Saber macOS UI 和真实华为平板 UI 已证明第一条纵切面：Saber 页面保留原始笔迹，停笔后进入可编辑转写，确认后在页边显示“有证据”、证据正文、有限路径和来源。本轮没有向 Saber 上游远程推送。
- 已启动当前仓库的 fixture bridge，并用真实 HTTP 请求验证 `/transcribe` → 可编辑转写、`/seek` → `evidence` 两个 live 路径；返回均明确 `originalInk: "retained_by_saber"`。
- 普通 `flutter run -d macos` 仍会被 `com.adilhanney.saber` 的 provisioning profile 阻断；当前已能启动一个独立工作区生成的 unsigned Debug `Saber.app`，并完成上述 fixture-only UI 演示。可复现的 clean build 仍需整理 Rust 1.97.1 的 PATH/toolchain；本轮没有修改或提交 Saber 的平台工程生成物。
- 已在 USB 调试授权的华为 `DBY-W09`（Android 12 / API 31）上安装独立 Saber Debug APK；通过 `adb reverse tcp:4175 tcp:4175` 接入 Mac fixture，实际看到可编辑转写，并在确认后看到“有证据”正文、有限路径和来源从页边逐字出现。强制停止并重开独立 Spike 后，临时笔记及其原始笔迹缩略图仍在。另在关闭 fixture bridge 后切至静读模式新增一笔：只显示“只保存笔迹，不调用 Pi”，没有出现识字、确认或桥接错误。通过 ADB 将平板切到 Android `port` 配置后，触摸新增一笔在约 250ms 已显示“识字中”，随后进入确认并显示同一“有证据”页边回应；测试后已恢复原有自动旋转设置。用户已进一步用真实触控笔在横屏、竖屏分别书写，均能在停笔后进入寻迹模式。该次平板验证仍是 fixture-only，尚未替代真实模型质量或正式发布签名流程。
- 当前 fixture 仍复用仓库已有固定演练图谱；它不是真实模型、真实来源或真实识别质量测试。
- `有歧义` 与 `有缺口` 已由 Node fixture 和 Dart live smoke 覆盖，但尚未分别在平板 UI 上手工编辑确认文本后录制；它们不能被“有证据”的平板截图替代。
- 下一步最小行动：先确定受控服务端的真实 OCR 供应商和一组获准使用的手写样本，再用现有 adapter 与同一 UI 合同评估识别质量。随后才由服务端配置受限 Pi 模型和搜韵/CNKGraph 网关；先不写 `.sbn2`、同步协议或 Pi 工具代码。
