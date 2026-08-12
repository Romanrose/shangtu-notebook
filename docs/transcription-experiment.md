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

同一实验路径还提供“下载时延 JSON”。它只包含 `schema`、页码，以及相对停笔时刻的匿名事件：`pen_up`、`local_awakening`、`transcription_request`、`transcription_result`，后者附带非敏感的 `status`/`providerStatus`。它不包含转写文本、PNG、URL、凭据或请求体，可将同一笔迹在不同 provider 下的“停笔 → 本地苏醒”和“停笔 → 服务端结果”分开比较。静读模式与默认 URL 不生成该记录。

也可以把准备好的 PNG 放进一个专用本机目录后运行标注助手（不要直接把 Downloads 作为目录）：

```bash
TRANSCRIPTION_SAMPLE_DIR=/absolute/path/to/handwriting-samples \
TRANSCRIPTION_MANIFEST_OUTPUT=/absolute/path/to/handwriting-samples/manifest.json \
TRANSCRIPTION_SAMPLE_METADATA='{"writer":"writer-a","inputMode":"stylus","orientation":"portrait"}' \
npm run prepare:transcription-manifest
```

命令会按文件名排序，逐张要求输入人工校对文本；空文本、非 PNG、目录外路径和超长文本都会被拒绝。生成的 manifest 与 PNG 一起留在本机，随后可直接交给 `TRANSCRIPTION_BENCHMARK_MANIFEST`。

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

`metadata` 只用于实验分层，值应使用匿名标签；当前保留 `writer`、`inputMode`、`orientation` 和 `textType`，每项最多 40 个字符。清单中的 PNG 必须位于清单目录内，避免实验脚本意外读取目录外文件。元数据会随逐样本报告透传，原始 PNG 仍只留在本机。

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

需要保存可复核的本地结果时，额外指定输出路径；它只写 JSON 报告，不复制 PNG：

```bash
TRANSCRIPTION_BENCH_OUTPUT=/tmp/shangtu-transcription-report.json \
npm run bench:transcription
```

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
TRANSCRIPTION_BENCH_SHOW_TEXT=1 \
npm run bench:transcription
```

公开数据只用于本地实验，需遵守数据提供方的研究使用条件；PNG、manifest 和报告都不得提交仓库。

### CASIA 首轮结果（2026-08-13）

使用官方 `WPTT2.2-Test.zip` 中 741–750 共 10 位书写者、每人 `P14` 第一条有效行，统一使用 `--scale 1.5` 生成约 918 像素宽的 PNG 和同一份 manifest。服务端串行运行，PaddleOCR 先完成后停止 PaddleOCR-VL，避免 CPU 争用影响延迟：

| Provider | 运行 | 可用率 | CER | exact / 候选命中 | p50 / p95 |
| --- | --- | ---: | ---: | ---: | ---: |
| PaddleOCR | warmup=1, runs=3, 30 次 | 30/30 | 0.3265 | 0/10 / 0/10 | 628.3 / 693.7 ms |
| PaddleOCR-VL | warmup=0, runs=1, 10 次 | 0/10 | 不适用 | 不适用 | 8014.5 / 8014.5 ms |

PaddleOCR-VL 的 10 次均为 `timed_out`，没有把空结果计算成 CER；这只是当前 macOS CPU 自托管服务在本项目 8 秒边界下的准入失败，不等于模型在更强硬件或优化部署上的最终质量。PaddleOCR 的这 10 条公开行也没有 exact 或前 3 候选命中，因此当前只能作为“可用且有一定字符级接近度”的实验候选，不能直接作为生产方案。报告保留在本机临时目录，未提交仓库。

## 运行合同夹具

```bash
npm run bench:transcription
```

未来接入候选服务商时，调用同一个 `benchmarkTranscription({ cases, transcribe })`，其中 `transcribe` 只在服务端装配凭据。先在夹具中确认返回合同与超时，再用上述经同意样本做实际质量和延迟比较。
