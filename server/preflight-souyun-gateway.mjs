import { CNKGRAPH_GATEWAY_LIMITS, createCnkgraphGatewayRetriever } from "./cnkgraph-gateway.mjs";

/**
 * 模拟 notebook 服务端调用搜韵 gateway 的端到端配置预检。
 *
 * 与 preflight-real-services.mjs（纯本地、零网络的静态配置检查）不同，本脚本
 * 会发起少量受控的真实网络请求，模拟 notebook 的 /api/seek 在运行时调用
 * CNKGRAPH_GATEWAY_* 所指 gateway 的完整链路：
 *
 *   1. 配置检查：endpoint/token 完整性与协议（适配器只接受 HTTPS）；
 *   2. 健康检查：GET /healthz（best-effort，不是内部合同要求）；
 *   3. 鉴权拒绝：错误 token 必须被 401/403 拒绝；
 *   4. 证据探针：用真实适配器查询「李白写过《将进酒》吗」，期待证据图；
 *   5. 缺口探针：查询不存在的作品，期待 evidence_gap 而不是 unavailable
 *      （验证「没查到」与「没查成」的语义边界没有被破坏）。
 *
 * 探针 4/5 直接复用 server/cnkgraph-gateway.mjs 的真实适配器，因此预检与
 * notebook 运行时走完全相同的请求形状（POST + Bearer + {query, limits}）、
 * 相同的归一化与错误映射。本地 http 端点（开发中的 gateway）需要显式设置
 * SOUYUN_PREFLIGHT_ALLOW_HTTP=1：预检只把传输层重定向到该 http 地址，适配器
 * 逻辑保持不变；生产部署必须 HTTPS 且不设豁免。
 *
 * 用法：
 *   npm run preflight:souyun-gateway
 *   CNKGRAPH_GATEWAY_ENDPOINT=http://localhost:8787/seek \
 *     CNKGRAPH_GATEWAY_AUTH_TOKEN=dev-smoke-token \
 *     SOUYUN_PREFLIGHT_ALLOW_HTTP=1 npm run preflight:souyun-gateway
 *
 * 输出永远不包含 token 值。
 */

const PROBE_QUERY = "李白写过《将进酒》吗";
const GAP_PROBE_QUERY = "李白写过《完全不存在的一首诗》吗";
const HEALTH_TIMEOUT_MS = 3_000;
const PROBE_TIMEOUT_MS = 12_000;

const checks = [];

function record(name, status, detail = "") {
  checks.push({ name, status });
  const label = status === "pass" ? "通过" : status === "skip" ? "跳过" : "失败";
  console.log(`- ${name}：${label}${detail ? `（${detail}）` : ""}`);
}

function finish() {
  const failed = checks.filter((check) => check.status === "fail");
  if (failed.length === 0) {
    const passed = checks.filter((check) => check.status === "pass").length;
    const skipped = checks.filter((check) => check.status === "skip").length;
    console.log(`结论：预检通过；notebook 可用当前 CNKGRAPH_GATEWAY_* 配置启用 /api/seek（${passed} 项通过，${skipped} 项跳过）。`);
    process.exit(0);
  }
  console.log(`结论：预检未通过（失败项：${failed.map((check) => check.name).join("、")}）。修复配置或 gateway 后重跑。`);
  process.exit(1);
}

function networkError(error) {
  return error?.cause?.code ?? error?.message ?? "网络错误";
}

const endpoint = (process.env.CNKGRAPH_GATEWAY_ENDPOINT ?? "").trim();
const authToken = (process.env.CNKGRAPH_GATEWAY_AUTH_TOKEN ?? "").trim();
const allowLocalHttp = process.env.SOUYUN_PREFLIGHT_ALLOW_HTTP === "1";

console.log(`目标 gateway：${endpoint || "（未配置）"}`);

// 1. 配置检查：与 notebook 适配器同样的硬性要求。
let endpointUrl = null;
{
  const missing = [!endpoint && "CNKGRAPH_GATEWAY_ENDPOINT", !authToken && "CNKGRAPH_GATEWAY_AUTH_TOKEN"].filter(Boolean);
  if (missing.length > 0) {
    record("配置检查", "fail", `缺少 ${missing.join("、")}；gateway 未配置时 /api/seek 保持 graph_unconfigured 且零联网`);
    finish();
  }
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    record("配置检查", "fail", "endpoint 不是合法 URL");
    finish();
  }
  if (endpointUrl.protocol === "https:") {
    record("配置检查", "pass", "HTTPS endpoint，符合适配器合同");
  } else if (allowLocalHttp) {
    record("配置检查", "pass", `本地 http endpoint 已通过 SOUYUN_PREFLIGHT_ALLOW_HTTP=1 豁免（仅限开发预检，生产必须 HTTPS）`);
  } else {
    record("配置检查", "fail", "notebook 适配器只接受 HTTPS endpoint；本地预检可设 SOUYUN_PREFLIGHT_ALLOW_HTTP=1");
    finish();
  }
}

// 2. 健康检查：best-effort；其它满足内部合同的 gateway 实现可以没有 /healthz。
try {
  const health = await fetch(new URL("/healthz", endpointUrl), { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
  if (health.status === 200) record("健康检查", "pass");
  else record("健康检查", "skip", `返回 HTTP ${health.status}；非本实现的 gateway 可忽略`);
} catch {
  record("健康检查", "skip", "gateway 未暴露 /healthz（不是内部合同要求）");
}

// 3. 鉴权拒绝：错误 token 必须被拒绝，否则任何拿到 endpoint 的客户端都能查询。
try {
  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer preflight-invalid-token" },
    body: JSON.stringify({ query: PROBE_QUERY, limits: CNKGRAPH_GATEWAY_LIMITS }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    record("鉴权拒绝", "pass", `错误 token 被拒绝（HTTP ${response.status}）`);
  } else {
    record("鉴权拒绝", "fail", `错误 token 返回 HTTP ${response.status}；gateway 未强制鉴权`);
  }
} catch (error) {
  record("鉴权拒绝", "fail", `无法连接 gateway：${networkError(error)}`);
}

// 4/5. 用真实适配器跑标准探针（与 notebook /api/seek 完全同一条代码路径）。
const useTransportShim = endpointUrl.protocol !== "https:";
const retriever = createCnkgraphGatewayRetriever({
  endpoint: useTransportShim ? "https://preflight.invalid/seek" : endpoint,
  authToken,
  ...(useTransportShim ? { fetchImpl: (_url, options) => fetch(endpointUrl, options) } : {}),
});
if (retriever.isConfigured !== true) {
  record("证据探针", "fail", "适配器判定 gateway 未配置（不应发生）");
  record("缺口探针", "fail", "适配器判定 gateway 未配置（不应发生）");
  finish();
}

const startedAt = Date.now();
const evidence = await retriever(PROBE_QUERY);
const elapsedMs = Date.now() - startedAt;
if (evidence.kind === "evidence") {
  const nodesOk = evidence.nodes.length >= 1 && evidence.nodes.every((node) => node.id && node.label && node.type);
  const edgesOk = evidence.edges.length >= 1 && evidence.edges.every((edge) => edge.source && edge.relation && edge.target);
  const sourcesOk = evidence.sources.length >= 1 && evidence.sources.every((source) => source.url.startsWith("https://") && source.claim);
  if (nodesOk && edgesOk && sourcesOk) {
    record("证据探针", "pass", `「${PROBE_QUERY}」返回证据图：${evidence.nodes.length} 节点 / ${evidence.edges.length} 边 / ${evidence.sources.length} 来源，耗时 ${elapsedMs}ms`);
  } else {
    record("证据探针", "fail", "证据图缺少纸页展示必需的字段（节点/关系/来源）");
  }
} else if (evidence.kind === "evidence_gap") {
  record("证据探针", "fail", `标准问句只返回了证据缺口：${evidence.reason}`);
} else {
  record("证据探针", "fail", `返回 ${evidence.kind}（耗时 ${elapsedMs}ms）；gateway 不可达、鉴权失败或上游故障`);
}

const gap = await retriever(GAP_PROBE_QUERY);
if (gap.kind === "evidence_gap" && gap.reason) {
  record("缺口探针", "pass", `「没查到」正确映射为证据缺口：${gap.reason}`);
} else if (gap.kind === "evidence") {
  record("缺口探针", "fail", "查询不存在的作品却返回了证据；缺口语义可能丢失");
} else {
  record("缺口探针", "fail", `「没查到」被映射为 ${gap.kind}；上游明确无结果应映射为 evidence_gap，而不是服务不可达`);
}

finish();
