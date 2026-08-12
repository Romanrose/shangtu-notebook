# Pi 工具合同

Pi 不是开放式文件/网络代理。产品运行时只允许四个工具：

1. `clarify_entity`：对歧义手写实体返回候选；不得静默选择。
2. `retrieve_cnkgraph`：取得有界、可回溯的 CNKGraph 证据路径。
3. `validate_evidence`：没有来源引用的事实性旁批不得通过。
4. `compose_annotation`：写出不超过 120 字的纸页旁批，类型只能是证据、联想、澄清或证据缺口。

Pi 初始化显式禁用内建 coding tools、自动发现的扩展/skills/项目上下文；运行时还会核验实际激活工具是否恰为以上四个。模型凭据尚未配置时，Pi 会话不得启动；纸页本地“识字中”反馈仍可运行。浏览器只把当前笔迹区域 PNG 交给服务端 `/api/transcribe`，收到机器转写后由用户在纸页边编辑确认；服务端 `/api/seek` 才把确认转写与同一 PNG 交给 Pi。浏览器不持有模型、视觉模型或 CNKGraph 凭据。

`/api/transcribe` 的成功响应固定为 `{ status: "ok", transcription, providerStatus }`。`transcription.text` 是待确认主文本，`candidates` 是至多三个不同的备选文本，`lines`（如服务商提供）只包含相对于裁剪 PNG 的 `0–1` 行框与行文本。`providerStatus` 只表达 `fixture`、`ready`、`unconfigured`、`not_implemented`、`rejected`、`unavailable` 或 `timed_out` 等非敏感运行状态；不得返回密钥、供应商请求详情或原始模型推理。真实服务调用必须经过服务端 8 秒限时包装，并接收 `AbortSignal`；超时返回 `vision_timed_out`，调用异常或无效结果返回 `vision_unavailable`。失败也必须返回明确状态，不能编造转写。

实验分支可选的 `vlm-openai-compatible` provider 只在服务端读取 `VISION_VLM_ENDPOINT`、`VISION_VLM_API_KEY` 和 `VISION_MODEL_ID`，向兼容 Chat Completions 的视觉接口发送当前 PNG；密钥不会进入浏览器、日志或转写响应。模型结果只作为可编辑机器转写，不能直接触发寻迹或写入事实旁批。

实验分支也支持服务端自托管的 `paddleocr-vl` provider；它只向配置的 `PADDLEOCR_VL_ENDPOINT`（官方完整 pipeline 的 `/layout-parsing`）发送当前 PNG，响应中的 `parsing_res_list[].block_content` 只作为可编辑机器转写。该 provider 不把 PaddleOCR-VL 的 Markdown、布局事实或视觉输出直接交给 Pi。

实验分支还支持 `tesseract` 经典 OCR provider；它只在服务端读取 `TESSERACT_BIN`、`TESSDATA_PREFIX`、`TESSERACT_LANG` 和可选的 `TESSERACT_PSM`，将当前 PNG 字节通过 Tesseract stdin 处理，不写临时图像文件。仅 stdout 的纯文本会进入统一可编辑转写合同；进程错误、空输出或超时均安全降级，Tesseract 不获得 Pi 工具、CNKGraph 或浏览器凭据。

Pi 的文本输出只是提案，永远不能直接落页。服务端只接受 JSON 的 `evidence`、`clarification` 或 `evidence_gap` 分支：证据分支必须逐项匹配本次有界子图的 `sourceIds` 和 `path`，而事实正文由匹配到的图谱边确定性生成；任何 JSON、来源或路径不匹配均降级为证据缺口。模型补充仅作为 `association` 接收，并由服务端强制加上“联想：”；其中含年代、出处、馆藏、作者等事实性标记的文本会被丢弃。

当前仓库包含只读 `李白 → 作者 → 将进酒` CNKGraph 子图夹具，仅用于离线演示与合同测试。夹具内置固定版本的公开文本来源，并对夹具外查询返回“证据缺口”；它不依赖旧项目目录。正式版本替换该检索器，但必须保持相同的来源和有界路径语义。

开发者可在**服务端**设置 `NOTEBOOK_FIXTURE_MODE=1`，演练完整的 Canvas 截图、可编辑确认与受限寻迹链路。该模式只返回固定演练转写并生成受控 JSON 提案：不调用视觉模型、Pi 模型或网络，浏览器会明确标注“演练转写（未调用视觉模型）”。它不是模型回退，也不得用于真实用户回应；不设置时，视觉与 Pi 仍按各自的未配置状态安全降级。
