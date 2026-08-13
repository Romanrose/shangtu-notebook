# 转写实验方案

本文件用于比较服务端视觉转写适配器；它不是纸页功能，也不改变“停笔一秒内先出现本地反馈”的合同。浏览器只上传当前笔迹裁剪 PNG，真实调用和计时均在服务端完成。

## 分阶段比较

1. 图像 OCR / HTR：先比较一项自托管中文手写 OCR 与一项托管手写 OCR。它们直接复用当前 PNG 接口。
2. VLM 复核：当前实验分支提供 `vlm-openai-compatible` 适配器，适用于兼容 Chat Completions 的本地或托管视觉接口；输出仍须经过 `createTranscription` 收敛，绝不能直接寻迹或写事实旁批。
3. 数字墨水：未来原生壳保留笔画坐标与时序后再单独评估；它不是当前纯 PWA 的替换实现。

## 样本与隐私

不设置 `TRANSCRIPTION_BENCHMARK_MANIFEST` 时，`npm run bench:transcription` 只运行无用户数据的合同夹具，验证计时与报告格式，**不代表真实识别准确率**。设置本机清单后才会读取真实实验 PNG；开始真实对比前，建立经明确同意的、只用于测试的样本集：

- 至少覆盖 1–3 句中文文史问题、人物/地名/书名号、简繁混写与潦草笔迹；每条保留人工校对的目标文本。
- 按横竖屏、手写笔/手指、短句/长句和不同书写者分层；不要用生产用户笔迹或上传无同意的数据。
- 每个服务商都使用同一份裁剪 PNG、同一轮数、同一服务端地域与串行/并行策略；首次冷启动与稳态运行分开记录。

在实验分支可打开 `/?experiment=transcription` 进入采样辅助路径。写完并完成本地停笔反馈后，纸页边会提供“下载样本 PNG”，下载的是与 `/api/transcribe` 相同的当前笔迹裁剪图；默认 URL 不显示该入口，也不会上传额外数据或保存服务端副本。下载后的 PNG 需由实验者在本机目录中按上面的 manifest 格式补充人工校对文本和匿名元数据。

同一实验路径还提供“下载时延 JSON”。每次书写会生成一个 12 位随机匿名 `sampleId`，同时写入 PNG 与 timing 文件名/JSON，便于在本机配对而不记录用户身份。文件内容只包含 `schema`、页码、`sampleId`，以及相对停笔时刻的匿名事件：`pen_up`、`local_awakening`、`transcription_request`、`transcription_result`、`transcription_confirmed`；结果事件附带非敏感的 `status`/`providerStatus`/受控 `provider` 标签，确认事件只附带 `edited: true/false`。它不包含转写文本、PNG 内容、URL、endpoint、模型 ID、凭据或请求体，可将同一笔迹的“停笔 → 本地苏醒”“停笔 → 服务端结果”“停笔 → 用户确认”按 provider 分开比较。静读模式与默认 URL 不生成该记录。

实验导出状态会随纸页记录保存；新建页面或翻页回看不会丢失原页的 sampleId、PNG 和 timing 下载入口。重新开始在该页书写时，才会为新的笔迹生成新的匿名样本。

多次实验后可在本机将这些 JSON 汇总；汇总器只保留样本数、匿名 `sampleId` 覆盖率与唯一 ID 集合、事件计数、p50/p95、结果可用率以及按 provider/status 的分组，不输出输入文件名或任何笔迹内容：

```bash
npm run summarize:transcription-timing -- \
  --input-dir /absolute/path/to/paddleocr-timings/ \
  --provider paddleocr \
  --output /absolute/path/to/timing-summary.json
```

缺少 `transcription_result` 的样本会进入 `missing_result` 分组并降低 `resultAvailableRate`；没有点击确认的样本不会被计入确认率；超时或网络异常不会被当作识别质量错误。`localAwakening` 是本地体验门槛，必须单独保持在 1 秒以内；`transcriptionResult` 是 provider 端到端返回时延；`confirmation` 和 `editedConfirmationRate` 分别衡量确认延迟与机器转写被用户改动的比例。汇总结果的 `byProviderStatus` 会同时保留 `provider`、`providerStatus`、`status`、确认可用率和修改率，便于把修改率和可用率与同一 provider 对齐。候选按钮选择也算 `edited=true`，因为最终送入寻迹的文本已改变，但日志不保存改变前后的文本。

同一 provider 的 timing 汇总应显式传入 `--provider`。这样没有 provider 标签的网络失败、超时或缺结果也会计入该 provider 的分母；成功结果仍必须携带自身 provider 标签，若与命令行标签不一致则拒绝汇总。不同 provider 必须分别生成 timing summary，再传给比较器。

`--input-dir` 只读取实验者明确指定目录的顶层 JSON；目录为空、混入其他文件/子目录，或同时使用 `--input` 与 `--input-dir` 都会失败。旧的重复 `--input` 用法仍可用于少量文件。

比较器还会校验 timing summary 顶层 `provider` 与其中每个 provider 分组一致；不能通过修改摘要标签把一个 provider 的确认率借给另一个 provider。

每份 benchmark 输入也只能包含一次同名 provider；重复的 provider 报告会被拒绝，避免在矩阵比较中重复计算样本权重。

为避免把成功结果错误归入未知 provider，timing schema 要求 `status=ok` 的 `transcription_result` 必须带受控 `provider` 标签；失败、超时或未配置结果可以没有 provider，并会进入 `unknown`/失败分组。

多份 provider benchmark 报告可以进一步做 cohort 校验和决策摘要：

```bash
npm run compare:transcription -- \
  --input /absolute/path/to/paddleocr-report.json \
  --input /absolute/path/to/tesseract-report.json \
  --timing /absolute/path/to/paddleocr-timing-summary.json \
  --timing /absolute/path/to/tesseract-timing-summary.json \
  --evidence public_casia \
  --output /absolute/path/to/comparison.json
```

比较器要求所有报告使用相同且顺序一致的样本 ID、样本数、`runs` 和 `warmup`。传入 `--timing` 后，比较器会要求 timing summary 完整覆盖同一批 sampleId，并按 provider 合并确认可用率和修改率；缺少完整确认/修改信号的 provider 不进入排名。`public_casia` 或 `unknown` 证据只输出“尚不足以选择生产 provider”；`consented_user` 若没有 timing summary 也只输出 `insufficient_evidence`，只有质量、结果可用率、用户确认和修改率字段完整时才允许排名，排序优先 CER，再看稳定 exact/候选命中、用户修改率，最后才看延迟。输出不包含逐条期望文本或实际转写。

报告的 `evidence`、`cohortId`、`consent`、脱敏 `preprocessing` 和 `runId` 从实验配置/manifest 派生；`TRANSCRIPTION_BENCH_EVIDENCE` 和 `TRANSCRIPTION_BENCH_COHORT_ID` 只能做一致性校验，不能给一份旧报告重新贴上用户样本标签。没有这些字段的历史报告按 `unknown` 处理。要进行 `consented_user` 排名，必须使用已完成人工校对的 manifest，并让每条样本声明同一个 `evidence: "consented_user"`、`cohortId` 和 `consent: "confirmed"`；未标注模式或未确认授权永远不能进入该分支。不同 `preprocessing` 标签（例如 `casia-scale-1_5` 与 `casia-scale-3`）或不同 `runId` 不能放入同一比较。

已用 CASIA 公开基线的 PaddleOCR 与 Tesseract 报告做过一次实际比较（10 样本、`runs=3`、`warmup=1`）：工具保留两者的 CER、可用率和延迟摘要，但决策结果为 `insufficient_evidence`、`recommendedProvider=null`。这证明公开基线能用于工程对照，却不会被误当成用户证据触发生产选型。

也可以把准备好的 PNG 放进一个专用本机目录后运行标注助手（不要直接把 Downloads 作为目录）：

```bash
TRANSCRIPTION_SAMPLE_DIR=/absolute/path/to/handwriting-samples \
TRANSCRIPTION_MANIFEST_OUTPUT=/absolute/path/to/handwriting-samples/manifest.json \
TRANSCRIPTION_TIMING_DIR=/absolute/path/to/handwriting-samples/timings \
TRANSCRIPTION_SAMPLE_METADATA='{"writer":"writer-a","inputMode":"stylus","orientation":"portrait"}' \
npm run prepare:transcription-manifest
```

设置 `TRANSCRIPTION_TIMING_DIR` 时，标注助手会先校验 timing JSON，并要求文件名与 JSON 内的匿名 sampleId、实验页 PNG 的 sampleId 三者一一对应；缺失、重复、未知 ID 或混入其他 JSON 会在人工输入校对文本前失败。省略该变量仍保留旧的“只准备 PNG manifest”用法，但最终 consented_user 实验应启用它。

经明确同意的本机实验清单还应在 `TRANSCRIPTION_SAMPLE_METADATA` 中声明例如 `{"evidence":"consented_user","cohortId":"user-cohort-a","consent":"confirmed"}`；这只是实验来源记录，不是上传凭据，也不会随代码提交。只有实验者已取得样本书写者明确同意，并确认样本可用于本次转写比较时，才允许填写 `confirmed`。

运行 benchmark 时会再次逐条检查这些字段，而不是只检查清单中是否“出现过”授权值：每一条样本都必须有 `evidence=consented_user`、同一个有效 `cohortId`、`consent=confirmed` 和 1–240 字符人工校对文本。任意一条缺失或混入不同 cohort，都会在模型调用前失败，避免把部分授权清单误用于最终 provider 排名。

拿到样本和 timing 导出后，先运行最终实验 preflight；它只读 manifest、PNG 路径和匿名 timing，不调用模型，也不输出人工校对文本：

```bash
npm run preflight:transcription -- \
  --manifest /absolute/path/to/handwriting-samples/manifest.json \
  --timing-dir /absolute/path/to/handwriting-samples/timings/ \
  --provider paddleocr \
  --output /tmp/shangtu-transcription-preflight.json
```

`--timing-dir` 只读取实验者明确指定目录的顶层 JSON，并按 manifest 中的匿名 sampleId 自动配对，因此文件名排序不会影响结果；也可以继续重复传入 `--timing`，但那种模式同样要求集合完整。目录为空、混入非 JSON/子目录、重复或缺失 sampleId 都会在模型比较前失败。每个成功结果都必须带同一个 provider，且每个样本都应有用户确认。输出 `status=ready` 后，再把同一 manifest 交给 `bench:transcription`，并将 timing 汇总传给 `compare:transcription`；若输出 `needs_result_or_confirmation`，只能继续采集，不能据此做 provider 排名。

命令会按文件名排序，逐张要求输入人工校对文本；空文本、非 PNG、目录外路径和超长文本都会被拒绝。生成的 manifest 与 PNG 一起留在本机，随后可直接交给 `TRANSCRIPTION_BENCHMARK_MANIFEST`。

如果 PNG 来自实验页导出，标注助手会从严格格式 `shangtu-ink-{sampleId}-page-{page}-{timestamp}.png` 中保留 12 位匿名 `sampleId` 作为 manifest 的顶层 `id`；这样 benchmark 结果 ID 能与同名 timing JSON 配对。普通自定义文件名仍使用 `sample-01` 等顺序 ID；同一目录内重复导出 ID 会被拒绝。

如果还没有完成人工校对，只想先测真实样本的服务可用率和延迟，可以在一个只含 `id`、`imagePath`、可选 `metadata` 的本机清单上显式设置 `TRANSCRIPTION_BENCHMARK_UNLABELED=1`：

```bash
TRANSCRIPTION_BENCHMARK_UNLABELED=1 \
TRANSCRIPTION_BENCH_PROVIDERS=paddleocr,paddleocr-vl \
TRANSCRIPTION_BENCHMARK_MANIFEST=/absolute/path/to/handwriting-samples/unlabeled.json \
PADDLEOCR_ENDPOINT=http://127.0.0.1:8080/ocr \
PADDLEOCR_VL_ENDPOINT=http://127.0.0.1:8081/layout-parsing \
npm run bench:transcription
```

该模式仍会记录 `okRate`、状态计数和 p50/p95，但 `exact`、CER、质量命中率及稳定命中率全部为 `null`；只有补齐人工校对文本后，样本才可用于 provider 质量排名。

一次 UI capture smoke（4 张临时折线裁剪图，`warmup=1`、`runs=2`）中，PaddleOCR 与 PaddleOCR-VL 均为 `8/8 unavailable`，没有生成伪造文本；平均 p50 分别约为 `212.5 ms` 与 `1346.2 ms`。这些输入不是中文手写，样本和报告已清理，只用于确认不可识别输入的安全降级与延迟测量，不代表 provider 质量。

## 记录指标

`benchmarkTranscription` 记录服务端“调用适配器 → 获得结果”的 p50/p95 时间、每轮状态计数、可用率、主文本命中率、前 3 候选命中率、最终 `providerStatus`、完全匹配和中文字符错误率（CER）。真实测试还应单独记录：

- 浏览器截图与编码时间、上传/下载时间、服务端排队时间、模型推理时间（服务商可提供时）；这些不能混为单一“模型速度”。
- 首个本地停笔反馈时间：必须少于 1 秒，且不能等待任何网络或模型。
- 转写可编辑率、用户实际修改比例、前 3 候选命中率、超时/不可用率；没有候选或低质量结果时只允许编辑或明确降级。

推荐先以体验门槛而非模型名决策：本地反馈始终达标；网络可用时比较“停笔至可编辑转写”的 p50/p95；CER、修改率与不可用率共同决定是否接入。结果应写入本地、脱敏的实验记录，不能将原始笔迹或密钥提交到仓库。

当前实验分支已增加 PaddleOCR 3.x 自托管 `/ocr` 响应解析器。它只在服务端同时配置 `VISION_MODEL_PROVIDER=paddleocr` 与 `PADDLEOCR_ENDPOINT` 时启用；请求体为裁剪 PNG 的 Base64 与 `fileType: 1`，并将 `rec_texts` / `rec_boxes` 映射到统一合同。未配置 endpoint 时不发请求，响应异常或超时沿用统一安全降级。

当前实验分支也增加了 PaddleOCR-VL 完整 pipeline 适配器。它只在服务端配置 `PADDLEOCR_VL_ENDPOINT` 时启用，调用官方 `/layout-parsing`，将 `layoutParsingResults[].prunedResult.parsing_res_list[].block_content` 映射为统一转写；可视化和 Markdown 图片请求被关闭，避免把无关二进制结果带回应用。

实验分支还提供一个经典 Tesseract stdin provider 作为轻量基线。它只在服务端配置 `TESSERACT_BIN` 时启用，将 PNG 通过 stdin 交给 `tesseract stdin stdout`，不写临时图像文件；`TESSDATA_PREFIX`、`TESSERACT_LANG` 和 `TESSERACT_PSM` 也只在服务端读取。它不是手写专用模型，结果只用于实验筛选：

```bash
TRANSCRIPTION_BENCH_PROVIDERS=tesseract \
TESSERACT_BIN=/opt/homebrew/bin/tesseract \
TESSERACT_LANG=chi_sim \
TESSDATA_PREFIX=/absolute/path/to/tessdata \
TRANSCRIPTION_BENCHMARK_MANIFEST=/absolute/path/to/manifest.json \
npm run bench:transcription
```

真实 PaddleOCR 基准不使用仓库合同夹具。准备一个仅在本机保存的 JSON 清单（路径相对于清单文件）：

```json
[
  {
    "id": "writer-a-01",
    "expected": "李白写过《将进酒》吗？",
    "imagePath": "writer-a-01.png",
    "metadata": { "writer": "writer-a", "inputMode": "stylus", "orientation": "portrait", "textType": "person-work" }
  }
]
```

`metadata` 只用于实验分层和来源准入，值应使用匿名标签；当前保留 `writer`、`inputMode`、`orientation`、`textType`、`evidence`、`cohortId` 和 `consent`，每项最多 40 个字符。`cohortId` 只能使用字母、数字、点、下划线或连字符。清单中的 PNG 必须位于清单目录内，避免实验脚本意外读取目录外文件。元数据会随逐样本报告透传，原始 PNG 仍只留在本机。

然后在实验分支的服务端运行：

```bash
TRANSCRIPTION_BENCH_PROVIDER=paddleocr \
PADDLEOCR_ENDPOINT=http://127.0.0.1:8080/ocr \
TRANSCRIPTION_BENCHMARK_MANIFEST=/absolute/path/to/manifest.json \
TRANSCRIPTION_BENCH_RUNS=5 \
TRANSCRIPTION_BENCH_WARMUP=1 \
TRANSCRIPTION_BENCH_SHOW_TEXT=1 \
npm run bench:transcription
```

PaddleOCR 官方自托管服务可用 `paddlex --serve --pipeline OCR` 启动；当前适配器对应其 `/ocr` JSON 请求和 `ocrResults[].prunedResult` 响应。样本、密钥和实验结果不进入 Git。

`TRANSCRIPTION_BENCH_WARMUP=0` 用于观察冷启动影响；设置为 `1` 或更高会先调用但不计入统计，用于观察稳态。`TRANSCRIPTION_BENCH_SHOW_TEXT=1` 仅在本机终端显示期望文本和实际转写，默认关闭，避免实验日志意外泄露内容。

VLM 对照实验只在服务端配置以下变量，`VISION_VLM_ENDPOINT` 应填写完整的 Chat Completions 地址（例如本地代理的 `/v1/chat/completions`），不要把 token 放进浏览器或样本清单：

```bash
TRANSCRIPTION_BENCH_PROVIDER=vlm-openai-compatible \
VISION_MODEL_ID=<server-side-model-id> \
VISION_VLM_ENDPOINT=http://127.0.0.1:8000/v1/chat/completions \
VISION_VLM_API_KEY=<server-side-only-token> \
TRANSCRIPTION_BENCHMARK_MANIFEST=/absolute/path/to/manifest.json \
TRANSCRIPTION_BENCH_RUNS=5 \
TRANSCRIPTION_BENCH_WARMUP=1 \
TRANSCRIPTION_BENCH_SHOW_TEXT=1 \
npm run bench:transcription
```

适配器要求模型只返回 `{ "text": "...", "candidates": ["..."] }`；若模型返回普通文本，也只会作为待确认文本保留。它不使用模型输出的日期、来源或人物关系，因此不会扩大证据边界。

PaddleOCR-VL 的本地完整 pipeline 可按官方文档用 `paddlex --serve --pipeline PaddleOCR-VL` 启动；服务端 endpoint 通常是 `http://127.0.0.1:8080/layout-parsing`。官方说明本地快速验证可能较慢，因此必须把模型下载/加载与稳态推理分开记录。[官方 PaddleOCR-VL 服务说明](https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/PaddleOCR-VL.html)

真实对照时可以用矩阵模式让多个 provider 串行使用同一份样本、`runs` 和 `warmup`：

```bash
TRANSCRIPTION_BENCH_PROVIDERS=paddleocr,vlm-openai-compatible \
TRANSCRIPTION_BENCHMARK_MANIFEST=/absolute/path/to/manifest.json \
TRANSCRIPTION_BENCH_RUNS=5 \
TRANSCRIPTION_BENCH_WARMUP=1 \
npm run bench:transcription
```

矩阵模式仍然只在服务端调用 provider；每个 provider 的报告单独打印，避免把不可用结果或合同夹具混入另一个 provider 的准确率。

需要保存可复核的本地结果时，额外指定输出路径；它只写 JSON 报告，不复制 PNG。默认报告不写入逐条人工校对文本或 provider 实际转写，只保留匿名 ID、状态、质量和延迟摘要；若必须在本机调试文本，才显式设置 `TRANSCRIPTION_BENCH_SHOW_TEXT=1`：

```bash
TRANSCRIPTION_BENCH_OUTPUT=/tmp/shangtu-transcription-report.json \
npm run bench:transcription
```

报告顶层 `textIncluded` 会记录是否启用了文本输出；未设置 `TRANSCRIPTION_BENCH_SHOW_TEXT=1` 时为 `false`。含文本的调试报告必须留在受控本机目录，不能提交 Git 或上传第三方服务。

输出文件包含 provider、样本数、轮数、warmup、期望文本和实际转写。该文件可能包含手写内容，必须保留在本机或受控实验目录，不要提交 Git。

矩阵报告还会为每个 provider 输出 `summary`：`meanCharacterErrorRate`、`meanExactRate`、`meanCandidateHitRate`、`meanOkRate`、`meanP50Ms`、`meanP95Ms`、`sampleExactRate`、`sampleCandidateHitRate`、`sampleExactAtLeastOnceRate`、`sampleExactStableRate`、`sampleCandidateHitStableRate`、`totalRuns` 与 `statusCounts`。质量和延迟比率按样本平均，避免长句因为字符更多而在 provider 比较中占更大权重；`sampleExactRate` 表示最后一轮完全命中的样本比例，`sampleExactAtLeastOnceRate` 表示至少一轮完全命中的比例，`sampleExactStableRate` 表示每一轮都完全命中的比例；`sampleCandidateHitRate` 表示至少一轮候选命中的比例，`sampleCandidateHitStableRate` 表示每一轮都有候选命中。最终选择应优先看稳定率，同时保留偶发命中率以识别服务波动。`statusCounts` 用于单独识别超时、不可用和未配置，不应把失败样本当作识别错误计算 CER。

当前实现对这一点做了硬约束：若样本最后一次调用没有得到有效转写，逐样本 `exact` 与 `characterErrorRate` 为 `null`；`okRate`、`statusCounts`、p50/p95 仍然保留。这样“服务没有在 8 秒内回答”和“服务回答了但识别错误”不会混为同一类质量失败。

## 本地管线基线（2026-08-12）

以下结果来自本机 CPU 服务和临时合成 PNG，仅用于确认管线、错误边界与延迟统计，**不代表真实手写识别准确率**：

- 打印体中文句子，稳态 `warmup=1`、`runs=3`：实际结果漏掉开头“李”，CER `0.0909`，p50 约 `991 ms`，p95 约 `997 ms`。
- 合成数字墨迹“李白”，稳态 `warmup=1`、`runs=3`：实际结果为“杜日”，CER `1.0`，p50 约 `577 ms`，p95 约 `580 ms`。
- 同一打印体中文句子、同一 macOS ARM64 CPU venv、同一 manifest 的真实矩阵（`warmup=1`、`runs=3`）：PaddleOCR CER `0.0909`、exact `false`、p50 约 `1391 ms`、p95 约 `1474 ms`；PaddleOCR-VL CER `0`、exact `true`、p50 约 `4504 ms`、p95 约 `5007 ms`。
- 同一合成数字墨迹“李白”的真实矩阵（`warmup=1`、`runs=3`）：PaddleOCR 输出“杜日”，CER `1.0`、exact `false`、p50 约 `516 ms`、p95 约 `547 ms`；PaddleOCR-VL 输出“ネと ぐ”，CER `2.0`、exact `false`、p50 约 `3584 ms`、p95 约 `3586 ms`。
- 6 条行楷合成套件（`warmup=1`、`runs=2`）：PaddleOCR 6/6 可用、0/6 exact、平均 CER `0.171`、平均 p50 约 `547 ms`、0 次超时；PaddleOCR-VL 3/6 exact、平均 CER `0.500`、平均 p50 约 `5975 ms`，12 次计数运行中有 5 次超时，候选命中覆盖 4/6 样本。

## 公开样本准入探查（2026-08-13）

PaddleOCR 官方数据集页面列出了 CASIA 中文手写数据集，并展示了 `CASIA_0.jpg` 样例；该页面描述了数据集规模和数据类型，但样例页面没有提供可直接用于句子级 CER 的人工目标文本。将该公开示例转换为 PNG 后做了一次管线探查：PaddleOCR 返回了文本，但没有 ground truth 可核对；PaddleOCR-VL 将整张窄图判为 `image` 布局块，`block_content` 为空，因此按统一适配器安全降级为不可用。该样例未进入 benchmark，也未复制到仓库或实验报告；后续公开数据只有在图像与人工标签一一对应时才可纳入质量比较。[PaddleOCR 中文手写数据集说明](https://www.paddleocr.ai/v3.0.0/en/datasets/handwritten_datasets.html) · [官方 CASIA 示例图](https://www.paddleocr.ai/v3.0.0/datasets/images/CASIA_0.jpg)

## 本机复跑记录（2026-08-13）

同一 6 条行楷合成套件、同一 macOS ARM64 CPU 环境、`warmup=1`、`runs=2` 的一次复跑中：PaddleOCR 12/12 可用、0/6 样本 exact、平均 CER `0.1712`、平均 p50 `517.7 ms`、平均 p95 `528.3 ms`；PaddleOCR-VL 12/12 可用、6/6 样本 exact、平均 CER `0`、平均 p50 `3162.3 ms`、平均 p95 `3259.1 ms`。本次复跑未出现超时，但与上一条记录的 PaddleOCR-VL 超时率不同，因此只能说明服务状态和负载会影响测量，不能据此替代真实手写样本或直接选择生产 provider。原始 JSON 报告保留在本机 `/tmp/shangtu-synthetic-rerun-20260813.json`，未进入 Git。

这些矩阵仍只有临时打印体、合成数字墨迹和行楷合成套件，不能作为真实手写或生产决策；历史记录与复跑记录共同说明，provider 的相对质量和延迟会随样本、服务状态与负载变化。下一轮必须使用获得明确同意的真实手写样本，并在同一清单、同一轮数和同一服务端条件下比较，在此之前不选择任何 provider 作为最终生产方案。

## 公开真实手写基线

CASIA-OLHWDB 官方提供带行级标签的联机文本测试包；WPTT 文件同时包含笔划轨迹、行分割和 GB 编码的行标签。它适合先验证服务端适配器在真实手写上的可用率、准确率和延迟，但不代表本项目用户在华为平板上的笔迹分布，也不能替代获得同意的用户样本。[CASIA 联机数据库格式说明](https://nlpr.ia.ac.cn/databases/handwriting/Online_database.html) · [官方数据下载页](https://nlpr.ia.ac.cn/databases/handwriting/Download.html)

为了避免把整套数据或原始笔划提交到 Git，可用明确指定的本机 ZIP 抽取少量不同书写者的 PNG 和 manifest：

```bash
CASIA_DIR=/tmp/shangtu-casia-samples
python3 server/prepare-casia-wptt-samples.py \
  --zip /absolute/path/to/WPTT2.2-Test.zip \
  --output-dir "$CASIA_DIR" \
  --writers 741,742,743,744,745,746,747,748,749,750 \
  --page P14 \
  --scale 1.5
```

`--scale` 是明确的输入预处理变量；同一轮比较必须保持不变。默认值为 `3`，若服务端在统一 8 秒边界内无法完成，可另建一个实验目录用 `1.5` 等档位重跑，并把尺寸与超时率一起记录，不能只报告更快的结果。

随后可用与其他实验完全相同的矩阵命令运行。清单中的 `metadata.writer` 使用匿名公开数据标签 `public-casia-*`，结果与用户样本、合成样本分开解释：

```bash
TRANSCRIPTION_BENCH_PROVIDERS=paddleocr,paddleocr-vl \
TRANSCRIPTION_BENCHMARK_MANIFEST="$CASIA_DIR/manifest.json" \
TRANSCRIPTION_BENCH_RUNS=3 \
TRANSCRIPTION_BENCH_WARMUP=1 \
TRANSCRIPTION_BENCH_PREPROCESSING=casia-scale-1_5 \
TRANSCRIPTION_BENCH_RUN_ID=casia-stable-20260813 \
TRANSCRIPTION_BENCH_SHOW_TEXT=1 \
npm run bench:transcription
```

公开数据只用于本地实验，需遵守数据提供方的研究使用条件；PNG、manifest 和报告都不得提交仓库。

若用 `--scale 3` 另建公开 cohort，必须把标签改为 `TRANSCRIPTION_BENCH_PREPROCESSING=casia-scale-3`，并使用新的 `TRANSCRIPTION_BENCH_RUN_ID`；不同预处理或不同轮次不能混在同一次比较中。历史报告没有这些字段，会被比较器按 `unknown` 处理，不应与新轮次拼接。

### CASIA 首轮结果（2026-08-13）

使用官方 `WPTT2.2-Test.zip` 中 741–750 共 10 位书写者、每人 `P14` 第一条有效行，统一使用 `--scale 1.5` 生成约 918 像素宽的 PNG 和同一份 manifest。服务端串行运行，PaddleOCR 先完成后停止 PaddleOCR-VL，避免 CPU 争用影响延迟：

| Provider | 运行 | 可用率 | CER | exact / 候选命中 | p50 / p95 |
| --- | --- | ---: | ---: | ---: | ---: |
| PaddleOCR | warmup=1, runs=3, 30 次 | 30/30 | 0.3265 | 0/10 / 0/10 | 628.3 / 693.7 ms |
| PaddleOCR-VL | warmup=0, runs=1, 10 次 | 0/10 | 不适用 | 不适用 | 8014.5 / 8014.5 ms |

PaddleOCR-VL 的 10 次均为 `timed_out`，没有把空结果计算成 CER；这只是当前 macOS CPU 自托管服务在本项目 8 秒边界下的准入失败，不等于模型在更强硬件或优化部署上的最终质量。PaddleOCR 的这 10 条公开行也没有 exact 或前 3 候选命中，因此当前只能作为“可用且有一定字符级接近度”的实验候选，不能直接作为生产方案。报告保留在本机临时目录，未提交仓库。

### provenance 门禁复跑（2026-08-13）

使用当前 CASIA 导入器重新生成的同一 10 条 `P14` 行、同一 `scale=1.5` 清单；清单每条样本均带 `evidence=public_casia` 和 `cohortId=casia-olhwdb2.2-p14-scale-1_5`。PaddleOCR 与 Tesseract 在同一台机器上串行运行，均为 `warmup=1`、`runs=3`：

| Provider | 可用率 | CER | exact / 候选命中 | p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| PaddleOCR | 30/30 | 0.3265 | 0/10 / 0/10 | 454.0 / 455.4 ms |
| Tesseract | 27/30 | 0.8895 | 0/10 / 0/10 | 93.6 / 94.7 ms |

比较报告保留了 `public_casia` 和 cohort ID，并输出 `insufficient_evidence`、`recommendedProvider=null`；这验证了真实公开报告可以进入同一比较器，同时不会越过用户样本证据门槛。报告保留在本机 `/tmp/shangtu-casia-public-provenance-*.json`，未提交仓库。

### 三 provider 同条件矩阵（2026-08-13）

为观察质量与速度的实际 trade-off，又在同一 `casia-olhwdb2.2-p14-scale-1_5` cohort 上让三个 provider 各运行 1 次（`warmup=0`，共 10 条公开行）：

| Provider | 可用率 | CER | exact / 候选命中 | p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| PaddleOCR | 10/10 | 0.3265 | 0/10 / 0/10 | 465.8 / 465.8 ms |
| PaddleOCR-VL | 10/10 | 0.0810 | 0/10 / 0/10 | 4014.4 / 4014.4 ms |
| Tesseract | 9/10 | 0.8895 | 0/10 / 0/10 | 94.1 / 94.1 ms |

这组数据仅说明当前 CPU 自托管环境下的工程取舍：PaddleOCR-VL 字符级接近度最好但明显更慢，Tesseract 最快但质量和可用率不足，PaddleOCR 位于两者之间。比较器仍输出 `public_casia / insufficient_evidence / recommendedProvider=null`；下一步必须用获得明确同意的平板真实笔迹复核，并同时观察用户修改率与“停笔至可编辑转写”时延。矩阵报告保留在本机 `/tmp/shangtu-casia-public-provenance-matrix-1x-20260813.json`，未提交仓库。

### 三 provider 稳态矩阵（2026-08-13）

在同一 `casia-olhwdb2.2-p14-scale-1_5` cohort、同一服务端机器和同一 `warmup=1/runs=3` 条件下，补齐 PaddleOCR-VL 的 30 次稳态调用，并与已有同条件 PaddleOCR、Tesseract 报告进行严格比较：

| Provider | 可用率 | CER | exact / 候选稳定命中 | p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| PaddleOCR | 30/30 | 0.3265 | 0/10 / 0/10 | 454.0 / 455.4 ms |
| PaddleOCR-VL | 30/30 | 0.0810 | 0/10 / 0/10 | 4262.9 / 4430.3 ms |
| Tesseract | 27/30 | 0.8895 | 0/10 / 0/10 | 93.6 / 94.7 ms |

稳态结果确认了同一工程取舍：PaddleOCR-VL 在这组公开行上 CER 最低，但端到端延迟约为 PaddleOCR 的 9.4 倍；Tesseract 延迟最低，却有 10% 不可用且 CER 明显偏高。比较器输出仍为 `public_casia / insufficient_evidence / recommendedProvider=null`，因此本轮只形成候选排序依据，不形成生产选型。稳态比较报告保留在本机 `/tmp/shangtu-casia-public-provenance-stable-matrix-20260813.json`，未提交仓库。

### provenance 完整稳态复跑（2026-08-13）

为让三份报告的来源链可逐字段复核，又用同一 `casia-olhwdb2.2-p14-scale-1_5` 公开 cohort 重跑三种 provider；本轮统一写入 `evidence=public_casia`、`preprocessing=casia-scale-1_5` 和 `runId=casia-stable-20260813-r2`，仍为 `warmup=1`、`runs=3`。三份报告的 10 个 sample ID、运行次数和预处理标签完全一致：

| Provider | 可用率 | CER | exact / 候选稳定命中 | p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| PaddleOCR | 30/30 | 0.3265 | 0/10 / 0/10 | 454.2 / 455.7 ms |
| PaddleOCR-VL | 30/30 | 0.0810 | 0/10 / 0/10 | 4433.8 / 4813.8 ms |
| Tesseract | 27/30 | 0.8895 | 0/10 / 0/10 | 111.1 / 113.9 ms |

严格比较输出 `public_casia / insufficient_evidence / recommendedProvider=null`。因此本轮只确认了可复现的质量—延迟差异：PaddleOCR-VL 的 CER 最低但 p50 约为 PaddleOCR 的 9.8 倍，Tesseract 最快但质量和可用率不足；不能据此替代同意用户的平板真实笔迹实验。报告只保留在本机 `/tmp/shangtu-casia-public-provenance-*-r2.json`，未提交仓库。

### 最小公开数据复跑（2026-08-13）

为把当前实验真正跑通，又从官方 `WPTT2.2-Test.zip` 重新抽取 741–750 共 10 位书写者的 `P14` 第一条有效行；每位书写者 1 条、共 10 条真实中文手写文本，统一使用 `scale=1.5`、同一 manifest、`warmup=1`、`runs=3` 和 `runId=casia-experiment-20260813`。本轮服务环境为 macOS ARM64 CPU，Paddle 3.3.1 / PaddleOCR 3.3.2 / PaddleX 3.3.13，Tesseract 5.5.3；三份报告的样本 ID、cohort、预处理和运行参数均一致。

| Provider | 可用率 | CER | exact / 稳定候选命中 | p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| PaddleOCR | 30/30 | 0.5458 | 0/10 / 0/10 | 635.8 / 678.6 ms |
| Tesseract (`chi_sim`) | 30/30 | 1.2544 | 0/10 / 0/10 | 138.9 / 187.2 ms |
| PaddleOCR-VL | 0/30 | 不适用 | 不适用 | 8064.1 / 8257.4 ms |

本轮说明：PaddleOCR 是当前三个候选中唯一同时具有可用结果和相对可接受字符接近度的基线；Tesseract 只能作为速度下限，中文手写质量不足；PaddleOCR-VL 在本机 CPU 和项目 8 秒服务边界内全部超时，因此当前部署不能满足“停笔后出现可编辑转写”的体验门槛。严格比较器仍输出 `public_casia / insufficient_evidence / recommendedProvider=null`；这是公开数据上的工程筛选结果，不是生产 provider 选择。原始 PNG、manifest 和报告保留在本机 `/tmp/shangtu-casia-*`，未提交仓库。

### 采样路径 UI smoke（2026-08-13）

使用本地浏览器模拟两段短笔划验证边界：`/?experiment=transcription` 在书写并停笔后显示匿名实验导出旁批，可下载当前样本 PNG 和时延 JSON；默认 `/?demo=evidence` 不显示实验导出控件；切换到“静读”后继续书写并等待，不显示停笔反馈或转写旁批。此次运行未配置视觉 provider，因此实验页显示安全降级提示；笔划由浏览器 CUA 模拟，不代表华为平板触控笔/手指真机通过，也未将其样本或报告提交仓库。

### 前端完整链路合同演练（2026-08-13）

在隔离端口以 `NOTEBOOK_FIXTURE_MODE=1` 启动 Vite，使用浏览器模拟笔划并等待停笔反馈：页面先出现“演练转写（未调用视觉模型）”及可编辑确认框，确认文本为 `李白写过《将进酒》吗？`；点击“以此寻迹”后，页面出现“当前图谱记录：李白是《将进酒》的作者。”、路径 `李白 → 作者 → 将进酒` 和固定来源链接。该演练证明截图请求、用户确认和受限寻迹之间的顺序边界；它不测量视觉模型准确率，也不代表华为平板真机体验，输入和结果均未提交仓库。

### PaddleOCR 前端接入 smoke（2026-08-13）

在隔离 Vite 端口仅由服务端配置 `VISION_MODEL_PROVIDER=paddleocr` 和本机 `PADDLEOCR_ENDPOINT`，浏览器模拟笔划后实际收到 PaddleOCR 返回的 `+米`，页面显示“机器转写，请在纸页边确认”；点击确认后，因 Pi 未配置而显示“转写已确认；寻迹内核尚未配置，因此没有生成旁批”。该运行证明真实 provider 结果仍需用户确认，Pi 不可用时不会伪造旁批，原始笔迹继续保留；`+米` 来自合成笔划，不能作为质量指标。浏览器未接触 endpoint、模型配置或凭据，输入和结果均未提交仓库。

同一隔离端口 smoke 还确认实验页在停笔后显示一个 12 位匿名 `sampleId`，并同时显示样本 PNG 与 timing JSON 两个导出入口；两个导出文件名及 timing JSON 共用该 ID。此前已运行的旧实验页面可能被开发 service worker 缓存，验证新版本时应改用新隔离端口或清除本地开发缓存；这不影响生产默认入口。

### 输入缩放敏感性（2026-08-13）

在同一台机器、同一 10 条公开行、同一 PaddleOCR 服务和 `warmup=1`、`runs=3` 条件下，仅改变导入器的 `--scale`：

| 输入缩放 | 可用率 | 平均 CER | 平均 p50 / p95 | exact / 候选命中 |
| ---: | ---: | ---: | ---: | ---: |
| 1.5× | 30/30 | 0.3265 | 628.3 / 693.7 ms | 0/10 / 0/10 |
| 3× | 30/30 | 0.3738 | 778.7 / 782.3 ms | 0/10 / 0/10 |

在这组公开样本上，1.5× 相对 3× 的 p50 低 `150.4 ms`，CER 低 `0.0473`；但这只是当前渲染方式和 CPU 服务的局部结果。它支持把较小输入作为后续实验候选预处理，而不是证明 1.5× 对华为平板真实裁剪笔迹普遍更优。最终仍须用同一批获得同意的真实样本复核，并同时观察用户修改率和候选命中率。

### Tesseract 经典 OCR 准入结果（2026-08-13）

使用同一批 10 位公开书写者、同一 1.5× PNG 和 `chi_sim` 模型，通过统一 adapter 的 stdin provider、`--psm 7`、`warmup=1`、`runs=3` 运行：30 次中 27 次 `ready`、3 次 `unavailable`，平均可用率 `0.9`；可用最终结果的平均 CER `0.8895`，exact `0/10`、候选命中 `0/10`，平均 p50 `92.3 ms`、p95 `103.1 ms`。它的速度明显快于 PaddleOCR，但手写质量不足，因此当前不进入生产候选；仍保留在统一 adapter 供后续在真实用户样本上复核。原始报告只保留在本机 `/tmp/shangtu-casia-public-tesseract-20260813.json`，未提交仓库。

## 运行合同夹具

```bash
npm run bench:transcription
```

未来接入候选服务商时，调用同一个 `benchmarkTranscription({ cases, transcribe })`，其中 `transcribe` 只在服务端装配凭据。先在夹具中确认返回合同与超时，再用上述经同意样本做实际质量和延迟比较。
