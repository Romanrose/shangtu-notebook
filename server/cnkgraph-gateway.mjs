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
    // 生产要求 HTTPS；本地回环 http 仅用于开发期接入同机 gateway（无传输暴露面）。
    if (url.protocol === "https:") return url.toString();
    if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return url.toString();
    return null;
  } catch {
    return null;
  }
}

function evidenceGap(query, reason) {
  return { kind: "evidence_gap", query, reason, sources: [] };
}

function safeTemporalSpatial(value) {
  if (!value || typeof value !== "object") return null;
  const bounded = (items, cap = 4) => Array.isArray(items)
    ? items.map((item) => safeText(item, 120)).filter(Boolean).slice(0, cap)
    : [];
  const places = bounded(value.places);
  const timeHints = bounded(value.timeHints);
  const timeline = Array.isArray(value.timeline)
    ? value.timeline
        .map((point) => {
          const year = Number(point?.year);
          const label = safeText(point?.label, 120);
          return Number.isInteger(year) && year > 0 && year <= 3000 && label ? { year, label } : null;
        })
        .filter(Boolean)
        .slice(0, 4)
    : [];
  return places.length > 0 || timeHints.length > 0 || timeline.length > 0 ? { places, timeHints, timeline } : null;
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
  const temporalSpatial = safeTemporalSpatial(value.temporalSpatial);
  return {
    kind: "evidence",
    query,
    nodes,
    edges: edges.map(({ evidenceRefs: _evidenceRefs, ...edge }) => edge),
    sources: sources.filter((source) => usedSourceIds.has(source.id)),
    ...(temporalSpatial ? { temporalSpatial } : {}),
  };
}

function createUnconfiguredRetriever() {
  const retrieve = async (query) => ({ kind: "graph_unconfigured", query });
  retrieve.isConfigured = false;
  return retrieve;
}

/**
 * Gateway /works 客户端：人物作品列表。与 retrieve 同一认证与超时合同；
 * 返回 works / person_ambiguous / evidence_gap / graph_* 状态。
 */
export function createWorksResolver({
  endpoint = process.env.CNKGRAPH_GATEWAY_ENDPOINT,
  authToken = process.env.CNKGRAPH_GATEWAY_AUTH_TOKEN,
  fetchImpl = fetch,
  timeoutMs = CNKGRAPH_GATEWAY_TIMEOUT_MS,
} = {}) {
  const seekUrl = gatewayUrl(endpoint);
  if (!seekUrl || !authToken) {
    const resolve = async () => ({ kind: "graph_unconfigured" });
    resolve.isConfigured = false;
    return resolve;
  }
  const worksUrl = new URL(seekUrl);
  worksUrl.pathname = worksUrl.pathname.replace(/\/seek\/?$/, "/works");

  const resolve = async (person) => {
    const name = safeText(person, 24);
    if (!name) return { kind: "evidence_gap", reason: "人物名无效。" };
    const controller = new AbortController();
    let timer;
    try {
      const response = await Promise.race([
        fetchImpl(worksUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${authToken}`,
          },
          body: JSON.stringify({ person: name }),
          signal: controller.signal,
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("graph_timed_out"));
          }, timeoutMs);
        }),
      ]);
      if (!response?.ok) return { kind: "graph_unavailable" };
      const payload = await response.json();
      if (payload?.kind === "works") {
        const works = Array.isArray(payload.works)
          ? payload.works
              .map((work) => ({ id: work?.id, title: safeText(work?.title, 24), date: safeText(work?.date, 24), place: safeText(work?.place, 24) }))
              .filter((work) => work.title)
              .slice(0, 4)
          : [];
        if (works.length === 0) return { kind: "evidence_gap", reason: "诗文库暂无该人物可展示的作品列表。" };
        return { kind: "works", name: safeText(payload.name, 24) ?? name, totalCount: Number(payload.totalCount) || works.length, works };
      }
      if (payload?.kind === "person_ambiguous") return { kind: "person_ambiguous", candidates: Array.isArray(payload.candidates) ? payload.candidates.slice(0, 4) : [] };
      if (payload?.kind === "evidence_gap") return { kind: "evidence_gap", reason: safeText(payload.reason) ?? "诗文库没有该人物的记录。" };
      return { kind: "graph_unavailable" };
    } catch (error) {
      return error instanceof Error && error.message === "graph_timed_out"
        ? { kind: "graph_timed_out" }
        : { kind: "graph_unavailable" };
    } finally {
      clearTimeout(timer);
    }
  };
  resolve.isConfigured = true;
  return resolve;
}

/**
 * Gateway /anchor 客户端：人物锚点解析。与 retrieve 同一认证与超时合同；
 * 返回 person_anchor / person_ambiguous / evidence_gap / graph_* 状态。
 */
export function createAnchorResolver({
  endpoint = process.env.CNKGRAPH_GATEWAY_ENDPOINT,
  authToken = process.env.CNKGRAPH_GATEWAY_AUTH_TOKEN,
  fetchImpl = fetch,
  timeoutMs = CNKGRAPH_GATEWAY_TIMEOUT_MS,
} = {}) {
  const seekUrl = gatewayUrl(endpoint);
  if (!seekUrl || !authToken) {
    const resolve = async () => ({ kind: "graph_unconfigured" });
    resolve.isConfigured = false;
    return resolve;
  }
  const anchorUrl = new URL(seekUrl);
  // 内部约定：anchor 端点 = seek 端点结尾的 /seek 换成 /anchor；无该后缀时追加 /anchor。
  anchorUrl.pathname = /\/seek\/?$/.test(anchorUrl.pathname)
    ? anchorUrl.pathname.replace(/\/seek\/?$/, "/anchor")
    : `${anchorUrl.pathname.replace(/\/+$/, "")}/anchor`;

  const resolve = async (person, dynastyHint = null) => {
    const name = safeText(person, 24);
    if (!name) return { kind: "evidence_gap", reason: "人物名无效。" };
    const controller = new AbortController();
    let timer;
    try {
      const response = await Promise.race([
        fetchImpl(anchorUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${authToken}`,
          },
          body: JSON.stringify({ person: name, ...(dynastyHint ? { dynasty: dynastyHint } : {}) }),
          signal: controller.signal,
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("graph_timed_out"));
          }, timeoutMs);
        }),
      ]);
      if (!response?.ok) return { kind: "graph_unavailable" };
      const payload = await response.json();
      if (payload?.kind === "person_anchor") return { kind: "person_anchor", anchor: payload.anchor };
      if (payload?.kind === "person_ambiguous") return { kind: "person_ambiguous", candidates: Array.isArray(payload.candidates) ? payload.candidates.slice(0, 4) : [] };
      if (payload?.kind === "evidence_gap") return { kind: "evidence_gap", reason: safeText(payload.reason) ?? "诗文库没有该人物的档案记录。" };
      return { kind: "graph_unavailable" };
    } catch (error) {
      return error instanceof Error && error.message === "graph_timed_out"
        ? { kind: "graph_timed_out" }
        : { kind: "graph_unavailable" };
    } finally {
      clearTimeout(timer);
    }
  };
  resolve.isConfigured = true;
  return resolve;
}

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
