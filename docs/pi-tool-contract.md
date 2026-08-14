# Pi 工具合同

Pi 不是开放式文件/网络代理。产品运行时只允许四个工具：

1. `clarify_entity`：对歧义手写实体返回候选；不得静默选择。
2. `retrieve_cnkgraph`：取得有界、可回溯的 CNKGraph 证据路径。
3. `validate_evidence`：没有来源引用的事实性旁批不得通过。
4. `compose_annotation`：写出不超过 120 字的纸页旁批，类型只能是证据、联想、澄清或证据缺口。

Pi 初始化显式禁用内建 coding tools、自动发现的扩展/skills/项目上下文；运行时还会核验实际激活工具是否恰为以上四个。模型凭据尚未配置时，Pi 会话不得启动；纸页本地“识字中”反馈仍可运行。浏览器只把当前笔迹区域 PNG 交给服务端 `/api/transcribe`，收到机器转写后由用户在纸页边编辑确认；服务端 `/api/seek` 才把确认转写与同一 PNG 交给 Pi。浏览器不持有模型、视觉模型或 CNKGraph 凭据。

在填入任何真实模型认证前，可在受控服务端运行 `npm run preflight:pi`。它只检查 `PI_MODEL_PROVIDER`/`PI_MODEL_ID` 是否命中本地 Pi catalog，以及该 provider 是否发现已知的服务端认证环境变量；不会读取或输出凭据值，也不会发起模型请求。`pi_ready_for_controlled_call` 只表示静态配置可进入下一步受控测试，不代表模型、来源或纸面事实已验证。需要同时核对 OCR、Pi 和图谱 gateway 时运行 `npm run preflight:services`；它只输出每一层的非敏感就绪状态，绝不输出 endpoint、项目 ID、token 或 API key，也不会发起网络调用。

`/api/transcribe` 的成功响应固定为 `{ status: "ok", transcription, providerStatus }`。`transcription.text` 是待确认主文本，`candidates` 是至多三个不同的备选文本，`lines`（如服务商提供）只包含相对于裁剪 PNG 的 `0–1` 行框与行文本。`providerStatus` 只表达 `fixture`、`ready`、`unconfigured`、`not_implemented`、`rejected`、`unavailable` 或 `timed_out` 等非敏感运行状态；不得返回密钥、供应商请求详情或原始模型推理。真实服务调用必须经过服务端 8 秒限时包装，并接收 `AbortSignal`；超时返回 `vision_timed_out`，调用异常或无效结果返回 `vision_unavailable`。失败也必须返回明确状态，不能编造转写。

速度优先实验候选 `huawei-handwriting` 只在服务端同时配置 `HUAWEI_OCR_ENDPOINT`、`HUAWEI_OCR_PROJECT_ID` 与短期 `HUAWEI_OCR_AUTH_TOKEN` 时启用。它通过华为云 REST 的 `X-Auth-Token` 头提交当前笔迹段裁剪 PNG 的**原始 Base64**，支持 `general` 与 `digit` 字符集；`HUAWEI_OCR_QUICK_MODE` 默认 `0`，只有确认是单行且文字占比足够高的紧裁剪段时才可显式设为 `1`。适配器把 `words_block_list` 的文字和相对行框收敛为可编辑转写，token、endpoint、项目 ID、供应商错误详情和原始推理均不会返回浏览器、Pi 或日志。未配置时不发起请求并返回 `vision_unconfigured`；本仓库不提供真实凭据，也不将 fixture 当作模型回退。

实验分支可选的 `vlm-openai-compatible` provider 只在服务端读取 `VISION_VLM_ENDPOINT`、`VISION_VLM_API_KEY` 和 `VISION_MODEL_ID`，向兼容 Chat Completions 的视觉接口发送当前 PNG；密钥不会进入浏览器、日志或转写响应。模型结果只作为可编辑机器转写，不能直接触发寻迹或写入事实旁批。

实验分支也支持服务端自托管的 `paddleocr-vl` provider；它只向配置的 `PADDLEOCR_VL_ENDPOINT`（官方完整 pipeline 的 `/layout-parsing`）发送当前 PNG，响应中的 `parsing_res_list[].block_content` 只作为可编辑机器转写。该 provider 不把 PaddleOCR-VL 的 Markdown、布局事实或视觉输出直接交给 Pi。

实验分支还支持 `tesseract` 经典 OCR provider；它只在服务端读取 `TESSERACT_BIN`、`TESSDATA_PREFIX`、`TESSERACT_LANG` 和可选的 `TESSERACT_PSM`，将当前 PNG 字节通过 Tesseract stdin 处理，不写临时图像文件。仅 stdout 的纯文本会进入统一可编辑转写合同；进程错误、空输出或超时均安全降级，Tesseract 不获得 Pi 工具、CNKGraph 或浏览器凭据。

Pi 的文本输出只是提案，永远不能直接落页。服务端只接受 JSON 的 `evidence`、`clarification` 或 `evidence_gap` 分支：证据分支必须逐项匹配本次有界子图的 `sourceIds` 和 `path`，而事实正文由匹配到的图谱边确定性生成；任何 JSON、来源或路径不匹配均降级为证据缺口。模型补充仅作为 `association` 接收，并由服务端强制加上“联想：”；其中含年代、出处、馆藏、作者等事实性标记的文本会被丢弃。

当前仓库包含只读 `李白 → 作者 → 将进酒` CNKGraph 子图夹具，仅用于 `NOTEBOOK_FIXTURE_MODE=1` 的离线演示与合同测试。夹具内置固定版本的公开文本来源，并对夹具外查询返回“证据缺口”；它不依赖旧项目目录。正常模式没有注入正式检索器时在启动 Pi 前返回 `graph_unconfigured`，绝不回退或伪装成该演练图谱。正式版本替换该检索器，但必须保持相同的来源和有界路径语义。

正式图谱 provider（包括未来的搜韵接入）必须只由服务端的 request-scoped retriever 调用：输入仅为用户已确认的短文本或实体，不包含 PNG、原始笔迹、Pi prompt 或用户历史；同一次 `/api/seek` 内 Pi 的 `retrieve_cnkgraph` 与最终证据核验共用缓存，不能重复对外检索。接入前必须具备 endpoint/认证的最小权限、使用与展示条款，以及每条边对应的稳定来源 ID、可展示 claim 和永久 URL；否则维持 `graph_unconfigured`，不发请求。外部检索还必须限制为最多 2 跳、8 节点、8 边、4 个来源，并将无授权、超时、限流、网络/格式错误与“上游明确无结果”区分处理，不能把系统故障伪装成证据缺口。具体交接字段和验收见 [搜韵 CNKGraph Gateway 合同](./souyun-cnkgraph-gateway-contract.md)。

开发者可在**服务端**设置 `NOTEBOOK_FIXTURE_MODE=1`，演练完整的 Canvas 截图、可编辑确认与受限寻迹链路。该模式只返回固定演练转写并生成受控 JSON 提案：不调用视觉模型、Pi 模型或网络，浏览器会明确标注“演练转写（未调用视觉模型）”。它不是模型回退，也不得用于真实用户回应；不设置时，视觉与 Pi 仍按各自的未配置状态安全降级。
