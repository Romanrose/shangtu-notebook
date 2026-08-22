const MAX_MARGIN_TEXT = 120;
const FACTUAL_ASSOCIATION_MARKERS = /\d{3,4}\s*年|馆藏|出处|生于|卒于|作者|人物关系|收录于|写于/;

function shortText(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text && text.length <= MAX_MARGIN_TEXT ? text : null;
}

function parseAssistantJson(raw) {
  if (typeof raw !== "string") return null;
  const candidate = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function associationFrom(value) {
  const text = shortText(value);
  if (!text || FACTUAL_ASSOCIATION_MARKERS.test(text)) return null;
  return text.startsWith("联想：") ? text : `联想：${text}`;
}

function evidencePath(graph) {
  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
  const edge = graph.edges[0];
  return edge ? [labels.get(edge.source), edge.relation, labels.get(edge.target)] : [];
}

function evidenceSentence(path) {
  const [subject, relation, object] = path;
  if (relation === "作者") return `当前图谱记录：${subject}是《${object}》的作者。`;
  return `当前图谱记录：${subject}与${object}存在“${relation}”关系。`;
}

function evidenceOutcome(transcription, graph, response) {
  const path = evidencePath(graph);
  const exactPath = Array.isArray(response.path) && response.path.length === path.length && response.path.every((part, index) => part === path[index]);
  // 来源核验：提案必须引用至少一个真实来源，且不得出现图谱之外的 id（子集即可，
  // 全量匹配会把只引用部分来源的合法提案误判为缺口）。
  const graphSourceIds = new Set(graph.sources.map((source) => source.id));
  const proposedIds = Array.isArray(response.sourceIds) ? [...new Set(response.sourceIds)] : [];
  const sourcesValid = proposedIds.length > 0 && proposedIds.every((id) => graphSourceIds.has(id));
  if (!exactPath || !sourcesValid || !path.every(Boolean)) return null;
  const proposedSet = new Set(proposedIds);
  const verifiedSources = graph.sources.filter((source) => proposedSet.has(source.id));
  // 二级时空索引：只从 gateway 归一化的 temporalSpatial 透传，服务端不再加工。
  const index = graph.temporalSpatial;
  const places = Array.isArray(index?.places) ? index.places.slice(0, 4) : undefined;
  const timeHints = Array.isArray(index?.timeHints) ? index.timeHints.slice(0, 4) : undefined;
  const timeline = Array.isArray(index?.timeline) ? index.timeline.slice(0, 4) : undefined;
  return {
    kind: "evidence",
    transcription,
    evidence: evidenceSentence(path),
    association: associationFrom(response.association),
    source: verifiedSources.map(({ label, url }) => ({ label, url })),
    path,
    ...(places && places.length > 0 ? { places } : {}),
    ...(timeHints && timeHints.length > 0 ? { timeHints } : {}),
    ...(timeline && timeline.length > 0 ? { timeline } : {}),
  };
}

function clarificationOutcome(transcription, response) {
  const candidates = Array.isArray(response.candidates)
    ? response.candidates.map(shortText).filter(Boolean).slice(0, 4)
    : [];
  const uniqueCandidates = [...new Set(candidates)];
  const clarification = shortText(response.text);
  if (uniqueCandidates.length < 2 || !clarification) return null;
  return { kind: "ambiguous", transcription, clarification, candidates: uniqueCandidates };
}

function gapOutcome(transcription, response, fallback) {
  return {
    kind: "gap",
    transcription,
    gap: shortText(response?.text) ?? fallback,
    association: associationFrom(response?.association),
  };
}

/**
 * Treat model JSON as a proposal only. The server derives facts and sources
 * from the bounded graph result before an annotation can reach the browser.
 */
export function normalizeSeekOutcome({ transcription, raw, graph }) {
  const response = parseAssistantJson(raw);
  if (response?.kind === "clarification") {
    return clarificationOutcome(transcription, response)
      ?? gapOutcome(transcription, null, "我无法确认这页笔迹中的实体；请换一种写法或补充名字。");
  }
  if (graph.kind === "evidence" && response?.kind === "evidence") {
    return evidenceOutcome(transcription, graph, response)
      ?? gapOutcome(transcription, null, "图谱虽有记录，但这次旁批没有通过来源与路径核验。");
  }
  return gapOutcome(transcription, response, "我暂未在当前可核验的图谱记录中找到这条直接关联。");
}
