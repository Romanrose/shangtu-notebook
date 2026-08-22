import { createPiNotebookSession, notebookSystemPrompt } from "./notebook-agent.mjs";
import { createWorksResolver } from "./cnkgraph-gateway.mjs";
import { isOpenWorksQuestion, normalizeJourneyQuery, resolveWorksOutcome } from "./journey-agent.mjs";
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
  return `本次服务器已核验证据。证据分支的 sourceIds 至少引用一个、只能取自：${graph.sources.map((source) => source.id).join(", ")}；path 必须是以下任一 JSON 字符串数组：${paths.map((path) => JSON.stringify(path)).join("；")}。例如 {"kind":"evidence","sourceIds":[${graph.sources.map((source) => `"${source.id}"`).join(",")}],"path":${JSON.stringify(paths[0])}}。`;
}

/**
 * Pi 不可用/失败时的确定性提案：直接采用图谱自身的 sourceIds 与 path。
 * 核验逻辑（normalizeSeekOutcome）不变——事实旁批仍由服务端从有界图谱
 * 确定性生成，符合合同“服务器负责确定性生成事实旁批”的边界。
 */
function deterministicProposal(graph) {
  if (graph?.kind !== "evidence") return { kind: "evidence_gap", text: "我暂未在当前可核验的图谱记录中找到这条直接关联。" };
  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
  const edge = graph.edges[0];
  return {
    kind: "evidence",
    sourceIds: graph.sources.map((source) => source.id),
    path: [labels.get(edge.source), edge.relation, labels.get(edge.target)],
  };
}

/**
 * The vision adapter consumes the ink image before this boundary. Pi receives
 * only the user's confirmed transcription plus bounded graph evidence, so a
 * text-only tool-calling model can run without receiving the original ink.
 */
export async function runSeek({ transcription, image, journey, createSession = createPiNotebookSession, retrieve = retrieveUnconfigured, worksResolver = createWorksResolver() }) {
  if (!transcription?.trim()) return { status: "needs_transcription" };
  if (retrieve.isConfigured === false) return { status: "graph_unconfigured" };
  // 开放式作品问句：真实作品列表 → 候选点选，先于图谱寻迹（确定性，不经模型）。
  if (isOpenWorksQuestion(transcription, journey)) {
    const worksResult = await resolveWorksOutcome({ transcription, journey, worksResolver });
    if (worksResult) return worksResult;
  }
  const requestRetrieval = cacheRequestRetrieval(retrieve);
  // 旅程感知：锚点人物已知时把代词/裸作品名归一成 gateway 可解析的问句。
  const query = normalizeJourneyQuery(transcription, journey);
  const graph = await requestRetrieval(query);
  if (graph?.kind === "graph_unconfigured" || graph?.kind === "graph_timed_out" || graph?.kind === "graph_unavailable") return { status: graph.kind };
  let session = null;
  let degradedToDeterministic = false;
  try {
    session = await createSession({ retrieve: requestRetrieval });
  } catch {
    // 已配置但初始化失败（网络/上游故障）：容错为确定性直出，证据旁批不缺席。
    session = null;
    degradedToDeterministic = true;
  }
  if (!session && !degradedToDeterministic) return { status: "model_unconfigured" };
  if (!session) {
    return { status: "ok", outcome: normalizeSeekOutcome({ transcription: transcription.trim(), raw: JSON.stringify(deterministicProposal(graph)), graph }) };
  }
  let raw = "";
  try {
    const prompt = `${notebookSystemPrompt(transcription, journey)}\n\n${verifiedEvidenceHint(graph)}\n只返回 JSON，不要 Markdown。kind 只能为 evidence、clarification 或 evidence_gap。evidence 必须提供 sourceIds 与 path；clarification 必须提供 text 与至少两个 candidates；association 如有必须以文化联想表达，不能陈述事实。`;
    try {
      await session.prompt(prompt);
      await session.waitForIdle();
      raw = textFromLastAssistant(session);
    } catch {
      raw = JSON.stringify(deterministicProposal(graph));
    }
    const parsed = (() => { try { return JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return null; } })();
    if (!parsed || typeof parsed !== "object") raw = JSON.stringify(deterministicProposal(graph));
    return { status: "ok", outcome: normalizeSeekOutcome({ transcription: transcription.trim(), raw, graph }) };
  } finally {
    session.dispose();
  }
}
