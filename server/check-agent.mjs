import { EventEmitter } from "node:events";
import { allowedTools, clarify, createPiNotebookSession, notebookSystemPrompt } from "./notebook-agent.mjs";
import { retrieveFixture } from "./cnkgraph-fixture.mjs";
import { createNotebookServer } from "./notebook-server.mjs";
import { runFixtureSeek } from "./fixture-seek.mjs";
import { runSeek } from "./run-seek.mjs";
import { normalizeSeekOutcome } from "./seek-outcome.mjs";
import { invokeOpenAiCompatibleVlm } from "./providers/openai-compatible-vlm.mjs";
import { invokePaddleOcr } from "./providers/paddleocr.mjs";
import { invokePaddleOcrVl } from "./providers/paddleocr-vl.mjs";
import { invokeTesseract } from "./providers/tesseract.mjs";
import { benchmarkTranscription, characterErrorRate, summarizeTranscriptionBenchmark } from "./transcription-benchmark.mjs";
import { createTranscriptionManifest, sampleIdFromInkFile } from "./prepare-transcription-manifest.mjs";
import { validateConsentedUserCases } from "./transcription-manifest-contract.mjs";
import { summarizeTranscriptionTimings } from "./summarize-transcription-timings.mjs";
import { compareTranscriptionReports } from "./compare-transcription-reports.mjs";
import { validateTranscriptionCohort } from "./preflight-transcription.mjs";
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
if (fixtureTranscriptionResult.status !== "ok" || fixtureTranscriptionResult.transcription?.text !== fixtureTranscription || fixtureTranscriptionResult.transcription?.candidates.length !== 0 || fixtureTranscriptionResult.providerStatus !== "fixture" || fixtureTranscriptionResult.provider !== "fixture") throw new Error("演练转写没有被明确标记且保留固定文本。");
const providerResult = await runTranscriptionProvider({ invoke: async () => ({ text: "李白是谁？", candidates: ["李白是哪位？"] }) });
if (providerResult.status !== "ok" || providerResult.transcription?.candidates[0] !== "李白是哪位？" || providerResult.providerStatus !== "ready") throw new Error("受控转写服务没有收敛为合同结果。");
const timedOutProvider = await runTranscriptionProvider({ invoke: () => new Promise(() => {}), timeoutMs: 1 });
if (timedOutProvider.status !== "vision_timed_out" || timedOutProvider.providerStatus !== "timed_out") throw new Error("转写超时没有安全降级。");
const unavailableProvider = await runTranscriptionProvider({ invoke: async () => { throw new Error("network unavailable"); } });
if (unavailableProvider.status !== "vision_unavailable" || unavailableProvider.providerStatus !== "unavailable") throw new Error("转写不可用没有安全降级。");
const delegatedProvider = await transcribeInk({ image: tinyInk, provider: "test", modelId: "test", invokeProvider: async () => ({ text: "李白是谁？" }) });
if (delegatedProvider.status !== "ok" || delegatedProvider.transcription?.text !== "李白是谁？") throw new Error("已配置转写没有经过受控限时适配器。");
const previousMissingPaddleEndpoint = process.env.PADDLEOCR_ENDPOINT;
delete process.env.PADDLEOCR_ENDPOINT;
const missingPaddleEndpoint = await transcribeInk({ image: tinyInk, provider: "paddleocr", modelId: "PP-OCRv5" });
if (missingPaddleEndpoint.status !== "vision_unconfigured" || missingPaddleEndpoint.providerStatus !== "unconfigured") throw new Error("PaddleOCR 缺少 endpoint 时没有安全降级。");
if (previousMissingPaddleEndpoint !== undefined) process.env.PADDLEOCR_ENDPOINT = previousMissingPaddleEndpoint;
const paddleResponse = { result: { dataInfo: { width: 100, height: 50 }, ocrResults: [{ prunedResult: { rec_texts: ["李白", "是谁？"], rec_boxes: [[10, 5, 40, 20], [45, 5, 95, 20]] } }] } };
const paddleResult = await invokePaddleOcr({ image: tinyInk, endpoint: "http://paddle.test/ocr", fetchImpl: async (url, options) => {
  if (url !== "http://paddle.test/ocr" || options.method !== "POST" || JSON.parse(options.body).fileType !== 1 || JSON.parse(options.body).file !== "iVBORw0KGgo=") throw new Error("PaddleOCR 请求合同错误。");
  return { ok: true, json: async () => paddleResponse };
} });
if (paddleResult?.text !== "李白是谁？" || paddleResult.lines?.[0].box.x !== 0.1) throw new Error("PaddleOCR 响应没有映射为转写合同。");
const configuredPaddle = await transcribeInk({ image: tinyInk, provider: "paddleocr", modelId: "PP-OCRv5", endpoint: "http://paddle.test/ocr", fetchImpl: async () => ({ ok: true, json: async () => paddleResponse }) });
if (configuredPaddle.status !== "ok" || configuredPaddle.providerStatus !== "ready" || configuredPaddle.provider !== "paddleocr" || configuredPaddle.transcription?.text !== "李白是谁？") throw new Error("PaddleOCR 没有经过统一转写适配器。");
const paddleVlResponse = { result: { dataInfo: { width: 100, height: 50 }, layoutParsingResults: [{ prunedResult: { parsing_res_list: [{ block_content: "李白是谁？", block_bbox: [10, 5, 90, 25] }] } }] } };
const paddleVlResult = await invokePaddleOcrVl({ image: tinyInk, endpoint: "http://paddle-vl.test/layout-parsing", fetchImpl: async (url, options) => {
  if (url !== "http://paddle-vl.test/layout-parsing" || options.method !== "POST" || JSON.parse(options.body).fileType !== 1 || JSON.parse(options.body).visualize !== false) throw new Error("PaddleOCR-VL 请求合同错误。");
  return { ok: true, json: async () => paddleVlResponse };
} });
if (paddleVlResult?.text !== "李白是谁？" || paddleVlResult.lines?.[0].box.x !== 0.1) throw new Error("PaddleOCR-VL 响应没有映射为转写合同。");
const missingPaddleVlEndpoint = await transcribeInk({ image: tinyInk, provider: "paddleocr-vl", modelId: "PaddleOCR-VL-0.9B" });
if (missingPaddleVlEndpoint.status !== "vision_unconfigured" || missingPaddleVlEndpoint.providerStatus !== "unconfigured") throw new Error("PaddleOCR-VL 缺少 endpoint 时没有安全降级。");
const configuredPaddleVl = await transcribeInk({ image: tinyInk, provider: "paddleocr-vl", modelId: "PaddleOCR-VL-0.9B", vlEndpoint: "http://paddle-vl.test/layout-parsing", fetchImpl: async () => ({ ok: true, json: async () => paddleVlResponse }) });
if (configuredPaddleVl.status !== "ok" || configuredPaddleVl.providerStatus !== "ready" || configuredPaddleVl.transcription?.text !== "李白是谁？") throw new Error("PaddleOCR-VL 没有经过统一转写适配器。");
const missingTesseract = await transcribeInk({ image: tinyInk, provider: "tesseract", modelId: "chi_sim" });
if (missingTesseract.status !== "vision_unconfigured" || missingTesseract.providerStatus !== "unconfigured") throw new Error("Tesseract 缺少服务端 binary 时没有安全降级。");
const fakeTesseractSpawn = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = { end: () => queueMicrotask(() => { child.stdout.emit("data", Buffer.from("李白是谁？\n")); child.emit("close", 0); }) };
  child.kill = () => {};
  return child;
};
const tesseractResult = await invokeTesseract({ image: tinyInk, command: "tesseract", language: "chi_sim", spawnImpl: fakeTesseractSpawn });
if (tesseractResult?.text !== "李白是谁？") throw new Error("Tesseract stdout 没有映射为统一转写合同。");
const configuredTesseract = await transcribeInk({ image: tinyInk, provider: "tesseract", modelId: "chi_sim", tesseractBin: "tesseract", spawnImpl: fakeTesseractSpawn });
if (configuredTesseract.status !== "ok" || configuredTesseract.providerStatus !== "ready" || configuredTesseract.transcription?.text !== "李白是谁？") throw new Error("Tesseract 没有经过统一转写适配器。");
const missingVlmCredentials = await transcribeInk({ image: tinyInk, provider: "vlm-openai-compatible", modelId: "vision-test", vlmEndpoint: "http://vlm.test/v1/chat/completions", vlmApiKey: "" });
if (missingVlmCredentials.status !== "vision_unconfigured" || missingVlmCredentials.providerStatus !== "unconfigured") throw new Error("VLM 缺少服务端凭据时没有安全降级。");
const vlmResponse = { choices: [{ message: { content: JSON.stringify({ text: "李白是谁？", candidates: ["李白是哪位？"] }) } }] };
const vlmResult = await invokeOpenAiCompatibleVlm({ image: tinyInk, modelId: "vision-test", endpoint: "http://vlm.test/v1/chat/completions", apiKey: "secret-test", fetchImpl: async (url, options) => {
  const body = JSON.parse(options.body);
  if (url !== "http://vlm.test/v1/chat/completions" || options.method !== "POST" || options.headers.Authorization !== "Bearer secret-test" || body.model !== "vision-test" || body.messages?.[0]?.content?.[1]?.image_url?.url !== tinyInk.data) throw new Error("VLM 请求合同或服务端凭据边界错误。");
  return { ok: true, json: async () => vlmResponse };
} });
if (vlmResult?.text !== "李白是谁？" || vlmResult.candidates?.[0] !== "李白是哪位？") throw new Error("VLM JSON 响应没有映射为转写合同。");
const configuredVlm = await transcribeInk({ image: tinyInk, provider: "vlm-openai-compatible", modelId: "vision-test", vlmEndpoint: "http://vlm.test/v1/chat/completions", vlmApiKey: "secret-test", fetchImpl: async () => ({ ok: true, json: async () => vlmResponse }) });
if (configuredVlm.status !== "ok" || configuredVlm.providerStatus !== "ready" || configuredVlm.transcription?.text !== "李白是谁？") throw new Error("VLM 没有经过统一转写适配器。");
const normalizedTranscription = createTranscription({ text: "  李白是谁？ ", candidates: ["李白是谁？", "李白的字是什么？"], lines: [{ text: "李白是谁？", box: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } }, { text: "越界", box: { x: 0.9, y: 0.1, width: 0.2, height: 0.1 } }] });
if (normalizedTranscription?.text !== "李白是谁？" || normalizedTranscription.candidates.length !== 1 || normalizedTranscription.lines?.length !== 1) throw new Error("转写合同没有收敛文本、候选与相对行框。");
if (characterErrorRate("李白", "李賀") !== 1 / 2 || characterErrorRate("", "李白") !== 1) throw new Error("中文字符错误率计算错误。");
const benchmarkTicks = [0, 8, 10, 22, 30, 45];
const benchmark = await benchmarkTranscription({
  cases: [{ id: "test", expected: "李白", image: tinyInk }],
  runs: 3,
  warmup: 1,
  now: () => benchmarkTicks.shift(),
  transcribe: async () => ({ status: "ok", providerStatus: "test", transcription: { text: "李白", candidates: [] } }),
});
if (!benchmark[0].exact || benchmark[0].characterErrorRate !== 0 || benchmark[0].warmup !== 1 || benchmark[0].p50Ms !== 12 || benchmark[0].p95Ms !== 15) throw new Error("转写基准计时或报告合同错误。");
const qualityTicks = [0, 5, 5, 10, 10, 15];
let qualityRun = 0;
const qualityBenchmark = await benchmarkTranscription({
  cases: [{ id: "quality", expected: "李白", image: tinyInk }],
  runs: 3,
  now: () => qualityTicks.shift(),
  transcribe: async () => [
    { status: "ok", providerStatus: "ready", transcription: { text: "李白?", candidates: ["李白"] } },
    { status: "vision_unavailable", providerStatus: "unavailable" },
    { status: "ok", providerStatus: "ready", transcription: { text: "李白", candidates: [] } },
  ][qualityRun++],
});
const qualityResult = qualityBenchmark[0];
if (qualityResult.okRate !== 2 / 3 || qualityResult.exactRate !== 1 / 3 || qualityResult.candidateHitRate !== 2 / 3 || qualityResult.statusCounts.ready !== 2 || qualityResult.statusCounts.unavailable !== 1) throw new Error("转写基准没有记录可用率、候选命中率或状态计数。");
const qualitySummary = summarizeTranscriptionBenchmark(qualityBenchmark);
if (qualitySummary.samples !== 1 || qualitySummary.totalRuns !== 3 || qualitySummary.meanExactRate !== 1 / 3 || qualitySummary.meanCandidateHitRate !== 2 / 3 || qualitySummary.sampleExactAtLeastOnceRate !== 1 || qualitySummary.sampleExactStableRate !== 0 || qualitySummary.sampleCandidateHitStableRate !== 0 || qualitySummary.statusCounts.unavailable !== 1) throw new Error("转写基准汇总没有保留 provider 决策所需的质量和稳定性指标。");
const failedQualityBenchmark = await benchmarkTranscription({
  cases: [{ id: "failed-quality", expected: "李白", image: tinyInk }],
  runs: 1,
  transcribe: async () => ({ status: "vision_timed_out", providerStatus: "timed_out" }),
});
if (failedQualityBenchmark[0].exact !== null || failedQualityBenchmark[0].characterErrorRate !== null || failedQualityBenchmark[0].okRate !== 0 || failedQualityBenchmark[0].statusCounts.timed_out !== 1) throw new Error("超时样本被错误计入识别质量，或没有保留超时状态。");
const metadataBenchmark = await benchmarkTranscription({
  cases: [{ id: "metadata", expected: "李白", metadata: { writer: "writer-a", inputMode: "stylus", orientation: "portrait", textType: "person" }, image: tinyInk }],
  runs: 1,
  transcribe: async () => ({ status: "ok", providerStatus: "ready", transcription: { text: "李白", candidates: [] } }),
});
if (metadataBenchmark[0].metadata?.inputMode !== "stylus" || metadataBenchmark[0].metadata?.orientation !== "portrait") throw new Error("样本分层元数据没有透传到基准报告。");
const preparedManifest = createTranscriptionManifest({ files: ["sample-a.png"], expected: ["李白是谁？"], metadata: { writer: "writer-a", inputMode: "stylus" } });
if (preparedManifest[0].imagePath !== "sample-a.png" || preparedManifest[0].metadata?.inputMode !== "stylus") throw new Error("本地样本标注助手没有生成规范清单。");
if (sampleIdFromInkFile("shangtu-ink-abc123def456-page-01-20260813012345.png") !== "abc123def456" || sampleIdFromInkFile("writer-a.png") !== null) throw new Error("导出 PNG 的匿名 sampleId 没有被安全提取。");
const pairedManifest = createTranscriptionManifest({ files: ["shangtu-ink-abc123def456-page-01-20260813012345.png"], expected: ["李白是谁？"] });
if (pairedManifest[0].id !== "abc123def456") throw new Error("导出 PNG 的 sampleId 没有透传到 manifest。");
try { createTranscriptionManifest({ files: ["shangtu-ink-abc123def456-page-01-20260813012345.png", "shangtu-ink-abc123def456-page-02-20260813012346.png"], expected: ["李白", "李白"] }); throw new Error("样本清单允许了重复匿名 sampleId。"); } catch (error) { if (!(error instanceof Error) || !error.message.includes("重复 sampleId")) throw error; }
const preparedConsentedManifest = createTranscriptionManifest({ files: ["sample-a.png"], expected: ["李白是谁？"], metadata: { evidence: "consented_user", cohortId: "user-cohort-a", consent: "confirmed" } });
if (preparedConsentedManifest[0].metadata?.evidence !== "consented_user" || preparedConsentedManifest[0].metadata?.consent !== "confirmed") throw new Error("本地样本标注助手没有保留授权来源元数据。");
try { createTranscriptionManifest({ files: ["sample-a.png"], expected: ["李白是谁？"], metadata: { evidence: "consented_user", cohortId: "user-cohort-a" } }); throw new Error("本地样本标注助手允许了未确认授权的清单。"); } catch (error) { if (!(error instanceof Error) || !error.message.includes("consent=confirmed")) throw error; }
validateConsentedUserCases([{ id: "a", expected: "李白是谁？", metadata: { evidence: "consented_user", cohortId: "user-cohort-a", consent: "confirmed" } }]);
try { validateConsentedUserCases([{ id: "a", expected: "李白是谁？", metadata: { evidence: "consented_user", cohortId: "user-cohort-a" } }]); throw new Error("benchmark 允许了缺少 confirmed 授权状态的样本。"); } catch (error) { if (!(error instanceof Error) || !error.message.includes("consent=confirmed")) throw error; }
try { createTranscriptionManifest({ files: ["../outside.png"], expected: ["李白"] }); throw new Error("样本清单允许了目录外路径。"); } catch (error) { if (!(error instanceof Error) || !error.message.includes("顶层")) throw error; }
const unlabeledBenchmark = await benchmarkTranscription({
  cases: [{ id: "unlabeled", image: tinyInk }],
  runs: 2,
  transcribe: async () => ({ status: "ok", providerStatus: "ready", transcription: { text: "未标注结果", candidates: [] } }),
});
const unlabeledSummary = summarizeTranscriptionBenchmark(unlabeledBenchmark);
if (unlabeledBenchmark[0].exact !== null || unlabeledBenchmark[0].characterErrorRate !== null || unlabeledBenchmark[0].exactRate !== null || unlabeledSummary.meanExactRate !== null || unlabeledSummary.sampleExactStableRate !== null || unlabeledSummary.meanOkRate !== 1) throw new Error("未标注基准没有只保留可用率和延迟，或错误计算了质量指标。");
const timingSummary = summarizeTranscriptionTimings([
  { schema: "shangtu-transcription-timing-v1", page: 1, sampleId: "abc123def456", timings: [{ event: "pen_up", elapsedMs: 0 }, { event: "local_awakening", elapsedMs: 281 }, { event: "transcription_request", elapsedMs: 762 }, { event: "transcription_result", elapsedMs: 910, status: "vision_unavailable", providerStatus: "unavailable", provider: "paddleocr" }, { event: "transcription_confirmed", elapsedMs: 1200, edited: false }] },
  { schema: "shangtu-transcription-timing-v1", page: 2, timings: [{ event: "pen_up", elapsedMs: 0 }, { event: "local_awakening", elapsedMs: 279 }, { event: "transcription_request", elapsedMs: 760 }, { event: "transcription_result", elapsedMs: 8000, status: "vision_timed_out", providerStatus: "timed_out" }] },
  { schema: "shangtu-transcription-timing-v1", page: 3, timings: [{ event: "pen_up", elapsedMs: 0 }, { event: "local_awakening", elapsedMs: 282 }] },
  { schema: "shangtu-transcription-timing-v1", page: 4, timings: [{ event: "pen_up", elapsedMs: 0 }, { event: "local_awakening", elapsedMs: 300 }, { event: "transcription_result", elapsedMs: 900, status: "ok", providerStatus: "ready", provider: "paddleocr" }, { event: "transcription_confirmed", elapsedMs: 1500, edited: true }] },
]);
if (timingSummary.trials !== 4 || timingSummary.sampleIdCoverage !== 1 / 4 || timingSummary.sampleIds[0] !== "abc123def456" || timingSummary.localAwakening.p50Ms !== 281 || timingSummary.transcriptionResult.count !== 3 || timingSummary.confirmation.count !== 2 || timingSummary.resultAvailableRate !== 3 / 4 || timingSummary.confirmationAvailableRate !== 1 / 2 || timingSummary.editedConfirmationRate !== 1 / 2 || timingSummary.byProviderStatus.length !== 4 || timingSummary.byProviderStatus[0].provider !== "paddleocr" || timingSummary.byProviderStatus[0].confirmation.count !== 1 || timingSummary.byProviderStatus[0].confirmationAvailableRate !== 1 || timingSummary.byProviderStatus[0].editedConfirmationRate !== 0) throw new Error("时延汇总没有保留 sampleId，或没有区分 provider、本地苏醒、服务结果、确认时延和修改率。");
const attributedTimingSummary = summarizeTranscriptionTimings([
  { schema: "shangtu-transcription-timing-v1", sampleId: "a".repeat(12), timings: [{ event: "pen_up", elapsedMs: 0 }, { event: "transcription_result", elapsedMs: 100, status: "vision_unavailable", providerStatus: "unavailable" }] },
  { schema: "shangtu-transcription-timing-v1", sampleId: "b".repeat(12), timings: [{ event: "pen_up", elapsedMs: 0 }, { event: "transcription_result", elapsedMs: 110, status: "ok", providerStatus: "ready", provider: "paddleocr" }, { event: "transcription_confirmed", elapsedMs: 200, edited: false }] },
], { provider: "paddleocr" });
if (attributedTimingSummary.provider !== "paddleocr" || attributedTimingSummary.byProviderStatus.length !== 2 || attributedTimingSummary.byProviderStatus[0].provider !== "paddleocr" || attributedTimingSummary.byProviderStatus[0].trials !== 1 || attributedTimingSummary.byProviderStatus[1].provider !== "paddleocr" || attributedTimingSummary.byProviderStatus[1].trials !== 1 || attributedTimingSummary.confirmationAvailableRate !== 1 / 2) throw new Error("显式 provider 没有把失败样本计入同一 provider 的 timing 分母。");
const preflightIds = ["a", "b"].map((id) => id.repeat(12));
const preflightResult = validateTranscriptionCohort({
  manifest: preflightIds.map((id) => ({ id, expected: "李白是谁？", imagePath: `${id}.png`, metadata: { evidence: "consented_user", cohortId: "user-cohort-a", consent: "confirmed" } })),
  timingPayloads: preflightIds.map((sampleId, index) => ({ schema: "shangtu-transcription-timing-v1", sampleId, timings: [{ event: "pen_up", elapsedMs: 0 }, { event: "transcription_result", elapsedMs: 100 + index, status: "ok", providerStatus: "ready", provider: "paddleocr" }, { event: "transcription_confirmed", elapsedMs: 200 + index, edited: index === 1 }] })),
  provider: "paddleocr",
});
if (preflightResult.status !== "ready" || !preflightResult.comparisonReady || preflightResult.confirmationAvailableRate !== 1 || preflightResult.editedConfirmationRate !== 1 / 2) throw new Error("最终实验 preflight 没有验证样本配对、provider 归因和确认率。");
const incompletePreflight = validateTranscriptionCohort({ manifest: [{ id: preflightIds[0], expected: "李白", imagePath: "a.png", metadata: { evidence: "consented_user", cohortId: "user-cohort-a", consent: "confirmed" } }], timingPayloads: [{ schema: "shangtu-transcription-timing-v1", sampleId: preflightIds[0], timings: [{ event: "pen_up", elapsedMs: 0 }] }] });
if (incompletePreflight.comparisonReady || incompletePreflight.status !== "needs_result_or_confirmation") throw new Error("最终实验 preflight 接受了缺少成功结果/确认的样本。");
try { validateTranscriptionCohort({ manifest: preflightIds.map((id) => ({ id, expected: "李白", imagePath: `${id}.png`, metadata: { evidence: "consented_user", cohortId: "user-cohort-a", consent: "confirmed" } })), timingPayloads: preflightIds.map((sampleId) => ({ schema: "shangtu-transcription-timing-v1", sampleId, timings: [{ event: "pen_up", elapsedMs: 0 }, { event: "transcription_result", elapsedMs: 100, status: "ok", providerStatus: "ready" }] })) }); throw new Error("最终实验 preflight 接受了缺少 provider 的成功结果。"); } catch (error) { if (!(error instanceof Error) || !error.message.includes("时延事件")) throw error; }
try { summarizeTranscriptionTimings([{ schema: "shangtu-transcription-timing-v1", timings: [{ event: "pen_up", elapsedMs: 0 }, { event: "transcription_result", elapsedMs: 100, provider: "not safe" }] }]); throw new Error("时延 schema 接受了不安全 provider 标签。"); } catch (error) { if (!(error instanceof Error) || !error.message.includes("时延事件")) throw error; }
try { summarizeTranscriptionTimings([{ schema: "shangtu-transcription-timing-v1", timings: [{ event: "pen_up", elapsedMs: 0 }, { event: "transcription_result", elapsedMs: 100, status: "ok", providerStatus: "ready" }] }]); throw new Error("时延 schema 允许了缺少 provider 的成功结果。"); } catch (error) { if (!(error instanceof Error) || !error.message.includes("时延事件")) throw error; }
try { summarizeTranscriptionTimings([{ schema: "shangtu-transcription-timing-v1", sampleId: "not-anonymous", timings: [{ event: "pen_up", elapsedMs: 0 }] }]); throw new Error("时延 schema 接受了不安全 sampleId。"); } catch (error) { if (!(error instanceof Error) || !error.message.includes("sampleId")) throw error; }
try { summarizeTranscriptionTimings([{ schema: "shangtu-transcription-timing-v1", sampleId: "abc123def456", timings: [{ event: "pen_up", elapsedMs: 0 }] }, { schema: "shangtu-transcription-timing-v1", sampleId: "abc123def456", timings: [{ event: "pen_up", elapsedMs: 0 }] }]); throw new Error("时延汇总接受了重复 sampleId。"); } catch (error) { if (!(error instanceof Error) || !error.message.includes("重复 sampleId")) throw error; }
try { summarizeTranscriptionTimings([{ schema: "shangtu-transcription-timing-v1", timings: [{ event: "pen_up", elapsedMs: 0 }, { event: "transcription_confirmed", elapsedMs: 100, edited: "yes" }] }]); throw new Error("时延 schema 接受了非布尔 edited。"); } catch (error) { if (!(error instanceof Error) || !error.message.includes("非布尔") && !error.message.includes("时延事件")) throw error; }
const comparisonFixture = {
  evidence: "consented_user",
  cohortId: "user-cohort-a",
  consent: "confirmed",
  reports: [
    { provider: "paddleocr", samples: 2, runs: 3, warmup: 1, summary: { meanOkRate: 1, meanCharacterErrorRate: 0.3, sampleExactStableRate: 0.2, sampleCandidateHitStableRate: 0.4, meanP50Ms: 600, meanP95Ms: 700, statusCounts: { ready: 6 } }, results: [{ id: "a" }, { id: "b" }] },
    { provider: "tesseract", samples: 2, runs: 3, warmup: 1, summary: { meanOkRate: 0.9, meanCharacterErrorRate: 0.8, sampleExactStableRate: 0, sampleCandidateHitStableRate: 0, meanP50Ms: 100, meanP95Ms: 120, statusCounts: { ready: 5, unavailable: 1 } }, results: [{ id: "a" }, { id: "b" }] },
  ],
};
const publicComparison = compareTranscriptionReports([{ ...comparisonFixture, evidence: "public_casia", cohortId: "casia-cohort-a" }], { evidence: "public_casia" });
if (publicComparison.decision.status !== "insufficient_evidence" || publicComparison.providers.some((entry) => entry.rankable)) throw new Error("公开样本比较错误地开启了生产 provider 排名。");
const consentedComparison = compareTranscriptionReports([comparisonFixture], { evidence: "consented_user" });
if (consentedComparison.decision.recommendedProvider !== "paddleocr" || !consentedComparison.providers.every((entry) => entry.rankable)) throw new Error("同 cohort 用户样本比较没有按 CER 和稳定率选出候选。");
const consentedTiming = { schema: "shangtu-transcription-timing-summary-v1", trials: 2, sampleIdCoverage: 1, sampleIds: ["a".repeat(12), "b".repeat(12)], byProviderStatus: [{ provider: "paddleocr", providerStatus: "ready", status: "ok", trials: 2, confirmation: { count: 2, p50Ms: 100, p95Ms: 120 }, confirmationAvailableRate: 1, editedConfirmationRate: 0.5 }] };
const timingFixture = { ...consentedTiming, sampleIds: ["a", "b"] };
try { compareTranscriptionReports([comparisonFixture], { evidence: "consented_user", timingSummaries: [timingFixture] }); throw new Error("timing summary 接受了非 12 位或错位 sampleId。"); } catch (error) { if (!(error instanceof Error) || !error.message.includes("sampleId")) throw error; }
const matchingTiming = { ...consentedTiming, sampleIds: ["a", "b"].map((id) => id.repeat(12)) };
const timedComparisonFixture = { ...comparisonFixture, reports: comparisonFixture.reports.map((entry) => ({ ...entry, results: entry.results.map((result, index) => ({ ...result, id: ["a", "b"][index].repeat(12) })) })) };
const timedComparison = compareTranscriptionReports([timedComparisonFixture], { evidence: "consented_user", timingSummaries: [{ ...matchingTiming, sampleIds: ["a", "b"].map((id) => id.repeat(12)) }] });
if (timedComparison.providers[0].confirmationAvailableRate !== 1 || timedComparison.providers[0].editedConfirmationRate !== 0.5) throw new Error("timing summary 没有与 provider 质量报告合并。");
try { compareTranscriptionReports([timedComparisonFixture], { evidence: "consented_user", timingSummaries: [{ ...matchingTiming, provider: "tesseract", sampleIds: ["a", "b"].map((id) => id.repeat(12)) }] }); throw new Error("比较器接受了顶层 provider 与 timing 分组不一致的摘要。"); } catch (error) { if (!(error instanceof Error) || !error.message.includes("provider")) throw error; }
try { compareTranscriptionReports([{ ...comparisonFixture, preprocessing: "scale-1_5" }, { ...comparisonFixture, preprocessing: "scale-3" }]); throw new Error("比较器接受了不同 preprocessing。"); } catch (error) { if (!(error instanceof Error) || !error.message.includes("preprocessing")) throw error; }
try { compareTranscriptionReports([{ ...comparisonFixture, runId: "run-a" }, { ...comparisonFixture, runId: "run-b" }]); throw new Error("比较器接受了不同 runId。"); } catch (error) { if (!(error instanceof Error) || !error.message.includes("runId")) throw error; }
try { compareTranscriptionReports([{ ...comparisonFixture, evidence: "unknown" }], { evidence: "consented_user" }); throw new Error("比较器允许把未知报告重标成用户样本。"); } catch (error) { if (!(error instanceof Error) || !error.message.includes("不一致")) throw error; }
const unconfirmedComparison = compareTranscriptionReports([{ ...comparisonFixture, consent: undefined }]);
if (unconfirmedComparison.providers.some((entry) => entry.rankable) || unconfirmedComparison.decision.recommendedProvider !== null) throw new Error("未确认授权的报告错误地进入 provider 排名。");
try { compareTranscriptionReports([{ ...comparisonFixture, reports: [{ ...comparisonFixture.reports[0], samples: 3, results: [{ id: "a" }, { id: "b" }, { id: "c" }] }, comparisonFixture.reports[1]] }]); throw new Error("比较器接受了不同 cohort。"); } catch (error) { if (!(error instanceof Error) || !error.message.includes("相同")) throw error; }
try { compareTranscriptionReports([{ ...comparisonFixture, reports: [{ ...comparisonFixture.reports[0], results: [{ id: "a" }, { id: "c" }] }, comparisonFixture.reports[1]] }]); throw new Error("比较器接受了不同样本 id 集合。"); } catch (error) { if (!(error instanceof Error) || !error.message.includes("样本 id")) throw error; }
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
