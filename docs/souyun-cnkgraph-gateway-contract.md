# 搜韵 CNKGraph Gateway 合同（接入前）

状态：尚未配置或调用搜韵。本文件规定未来服务端 gateway 必须满足的**内部**合同；它不声称搜韵现有 API 使用这些路径、字段或认证方式。

## 位置与权限

```text
confirmed transcription
  -> server-side Souyun gateway adapter
  -> bounded evidence graph
  -> Pi retrieve_cnkgraph + deterministic source/path validation
  -> paper-margin evidence / ambiguity / gap
```

- 只有用户确认后的短文本或已确认实体可以传给 gateway；不传 PNG、原始笔迹、Pi prompt、笔记历史或客户端标识。
- gateway 只在受控服务端运行。Flutter、浏览器与 Pi 不读取 endpoint、token、cookie 或搜韵返回的未核验原文。
- 每次 `/api/seek` 创建 request-scoped retriever。Pi 调用与最终核验共享同一次查询缓存。
- 每次查询最多 2 跳、8 个节点、8 条边、4 个来源；禁止分页、自由扩展或二次网络发现。

## 接入前必须提供

1. 正式 API endpoint、版本、HTTP 方法和最小认证 scope；
2. 产品使用、缓存、展示来源与数据处理条款；
3. 成功、明确无结果、401/403、429、5xx、超时和非 JSON 的真实脱敏样例；
4. 每条可展示关系的稳定来源 ID、标题、永久 URL、可展示 claim，及可选版本/访问时间；
5. 支持的实体、关系、最大深度、限流和缓存限制。

缺少其中任一项时，服务端必须保持 `graph_unconfigured`，且不得发请求。

## Gateway 请求（内部形状）

未来 adapter 可以按搜韵真实协议转换，但对上游 gateway 的最小请求意图固定为：

```json
{
  "query": "用户确认后的文本或实体",
  "limits": { "maxHops": 2, "maxNodes": 8, "maxEdges": 8, "maxSources": 4 }
}
```

`query` 上限为 160 个字符。服务端必须给请求传入 `AbortSignal`；超时不得重试或回退到 fixture。

## Gateway 成功响应（内部归一形状）

```json
{
  "kind": "evidence",
  "nodes": [{ "id": "person:li-bai", "label": "李白", "type": "Person" }],
  "edges": [{
    "source": "person:li-bai",
    "relation": "作者",
    "target": "work:jiangjinjiu",
    "evidenceRefs": ["source:jiangjinjiu-li-bai"]
  }],
  "sources": [{
    "id": "source:jiangjinjiu-li-bai",
    "label": "…",
    "url": "https://…",
    "claim": "…",
    "sourceVersion": "optional",
    "retrievedAt": "optional ISO-8601"
  }]
}
```

每条用于纸面事实的边必须有 `evidenceRefs`，且每个引用都必须在本响应的 `sources` 内有有效 `url` 和 `claim`。Pi 只能提议其中已有的 `sourceIds` 与有界 `path`；服务器负责确定性生成事实旁批。任何不匹配、缺来源或越界图都降级为“图谱记录未通过来源与路径核验”的证据缺口。

## 无结果与故障

| 上游情形 | 内部结果 | 纸面含义 |
| --- | --- | --- |
| 未配置 endpoint/授权 | `graph_unconfigured` | 不启动 Pi，不生成旁批 |
| 明确无匹配路径 | `evidence_gap` | 可显示证据缺口 |
| 超时 | `graph_timed_out` | 服务暂时不可达，不是“没有证据” |
| 401/403、429、5xx、网络或格式错误 | `graph_unavailable` | 服务暂时不可达，不是“没有证据” |
| 图存在但来源/路径无效 | `evidence_gap` | 明确说明未通过核验 |

模型文化补充仍只能以 `联想：` 进入纸面，且不得含年代、出处、馆藏、作者或人物关系等事实性断言。

## 接入验收

- 未配置时断言 `fetch` 零调用、Pi 零会话；
- fake gateway 断言只收到确认文本、固定 limits 与 `AbortSignal`；
- 同一次 seek 的两次相同查询只发一次 gateway 请求；
- 覆盖：证据、明确无结果、超时、鉴权/限流、非法 JSON、缺来源、伪造 source ID、越界路径；
- 保留纸页三分支与本地时序验收：证据带来源/路径、歧义不静默选择、缺口不编造事实、停笔一秒内本地苏醒、静读零调用。
