import { allowedTools, clarify, createPiNotebookSession, notebookSystemPrompt } from "./notebook-agent.mjs";
import { retrieveFixture } from "./cnkgraph-fixture.mjs";
import { createNotebookServer } from "./notebook-server.mjs";
import { runSeek } from "./run-seek.mjs";
import { normalizeSeekOutcome } from "./seek-outcome.mjs";
import { transcribeInk } from "./transcription-adapter.mjs";

const tinyInk = { mimeType: "image/png", data: "data:image/png;base64,iVBORw0KGgo=" };

async function withServer(callback) {
  const server = createNotebookServer({
    transcribe: async ({ image }) => image?.data === tinyInk.data ? { status: "ok", transcription: "李白写过什么？" } : { status: "invalid_ink" },
    seek: async ({ transcription, image }) => ({ status: transcription === "李白写过什么？" && image?.data === tinyInk.data ? "model_unconfigured" : "needs_transcription" }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试 API 未能监听端口。");
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const expected = ["clarify_entity", "retrieve_cnkgraph", "validate_evidence", "compose_annotation"];
if (JSON.stringify(allowedTools) !== JSON.stringify(expected)) throw new Error("Pi 工具白名单发生漂移。");
if (clarify("李贺写过什么？").kind !== "clarification") throw new Error("实体歧义未进入澄清分支。");
if (!notebookSystemPrompt("李白是谁？").includes("只使用给定工具")) throw new Error("Pi 系统约束缺失。");
const evidence = await retrieveFixture("李白到长安以后");
if (evidence.kind !== "evidence" || evidence.sources.length === 0) throw new Error("CNKGraph 演示夹具没有保留来源。");
if (evidence.nodes.length !== 2 || evidence.edges.length !== 1) throw new Error("CNKGraph 演示夹具不再是有界子图。");
if (!evidence.sources.every((source) => source.url && source.claim)) throw new Error("CNKGraph 演示夹具的来源不可追溯。");
const gap = await retrieveFixture("珊瑚与唐诗");
if (gap.kind !== "evidence_gap" || gap.sources.length !== 0) throw new Error("证据缺口夹具边界错误。");
const verifiedEvidence = normalizeSeekOutcome({
  transcription: "李白写过《将进酒》吗？",
  raw: JSON.stringify({ kind: "evidence", text: "李白生活在盛唐。", sourceIds: ["source:jiangjinjiu-li-bai"], path: ["李白", "作者", "将进酒"], association: "可从酒诗再读。" }),
  graph: evidence,
});
if (verifiedEvidence.kind !== "evidence" || verifiedEvidence.evidence !== "当前图谱记录：李白是《将进酒》的作者。") throw new Error("证据正文没有由图谱边确定性生成。");
if (verifiedEvidence.association !== "联想：可从酒诗再读。") throw new Error("联想没有被显式标注。");
const factualAssociation = normalizeSeekOutcome({
  transcription: "李白写过《将进酒》吗？",
  raw: JSON.stringify({ kind: "evidence", sourceIds: ["source:jiangjinjiu-li-bai"], path: ["李白", "作者", "将进酒"], association: "写于762年。" }),
  graph: evidence,
});
if (factualAssociation.kind !== "evidence" || factualAssociation.association !== null) throw new Error("带年代的联想没有被拒绝。");
const forgedEvidence = normalizeSeekOutcome({
  transcription: "李白写过《将进酒》吗？",
  raw: JSON.stringify({ kind: "evidence", sourceIds: ["fabricated-source"], path: ["李白", "作者", "将进酒"] }),
  graph: evidence,
});
if (forgedEvidence.kind !== "gap") throw new Error("伪造来源没有降级为证据缺口。");
const malformedEvidence = normalizeSeekOutcome({ transcription: "李白写过什么？", raw: "并非 JSON", graph: evidence });
if (malformedEvidence.kind !== "gap") throw new Error("无效 Pi 输出没有降级为证据缺口。");
const clarification = normalizeSeekOutcome({
  transcription: "李贺和长安有什么关联？",
  raw: JSON.stringify({ kind: "clarification", text: "你想寻哪一位？", candidates: ["李贺", "李白"] }),
  graph: gap,
});
if (clarification.kind !== "ambiguous" || clarification.candidates.length !== 2) throw new Error("澄清结果没有保留候选项。");
const fakeSession = {
  messages: [{ role: "assistant", content: [{ type: "text", text: JSON.stringify({ kind: "evidence", sourceIds: ["source:jiangjinjiu-li-bai"], path: ["李白", "作者", "将进酒"] }) }] }],
  prompt: async () => {}, waitForIdle: async () => {}, dispose: () => {},
};
const seekOutcome = await runSeek({ transcription: "李白写过《将进酒》吗？", createSession: async () => fakeSession, retrieve: retrieveFixture });
if (seekOutcome.status !== "ok" || seekOutcome.outcome.kind !== "evidence") throw new Error("寻迹没有只返回规范化 outcome。");
if ((await runSeek({ transcription: "李白是谁？" })).status !== "model_unconfigured") throw new Error("未配置模型时必须显式降级。");
if ((await transcribeInk({ image: tinyInk })).status !== "vision_unconfigured") throw new Error("未配置视觉模型时必须显式降级。");
if ((await transcribeInk({ image: { mimeType: "image/jpeg", data: "invalid" } })).status !== "invalid_ink") throw new Error("视觉适配器没有拒绝非 PNG 笔迹。");
await withServer(async (origin) => {
  const transcribe = await fetch(`${origin}/api/transcribe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: tinyInk }) });
  if ((await transcribe.json()).transcription !== "李白写过什么？") throw new Error("转写 API 没有只返回服务端适配器结果。");
  const seek = await fetch(`${origin}/api/seek`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcription: "李白写过什么？", image: tinyInk }) });
  if ((await seek.json()).status !== "model_unconfigured") throw new Error("寻迹 API 没有保留安全降级状态。");
  const forbidden = await fetch(`${origin}/api/anything`, { method: "POST" });
  if (forbidden.status !== 404) throw new Error("API 暴露了白名单之外的路径。");
});
const session = await createPiNotebookSession({ retrieve: async () => ({ kind: "evidence_gap" }) });
if (session !== null && !process.env.PI_MODEL_PROVIDER) throw new Error("未配置模型时不应创建 Pi 会话。");
session?.session.dispose();
console.log("Pi notebook adapter contract verified.");
