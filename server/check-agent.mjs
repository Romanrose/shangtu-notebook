import { allowedTools, clarify, createPiNotebookSession, notebookSystemPrompt } from "./notebook-agent.mjs";
import { retrieveFixture } from "./cnkgraph-fixture.mjs";
import { createNotebookServer } from "./notebook-server.mjs";
import { runFixtureSeek } from "./fixture-seek.mjs";
import { runSeek } from "./run-seek.mjs";
import { normalizeSeekOutcome } from "./seek-outcome.mjs";
import { invokePaddleOcr } from "./providers/paddleocr.mjs";
import { benchmarkTranscription, characterErrorRate } from "./transcription-benchmark.mjs";
import { createTranscription } from "./transcription-contract.mjs";
import { fixtureTranscription, runTranscriptionProvider, transcribeInk } from "./transcription-adapter.mjs";

const tinyInk = { mimeType: "image/png", data: "data:image/png;base64,iVBORw0KGgo=" };

async function withServer(options, callback) {
  const server = createNotebookServer(options);
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
const unconfiguredTranscription = await transcribeInk({ image: tinyInk });
if (unconfiguredTranscription.status !== "vision_unconfigured" || unconfiguredTranscription.providerStatus !== "unconfigured") throw new Error("未配置视觉模型时必须显式降级。");
const invalidTranscription = await transcribeInk({ image: { mimeType: "image/jpeg", data: "invalid" } });
if (invalidTranscription.status !== "invalid_ink" || invalidTranscription.providerStatus !== "rejected") throw new Error("视觉适配器没有拒绝非 PNG 笔迹。");
const fixtureTranscriptionResult = await transcribeInk({ image: tinyInk, fixtureMode: true });
if (fixtureTranscriptionResult.status !== "ok" || fixtureTranscriptionResult.transcription?.text !== fixtureTranscription || fixtureTranscriptionResult.transcription?.candidates.length !== 0 || fixtureTranscriptionResult.providerStatus !== "fixture") throw new Error("演练转写没有被明确标记且保留固定文本。");
const providerResult = await runTranscriptionProvider({ invoke: async () => ({ text: "李白是谁？", candidates: ["李白是哪位？"] }) });
if (providerResult.status !== "ok" || providerResult.transcription?.candidates[0] !== "李白是哪位？" || providerResult.providerStatus !== "ready") throw new Error("受控转写服务没有收敛为合同结果。");
const timedOutProvider = await runTranscriptionProvider({ invoke: () => new Promise(() => {}), timeoutMs: 1 });
if (timedOutProvider.status !== "vision_timed_out" || timedOutProvider.providerStatus !== "timed_out") throw new Error("转写超时没有安全降级。");
const unavailableProvider = await runTranscriptionProvider({ invoke: async () => { throw new Error("network unavailable"); } });
if (unavailableProvider.status !== "vision_unavailable" || unavailableProvider.providerStatus !== "unavailable") throw new Error("转写不可用没有安全降级。");
const delegatedProvider = await transcribeInk({ image: tinyInk, provider: "test", modelId: "test", invokeProvider: async () => ({ text: "李白是谁？" }) });
if (delegatedProvider.status !== "ok" || delegatedProvider.transcription?.text !== "李白是谁？") throw new Error("已配置转写没有经过受控限时适配器。");
const paddleResponse = { result: { dataInfo: { width: 100, height: 50 }, ocrResults: [{ prunedResult: { rec_texts: ["李白", "是谁？"], rec_boxes: [[10, 5, 40, 20], [45, 5, 95, 20]] } }] } };
const paddleResult = await invokePaddleOcr({ image: tinyInk, endpoint: "http://paddle.test/ocr", fetchImpl: async (url, options) => {
  if (url !== "http://paddle.test/ocr" || options.method !== "POST" || JSON.parse(options.body).fileType !== 1 || JSON.parse(options.body).file !== "iVBORw0KGgo=") throw new Error("PaddleOCR 请求合同错误。");
  return { ok: true, json: async () => paddleResponse };
} });
if (paddleResult?.text !== "李白是谁？" || paddleResult.lines?.[0].box.x !== 0.1) throw new Error("PaddleOCR 响应没有映射为转写合同。");
const previousPaddleEndpoint = process.env.PADDLEOCR_ENDPOINT;
process.env.PADDLEOCR_ENDPOINT = "http://paddle.test/ocr";
try {
  const configuredPaddle = await transcribeInk({ image: tinyInk, provider: "paddleocr", modelId: "PP-OCRv5", fetchImpl: async () => ({ ok: true, json: async () => paddleResponse }) });
  if (configuredPaddle.status !== "ok" || configuredPaddle.providerStatus !== "ready" || configuredPaddle.transcription?.text !== "李白是谁？") throw new Error("PaddleOCR 没有经过统一转写适配器。");
} finally {
  if (previousPaddleEndpoint === undefined) delete process.env.PADDLEOCR_ENDPOINT;
  else process.env.PADDLEOCR_ENDPOINT = previousPaddleEndpoint;
}
const normalizedTranscription = createTranscription({ text: "  李白是谁？ ", candidates: ["李白是谁？", "李白的字是什么？"], lines: [{ text: "李白是谁？", box: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } }, { text: "越界", box: { x: 0.9, y: 0.1, width: 0.2, height: 0.1 } }] });
if (normalizedTranscription?.text !== "李白是谁？" || normalizedTranscription.candidates.length !== 1 || normalizedTranscription.lines?.length !== 1) throw new Error("转写合同没有收敛文本、候选与相对行框。");
if (characterErrorRate("李白", "李賀") !== 1 / 2 || characterErrorRate("", "李白") !== 1) throw new Error("中文字符错误率计算错误。");
const benchmarkTicks = [0, 8, 10, 22, 30, 45];
const benchmark = await benchmarkTranscription({
  cases: [{ id: "test", expected: "李白", image: tinyInk }],
  runs: 3,
  now: () => benchmarkTicks.shift(),
  transcribe: async () => ({ status: "ok", providerStatus: "test", transcription: { text: "李白", candidates: [] } }),
});
if (!benchmark[0].exact || benchmark[0].characterErrorRate !== 0 || benchmark[0].p50Ms !== 12 || benchmark[0].p95Ms !== 15) throw new Error("转写基准计时或报告合同错误。");
const fixtureSeek = await runFixtureSeek({ transcription: fixtureTranscription, image: tinyInk });
if (fixtureSeek.status !== "ok" || fixtureSeek.outcome.kind !== "evidence") throw new Error("演练寻迹没有经过受限 Pi 输出核验。");
await withServer({
  transcribe: async ({ image }) => image?.data === tinyInk.data ? { status: "ok", transcription: { text: "李白写过什么？", candidates: [] }, providerStatus: "test" } : { status: "invalid_ink" },
  seek: async ({ transcription, image }) => ({ status: transcription === "李白写过什么？" && image?.data === tinyInk.data ? "model_unconfigured" : "needs_transcription" }),
}, async (origin) => {
  const transcribe = await fetch(`${origin}/api/transcribe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: tinyInk }) });
  if ((await transcribe.json()).transcription?.text !== "李白写过什么？") throw new Error("转写 API 没有只返回服务端适配器结果。");
  const seek = await fetch(`${origin}/api/seek`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcription: "李白写过什么？", image: tinyInk }) });
  if ((await seek.json()).status !== "model_unconfigured") throw new Error("寻迹 API 没有保留安全降级状态。");
  const forbidden = await fetch(`${origin}/api/anything`, { method: "POST" });
  if (forbidden.status !== 404) throw new Error("API 暴露了白名单之外的路径。");
});
const previousFixtureMode = process.env.NOTEBOOK_FIXTURE_MODE;
process.env.NOTEBOOK_FIXTURE_MODE = "1";
try {
  await withServer(undefined, async (origin) => {
    const transcribe = await fetch(`${origin}/api/transcribe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: tinyInk }) });
    const transcription = await transcribe.json();
    if (transcription.status !== "ok" || transcription.providerStatus !== "fixture" || transcription.transcription?.text !== fixtureTranscription) throw new Error("服务端演练转写 API 未保留明确标记。");
    const seek = await fetch(`${origin}/api/seek`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcription: transcription.transcription.text, image: tinyInk }) });
    const result = await seek.json();
    if (result.status !== "ok" || result.outcome?.kind !== "evidence") throw new Error("服务端演练链路未产出已核验旁批。");
  });
} finally {
  if (previousFixtureMode === undefined) delete process.env.NOTEBOOK_FIXTURE_MODE;
  else process.env.NOTEBOOK_FIXTURE_MODE = previousFixtureMode;
}
const session = await createPiNotebookSession({ retrieve: async () => ({ kind: "evidence_gap" }) });
if (session !== null && !process.env.PI_MODEL_PROVIDER) throw new Error("未配置模型时不应创建 Pi 会话。");
session?.session.dispose();
console.log("Pi notebook adapter contract verified.");
