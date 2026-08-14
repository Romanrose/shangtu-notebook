import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const defaultDirectory = resolve(process.cwd(), "data/souyun-snapshots");

function unconfigured() {
  const retrieve = async (query) => ({ kind: "graph_unconfigured", query });
  retrieve.isConfigured = false;
  return retrieve;
}

function sourceId(url) {
  return `source:souyun:${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
}

function loadSnapshots(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith("_subgraph_v0.1.json"))
    .flatMap((entry) => {
      try {
        const graph = JSON.parse(readFileSync(join(directory, entry.name), "utf8"));
        return graph?.source === "搜韵网 / CNKGraph 开放 API" && Array.isArray(graph.nodes) && Array.isArray(graph.edges) ? [graph] : [];
      } catch {
        return [];
      }
    });
}

/**
 * Local-only, audited competition snapshots. This is deliberately not a live
 * Souyun client: the current public author-search response has drifted from
 * the verified competition contract. Only an exact confirmed seed may match.
 */
export function createSouyunSnapshotRetriever({
  enabled = process.env.CNKGRAPH_PROVIDER === "souyun-snapshot",
  directory = process.env.CNKGRAPH_SNAPSHOT_DIR || defaultDirectory,
  graphs = enabled ? loadSnapshots(directory) : [],
} = {}) {
  if (!enabled || graphs.length === 0) return unconfigured();

  const retrieve = async (query) => {
    const text = typeof query === "string" ? query.trim() : "";
    const graph = graphs.find((candidate) => candidate?.query?.person === text);
    if (!graph) return { kind: "evidence_gap", query: text, reason: "当前已审计的搜韵快照没有该精确确认实体。", sources: [] };
    const nodeById = new Map(graph.nodes.map((node) => [node?.id, node]));
    const edge = graph.edges.find((candidate) => candidate?.relation === "wrote" && nodeById.get(candidate.source)?.label === text && nodeById.get(candidate.target)?.type === "Work");
    const sourceUrl = edge?.evidence_refs?.find((value) => typeof value === "string" && value.startsWith("https://"));
    const source = edge && sourceUrl ? nodeById.get(edge.source) : null;
    const target = edge && sourceUrl ? nodeById.get(edge.target) : null;
    if (!edge || !source || !target) return { kind: "evidence_gap", query: text, reason: "搜韵快照缺少可展示的作品关系来源。", sources: [] };
    const id = sourceId(sourceUrl);
    return {
      kind: "evidence",
      query: text,
      nodes: [source, target].map(({ id: nodeId, label, type }) => ({ id: nodeId, label, type })),
      edges: [{ source: edge.source, relation: edge.relation, target: edge.target, evidenceRefs: [id] }],
      sources: [{ id, label: "搜韵 CNKGraph 审计快照", url: sourceUrl, claim: `搜韵 CNKGraph 快照记录：${source.label}${edge.relation}${target.label}。` }],
    };
  };
  retrieve.isConfigured = true;
  return retrieve;
}
