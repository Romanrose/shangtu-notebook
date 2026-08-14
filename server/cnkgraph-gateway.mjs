export const CNKGRAPH_GATEWAY_LIMITS = Object.freeze({ maxHops: 2, maxNodes: 8, maxEdges: 8, maxSources: 4 });
export const CNKGRAPH_GATEWAY_TIMEOUT_MS = 8_000;

function safeText(value, maxLength = 240) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text && text.length <= maxLength ? text : null;
}

function safeId(value) {
  const id = safeText(value, 160);
  return id && /^[A-Za-z0-9._:-]+$/.test(id) ? id : null;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function gatewayUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function evidenceGap(query, reason) {
  return { kind: "evidence_gap", query, reason, sources: [] };
}

function normalizeEvidenceGraph(value, query) {
  if (!value || value.kind !== "evidence" || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || !Array.isArray(value.sources)) return null;
  if (value.nodes.length === 0 || value.nodes.length > CNKGRAPH_GATEWAY_LIMITS.maxNodes || value.edges.length === 0 || value.edges.length > CNKGRAPH_GATEWAY_LIMITS.maxEdges || value.sources.length === 0 || value.sources.length > CNKGRAPH_GATEWAY_LIMITS.maxSources) return evidenceGap(query, "图谱记录超出纸页寻迹边界或缺少来源。");

  const sources = value.sources.map((source) => {
    const id = safeId(source?.id);
    const label = safeText(source?.label);
    const url = safeUrl(source?.url);
    const claim = safeText(source?.claim);
    return id && label && url && claim ? { id, label, url, claim } : null;
  });
  if (sources.some((source) => !source) || new Set(sources.map((source) => source.id)).size !== sources.length) return evidenceGap(query, "图谱记录未通过来源核验。");

  const nodes = value.nodes.map((node) => {
    const id = safeId(node?.id);
    const label = safeText(node?.label);
    const type = safeText(node?.type, 80);
    return id && label && type ? { id, label, type } : null;
  });
  if (nodes.some((node) => !node) || new Set(nodes.map((node) => node.id)).size !== nodes.length) return evidenceGap(query, "图谱记录未通过节点核验。");

  const nodeIds = new Set(nodes.map((node) => node.id));
  const sourceIds = new Set(sources.map((source) => source.id));
  const edges = value.edges.map((edge) => {
    const source = safeId(edge?.source);
    const relation = safeText(edge?.relation, 80);
    const target = safeId(edge?.target);
    const evidenceRefs = Array.isArray(edge?.evidenceRefs) ? [...new Set(edge.evidenceRefs.map(safeId).filter(Boolean))] : [];
    return source && relation && target && nodeIds.has(source) && nodeIds.has(target) && evidenceRefs.length > 0 && evidenceRefs.every((id) => sourceIds.has(id))
      ? { source, relation, target, evidenceRefs }
      : null;
  });
  if (edges.some((edge) => !edge)) return evidenceGap(query, "图谱记录未通过关系来源核验。");

  const usedSourceIds = new Set(edges.flatMap((edge) => edge.evidenceRefs));
  return {
    kind: "evidence",
    query,
    nodes,
    edges: edges.map(({ evidenceRefs: _evidenceRefs, ...edge }) => edge),
    sources: sources.filter((source) => usedSourceIds.has(source.id)),
  };
}

function createUnconfiguredRetriever() {
  const retrieve = async (query) => ({ kind: "graph_unconfigured", query });
  retrieve.isConfigured = false;
  return retrieve;
}

/**
 * Internal, server-only gateway adapter. It deliberately knows no Souyun
 * endpoint shape: a future authorized gateway maps the upstream API into the
 * fixed request/response contract documented in docs/souyun-cnkgraph-gateway-contract.md.
 */
export function createCnkgraphGatewayRetriever({
  endpoint = process.env.CNKGRAPH_GATEWAY_ENDPOINT,
  authToken = process.env.CNKGRAPH_GATEWAY_AUTH_TOKEN,
  fetchImpl = fetch,
  timeoutMs = CNKGRAPH_GATEWAY_TIMEOUT_MS,
} = {}) {
  const url = gatewayUrl(endpoint);
  if (!url || !authToken) return createUnconfiguredRetriever();

  const retrieve = async (input) => {
    const query = safeText(input, 160);
    if (!query) return evidenceGap("", "确认文本无效，未查询图谱。");
    const controller = new AbortController();
    let timer;
    try {
      const response = await Promise.race([
        fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${authToken}`,
          },
          body: JSON.stringify({ query, limits: CNKGRAPH_GATEWAY_LIMITS }),
          signal: controller.signal,
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("graph_timed_out"));
          }, timeoutMs);
        }),
      ]);
      if (!response?.ok) return { kind: "graph_unavailable", query };
      let payload;
      try {
        payload = await response.json();
      } catch {
        return { kind: "graph_unavailable", query };
      }
      if (payload?.kind === "evidence_gap") return evidenceGap(query, safeText(payload.reason) ?? "当前图谱没有这条可核验的直接关联。");
      return normalizeEvidenceGraph(payload, query) ?? { kind: "graph_unavailable", query };
    } catch (error) {
      return error instanceof Error && error.message === "graph_timed_out"
        ? { kind: "graph_timed_out", query }
        : { kind: "graph_unavailable", query };
    } finally {
      clearTimeout(timer);
    }
  };
  retrieve.isConfigured = true;
  return retrieve;
}
