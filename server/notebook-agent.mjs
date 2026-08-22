import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const allowedTools = ["clarify_entity", "retrieve_cnkgraph", "validate_evidence", "compose_annotation"];

export function createNotebookExtension({ retrieve }) {
  return (pi) => {
    pi.registerTool({
      name: "clarify_entity",
      label: "澄清实体",
      description: "Return candidates only when the handwriting text is ambiguous. Never choose silently.",
      parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 160 }) }),
      execute: async (_id, { text }) => ({ content: [{ type: "text", text: JSON.stringify(clarify(text)) }], details: {} }),
    });
    pi.registerTool({
      name: "retrieve_cnkgraph",
      label: "检索寻迹",
      description: "Retrieve a bounded, source-backed CNKGraph evidence path for an explicit entity or quotation.",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 160 }) }),
      execute: async (_id, { query }) => ({ content: [{ type: "text", text: JSON.stringify(await retrieve(query)) }], details: {} }),
    });
    pi.registerTool({
      name: "validate_evidence",
      label: "核对出处",
      description: "Reject any proposed factual wording without an existing source reference.",
      parameters: Type.Object({ claim: Type.String(), sources: Type.Array(Type.String()) }),
      execute: async (_id, { claim, sources }) => ({ content: [{ type: "text", text: JSON.stringify({ claim, supported: sources.length > 0, sources }) }], details: {} }),
    });
    pi.registerTool({
      name: "compose_annotation",
      label: "书页旁批",
      description: "Compose a short paper-margin annotation labelled either evidence, association, clarification, or evidence_gap.",
      parameters: Type.Object({ kind: Type.Union([Type.Literal("evidence"), Type.Literal("association"), Type.Literal("clarification"), Type.Literal("evidence_gap")]), text: Type.String({ maxLength: 120 }) }),
      execute: async (_id, annotation) => ({ content: [{ type: "text", text: JSON.stringify(annotation) }], details: {} }),
    });
  };
}

export function clarify(text) {
  if (/李賀|李贺/.test(text)) {
    return { kind: "clarification", annotation: "你写的是李白，还是李贺？", candidates: ["李白", "李贺"] };
  }
  return { kind: "not_needed" };
}

export async function createPiNotebookSession({ retrieve, provider = process.env.PI_MODEL_PROVIDER, modelId = process.env.PI_MODEL_ID }) {
  if (!provider || !modelId) return null;
  const model = getModel(provider, modelId);
  if (!model) throw new Error(`Pi 未找到模型 ${provider}/${modelId}。`);
  const modelRuntime = await ModelRuntime.create();
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    settingsManager,
    extensionFactories: [createNotebookExtension({ retrieve })],
    // This is a product agent, not a coding agent: load no ambient tools or files.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: notebookSystemPrompt("（由本次笔迹图像转写后提供）"),
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    model,
    modelRuntime,
    resourceLoader: loader,
    tools: allowedTools,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });
  const active = session.getActiveToolNames().sort();
  if (JSON.stringify(active) !== JSON.stringify([...allowedTools].sort())) {
    session.dispose();
    throw new Error(`Pi 工具面不符合白名单：${active.join(", ") || "（空）"}`);
  }
  return session;
}

const JOURNEY_ROUTE_LABELS = { life: "经历线", space: "地点线", work: "作品线" };

/**
 * 旅程上下文注入：让同一人物旅程中的每一次寻迹都带着锚点、路线与最近线索，
 * Pi 因此具备多轮连贯感，而不需要服务端保存任何会话状态。
 */
export function journeyContext(journey) {
  if (!journey?.anchor) return "";
  const route = journey.route ? JOURNEY_ROUTE_LABELS[journey.route] ?? journey.route : null;
  const lines = [`当前人物旅程锚点：${journey.anchor}${journey.dynasty ? `（${journey.dynasty}）` : ""}${route ? `，正在沿${route}寻迹` : ""}。`];
  const history = (journey.history ?? []).slice(-6);
  if (history.length > 0) {
    lines.push(`最近已核验线索：${history.map((entry) => entry.path.join("→")).join("；")}。新旁批应与这条旅程线呼应，不重复已给出的内容。`);
  }
  return `${lines.join("\n")}\n`;
}

export function notebookSystemPrompt(transcription, journey) {
  return `你是“时空探索手札”纸页背后的 Pi。用户笔迹转写为：${transcription}\n` +
    journeyContext(journey) +
    "只使用给定工具。先澄清歧义，再检索和核对来源。事实旁批只写已核对的内容；模型补充必须以“联想：”开头。输出短、适合页边的中文。";
}

/** 联想专用提示：只做文化联想，禁止任何事实性断言。 */
export function narrativeSystemPrompt(anchor, route, step) {
  const routeLabel = JOURNEY_ROUTE_LABELS[route] ?? route;
  return `你是“时空探索手札”纸页背后的 Pi，正在为「${anchor}」的${routeLabel}（第${step + 1}拍）写一句页边文化联想。` +
    "联想只做文学性、感受性的表达（语气、意象、回声），严禁出现年代、出处、馆藏、作者关系或任何可核验事实。以“联想：”开头，60 字以内。";
}

export { allowedTools };
