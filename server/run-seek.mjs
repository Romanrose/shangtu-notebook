import { createPiNotebookSession, notebookSystemPrompt } from "./notebook-agent.mjs";
import { normalizeSeekOutcome } from "./seek-outcome.mjs";

function textFromLastAssistant(session) {
  const last = [...session.messages].reverse().find((message) => message.role === "assistant");
  return last ? last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim() : "";
}

function cacheRequestRetrieval(retrieve) {
  const results = new Map();
  return (query) => {
    if (!results.has(query)) results.set(query, Promise.resolve().then(() => retrieve(query)));
    return results.get(query);
  };
}

function retrieveUnconfigured(query) {
  return { kind: "graph_unconfigured", query };
}
retrieveUnconfigured.isConfigured = false;

function verifiedEvidenceHint(graph) {
  if (graph?.kind !== "evidence") return "本次没有可用的已核验证据；如无法澄清，请返回 evidence_gap。";
  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
  const paths = graph.edges.map((edge) => [labels.get(edge.source), edge.relation, labels.get(edge.target)]);
  return `本次服务器已核验证据。证据分支只能使用 sourceIds：${graph.sources.map((source) => source.id).join(", ")}；path 必须是以下任一 JSON 字符串数组：${paths.map((path) => JSON.stringify(path)).join("；")}。例如 {"kind":"evidence","sourceIds":["${graph.sources[0].id}"],"path":${JSON.stringify(paths[0])}}。`;
}

/** Future /api/seek boundary. Image stays opaque until the replaceable vision step. */
export async function runSeek({ transcription, image, createSession = createPiNotebookSession, retrieve = retrieveUnconfigured }) {
  if (!transcription?.trim()) return { status: "needs_transcription" };
  if (retrieve.isConfigured === false) return { status: "graph_unconfigured" };
  const requestRetrieval = cacheRequestRetrieval(retrieve);
  const graph = await requestRetrieval(transcription);
  if (graph?.kind === "graph_unconfigured" || graph?.kind === "graph_timed_out" || graph?.kind === "graph_unavailable") return { status: graph.kind };
  const session = await createSession({ retrieve: requestRetrieval });
  if (!session) return { status: "model_unconfigured" };
  try {
    const prompt = `${notebookSystemPrompt(transcription)}\n\n${verifiedEvidenceHint(graph)}\n只返回 JSON，不要 Markdown。kind 只能为 evidence、clarification 或 evidence_gap。evidence 必须提供 sourceIds 与 path；clarification 必须提供 text 与至少两个 candidates；association 如有必须以文化联想表达，不能陈述事实。`;
    const images = image ? [{ type: "image", data: image.data, mimeType: image.mimeType }] : undefined;
    await session.prompt(prompt, { images });
    await session.waitForIdle();
    return { status: "ok", outcome: normalizeSeekOutcome({ transcription: transcription.trim(), raw: textFromLastAssistant(session), graph }) };
  } finally {
    session.dispose();
  }
}
