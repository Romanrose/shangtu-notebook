import { readFile } from "node:fs/promises";

const fixturePath = new URL("./fixtures/cnkgraph-li-bai-demo.json", import.meta.url);
let graphPromise;

async function loadGraph() {
  graphPromise ??= readFile(fixturePath, "utf8").then(JSON.parse);
  return graphPromise;
}

/** Read-only bounded evidence for offline rehearsal; never consults the old workspace. */
export async function retrieveFixture(query) {
  const graph = await loadGraph();
  if (!/李白|太白|青莲/.test(query)) {
    return { kind: "evidence_gap", query, reason: "当前演示夹具只包含李白人物子图", sources: [] };
  }
  const nodes = graph.nodes.slice(0, 2);
  const ids = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).slice(0, 1);
  const sourceIds = new Set([...nodes, ...edges].flatMap((record) => record.evidence_refs ?? []));
  const sources = graph.sources.filter((source) => sourceIds.has(source.id));
  return {
    kind: "evidence", query, source: graph.source,
    nodes: nodes.map((node) => ({ id: node.id, label: node.label, type: node.type })),
    edges: edges.map((edge) => ({ source: edge.source, relation: edge.relation, target: edge.target })), sources,
  };
}
