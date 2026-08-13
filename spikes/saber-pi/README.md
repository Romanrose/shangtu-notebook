# Saber × Pi 独立技术 Spike

状态：第一条纵切面已完成，fixture-only；这不是 Saber fork，也不是当前 PWA 的迁移分支。

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
commit: 34c57e51fb97ad23b781d7f681beaa821746b8ef
```

该目录包含 Saber 自己的 GPL-3.0 源码和 Flutter submodule，但不属于本仓库，不会被当前仓库的 Git 提交或构建包含。可在另一台机器上复现为：

```bash
git clone https://github.com/saber-notes/saber.git saber-pi-experiment
cd saber-pi-experiment
git switch -c experiment/pi-companion
```

当前机器没有 Flutter/Dart SDK，因此暂不在这个工作区提交 Dart adapter。已确认的最小挂接位置是：`Editor.onDrawEnd` 作为停笔事件入口，`EditorExporter.screenshotPage` 作为当前页 PNG 导出入口；`EditorPage` / `Stroke` / `EditorHistory` 继续由 Saber 自己管理。未来 adapter 只把 PNG、页 ID、笔迹段 ID 和用户确认文本发送到本 Spike bridge，不接管这些确定性能力。

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

## Client adapter harness

`client.mjs` 是未来 Flutter adapter 的最小行为合同，不是 Saber 代码。它通过注入的 transport 调用 bridge，并把状态限制为：`rest`、`awakening`、`awaiting_confirmation`、`ready`、`quiet`。运行：

```bash
npm run check:saber-spike-client
```

该 harness 验证本地苏醒回调在任何 transport 调用之前发生；转写结果只进入待确认派生层；确认前不能寻迹；寻迹后原始 PNG 引用仍由 Saber 侧持有；静读不调用 transport。未来在独立 Saber fork 中实现 Dart 版本时，应保持相同顺序，但由 Saber 的页面/笔迹生命周期和 Flutter 状态管理承载。

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

- 当前 harness 证明的是 bridge/合同顺序，不是实际 Flutter Saber 页的端到端运行；本机没有 Flutter SDK，且本轮明确不修改 Saber 上游。
- 当前 fixture 仍复用仓库已有固定演练图谱；它不是真实模型、真实来源或真实识别质量测试。
- 下一步最小行动：在具备 Flutter SDK 后，在上述独立工作区的 `experiment/pi-companion` 分支中仅增加一个开发期 adapter，把“当前页 PNG 导出 + pen-up 本地状态 + 两个 bridge 请求 + 页边 overlay”接到一个示例编辑页；先不写 `.sbn2`、同步协议或 Pi 工具代码。
