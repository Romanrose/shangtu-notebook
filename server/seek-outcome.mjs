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
  const sourceIds = graph.sources.map((source) => source.id).sort();
  const proposedIds = Array.isArray(response.sourceIds) ? [...response.sourceIds].sort() : [];
  const exactPath = Array.isArray(response.path) && response.path.length === path.length && response.path.every((part, index) => part === path[index]);
  const exactSources = proposedIds.length === sourceIds.length && proposedIds.every((id, index) => id === sourceIds[index]);
  if (!exactPath || !exactSources || !path.every(Boolean)) return null;
  return {
    kind: "evidence",
    transcription,
    evidence: evidenceSentence(path),
    association: associationFrom(response.association),
    source: graph.sources.map(({ label, url }) => ({ label, url })),
    path,
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
