# 时空探索手札

面向华为平板的触控优先 PWA。用户直接在纸页上手写人物、地点、经历或作品；系统在服务端完成转写、受控图谱检索和证据核验，再把结果以纸上旁批、寻迹卡和可收纳印章呈现出来。

纸页始终是主界面：没有聊天窗口，也不会把图谱作为默认页面。原始笔迹由本地页面存储，机器转写只是一份可编辑的确认稿。

## 当前能力

- 人物起笔：输入并确认人物名后，显示受限人物档案、朝代、生卒、籍贯和来源。
- 路线寻迹：选择地点、经历或作品路线；作品路线可先展示该人物的有界作品候选。
- 证据旁批：只展示有来源、可回溯路径的关系、时间线和原文时间词；点按可展开寻迹卡。
- 安全降级：歧义必须点选，查无证据必须显示缺口；模型补充固定标为“联想：”。
- PWA 纸页：支持手写、翻页、续页、当前页清空、原笔迹保存和“收为印”。

## 架构总览

```mermaid
flowchart LR
  A[华为平板 PWA\n纸页与原始笔迹] -->|PNG 笔迹段| B[/api/transcribe]
  B --> C[服务端 OCR 适配器]
  C -->|可编辑转写| A
  A -->|用户确认文本 + 旅程上下文| D[/api/seek]
  D --> E[人物 / 路线编排]
  E --> F[受限 CNKGraph Gateway]
  F --> G[搜韵开放 API]
  E --> H[Pi 白名单会话]
  H --> I[确定性证据与来源核验]
  I --> A
  A -->|两条已核验证据后| J[/api/narrative]
  J --> H
```

- 浏览器只提交当前笔迹段 PNG 和用户确认的短文本，绝不保存模型或图谱凭据。
- `vite.config.ts` 将开发服务器中的 `/api/transcribe`、`/api/seek`、`/api/narrative` 交给 `server/notebook-server.mjs`。
- 搜韵 gateway 是独立的服务端进程，提供 `/anchor`、`/works`、`/seek` 三个内部端点，并强制 Bearer 认证。
- Pi 只接收确认文本和已裁剪的有界证据，不接收原始笔迹；事实旁批由服务端按来源和路径确定性生成。

完整职责图、启动顺序、接口验证和排障见 [操作与架构指南](docs/operation-guide.md)。

## 快速开始

```bash
npm install
cp .env.example .env
npm run dev -- --host 0.0.0.0
```

打开终端显示的本地地址。平板与开发机在同一局域网时，将地址中的主机名替换为开发机局域网 IP；在浏览器菜单中选择“添加到主屏幕”即可安装 PWA 壳。

未配置 OCR 时，停笔后纸页仍会保留可编辑的转写确认框，可以手动补写文字；未配置图谱或 Pi 时，页面会明确展示服务状态或证据缺口，不会生成伪造事实。

## 运行模式

| 模式 | 目的 | 需要的配置 | 是否访问真实上游 |
| --- | --- | --- | --- |
| 本地纸页 | 检查书写、翻页与 PWA 壳 | 无 | 否 |
| 离线夹具 | 稳定演练证据、歧义和缺口分支 | `NOTEBOOK_FIXTURE_MODE=1` | 否 |
| 真实寻迹 | 人物档案、作品候选、来源和时间线 | gateway + Pi；OCR 可选 | 是 |
| 搜韵快照 | 仅用于受控离线研究 | `CNKGRAPH_PROVIDER=souyun-snapshot` 和本地快照 | 否 |

离线夹具必须显式开启，页面会显示“演练转写（未调用视觉模型）”；它不是生产回退，也不能当作真实识别或真实知识库结果。

## 常用命令

```bash
npm run check                   # TypeScript
npm run build                   # 生产构建
npm run check:agent             # Pi / 服务端合同
npm run check:journey-agent     # 人物锚点、路线与作品候选合同
npm run check:souyun-gateway    # gateway 协议与有界查询合同
npm run preflight:services      # OCR、Pi、图谱的非敏感静态预检
```

真实 gateway 的启动与预检、直接 API 探针、华为平板操作步骤和故障表都在 [操作与架构指南](docs/operation-guide.md)。

## 文档索引

- [操作与架构指南](docs/operation-guide.md)：日常开发、真实服务、接口验证、PWA 操作和排障。
- [MVP 合同](docs/mvp-contract.md)：纸页状态机、事实/联想边界与旅程规则。
- [产品框架](docs/product-framework.md)：模块职责、数据合同和迭代边界。
- [Pi 工具合同](docs/pi-tool-contract.md)：Pi 白名单、OCR 与服务端安全边界。
- [搜韵 CNKGraph Gateway 合同](docs/souyun-cnkgraph-gateway-contract.md)：gateway 内部协议与部署前核对项。
- [录屏与验收脚本](docs/demo-recording.md)：离线演练和真实服务验收路径。
- [转写实验规范](docs/transcription-experiment.md)：经同意样本的 OCR 评测流程。

## 安全与贡献约定

- `.env` 和任何 token、API key、OCR 样本、运行日志都不能提交。
- 清空只影响当前纸页；翻页、续页、切换静读和重新落笔会取消未完成请求，迟到结果不能覆盖当前状态。
- 修改交互、Pi 工具面或数据来源前，先阅读 [AGENTS.md](AGENTS.md) 与 [MVP 合同](docs/mvp-contract.md)。
