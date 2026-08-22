import { createAnchorResolver, createCnkgraphGatewayRetriever, createWorksResolver } from "./cnkgraph-gateway.mjs";
import { isOpenWorksQuestion, normalizeJourneyQuery, resolveNotebookAnchor, resolveWorksOutcome, runNarrative, isPersonName } from "./journey-agent.mjs";
import { seekOrAnchorNotebook } from "./notebook-server.mjs";
import { createSeekHandler, resolvePersonAnchor } from "./souyun-gateway-service.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function textEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}（实际：${JSON.stringify(actual)}）`);
}

const GATEWAY = "https://gateway.test/seek";

/** 假 gateway：/seek 与 /anchor 按路径路由。 */
function fakeGateway({ evidence, anchorPayload }) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options, body: options?.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith("/anchor")) return { ok: true, status: 200, json: async () => anchorPayload() };
    return { ok: true, status: 200, json: async () => evidence };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const gatewayEvidence = {
  kind: "evidence",
  nodes: [
    { id: "cnk:person:15188", label: "李白", type: "Person" },
    { id: "cnk:work:26453", label: "将进酒", type: "Work" },
  ],
  edges: [{ source: "cnk:person:15188", relation: "作者", target: "cnk:work:26453", evidenceRefs: ["source:cnk:w:26453:KR4h0140_017"] }],
  sources: [{ id: "source:cnk:w:26453:KR4h0140_017", label: "《御定全唐诗》卷十七", url: "https://api.cnkgraph.com/api/Writing/26453", claim: "《御定全唐诗》卷十七收录李白《将进酒》。" }],
  temporalSpatial: { places: ["嵩山"], timeHints: ["736年"], timeline: [{ year: 736, label: "《将进酒》创作于736年" }] },
};

const personAnchorPayload = () => ({
  kind: "person_anchor",
  anchor: {
    id: "cnk:person:15188", name: "李白", dynasty: "盛唐", life: "701—762",
    aliases: ["太白", "青莲居士"], titles: ["翰林"],
    hometown: "陇西成纪(今甘肃秦安西北)",
    details: [{ book: "中國歷代人名大辭典", text: "唐隴西成紀人。" }],
    source: [{ label: "CNKGraph 人物档案（搜韵）", url: "https://api.cnkgraph.com/api/People/15188" }],
  },
});

// 1. 人物名判定（与前端 isPersonAnchorText 同边界）。
assert(isPersonName("李白") === true, "两字人名应被接受");
assert(isPersonName("李清照") === true, "三字人名应被接受");
assert(isPersonName("李白写过什么") === false, "含问句动词的文本不是人名");
assert(isPersonName("今天天气怎么样") === false, "问句不是人名");
assert(isPersonName("") === false, "空文本不是人名");

// 2. 旅程感知问句归一化。
const journey = { anchor: "李白", anchorId: "cnk:person:15188", route: "work" };
textEqual(normalizeJourneyQuery("他写过《将进酒》吗", journey), "李白写过《将进酒》吗", "代词应替换为锚点人名");
textEqual(normalizeJourneyQuery("《将进酒》", journey), "李白写过《将进酒》吗", "裸书名应补全人物与问式");
textEqual(normalizeJourneyQuery("写过将进酒", journey), "李白写过将进酒吗", "动宾结构应只补人物主语");
textEqual(normalizeJourneyQuery("李白写过《将进酒》吗", journey), "李白写过《将进酒》吗", "已含人名的问句不应改动");
textEqual(normalizeJourneyQuery("他写过什么", journey), "李白写过什么吗", "开放式代词问句应补人名");
textEqual(normalizeJourneyQuery("将进酒", null), "将进酒", "无旅程时不应改写");
textEqual(normalizeJourneyQuery("他写过《将进酒》吗", { anchor: null }), "他写过《将进酒》吗", "无锚点时不应改写");

// 3. 人物锚点解析：gateway /anchor 客户端 → anchor_ready 形态。
const anchorFetch = fakeGateway({ anchorPayload: personAnchorPayload });
const anchorResolver = createAnchorResolver({ endpoint: GATEWAY, authToken: "t", fetchImpl: anchorFetch });
const anchorResult = await resolveNotebookAnchor({ transcription: "李白", resolveAnchor: anchorResolver });
assert(anchorResult.status === "anchor_ready", "纯人名应走锚点解析");
assert(anchorResult.anchor.id === "cnk:person:15188" && anchorResult.anchor.name === "李白" && anchorResult.anchor.dynasty === "盛唐" && anchorResult.anchor.life === "701—762", "人物档案字段不完整");
assert(anchorResult.anchor.hometown === "陇西成纪(今甘肃秦安西北)" && anchorResult.anchor.aliases.length === 2 && anchorResult.anchor.titles.length === 1, "别名/官职/籍贯不完整");
assert(anchorResult.anchor.details[0].source === "中國歷代人名大辭典" && anchorResult.anchor.details[0].text === "唐隴西成紀人。", "档案摘录没有映射为前端 details 形状");
assert(anchorResult.anchor.source[0].url === "https://api.cnkgraph.com/api/People/15188", "档案来源 URL 不正确");
assert(anchorFetch.calls[0].url === "https://gateway.test/anchor", "anchor 客户端没有请求 /anchor 端点");
const dynastyRetry = await resolveNotebookAnchor({ transcription: "盛唐·李白", resolveAnchor: anchorResolver });
assert(dynastyRetry.status === "anchor_ready", "「朝代·姓名」形式应拆分并重试锚点解析");
const unconfiguredAnchor = await resolveNotebookAnchor({ transcription: "李白", resolveAnchor: createAnchorResolver({ endpoint: undefined, authToken: undefined }) });
assert(unconfiguredAnchor === null, "anchor 未配置时应跳过锚点分支（不产生 graph_unconfigured）");

// 4. 同名歧义：gateway person_ambiguous → ambiguous outcome（候选为「朝代·姓名」）。
const ambiguousResolver = createAnchorResolver({
  endpoint: GATEWAY, authToken: "t",
  fetchImpl: fakeGateway({ anchorPayload: () => ({ kind: "person_ambiguous", candidates: [{ name: "盛唐·李白", dynasty: "盛唐", life: "701—762" }, { name: "明·李白", dynasty: "明", life: "1352—1432" }] }) }),
});
const ambiguousResult = await resolveNotebookAnchor({ transcription: "李白", resolveAnchor: ambiguousResolver });
assert(ambiguousResult.status === "ok" && ambiguousResult.outcome.kind === "ambiguous", "同名歧义应产出 ambiguous outcome");
assert(ambiguousResult.outcome.candidates.length === 2 && ambiguousResult.outcome.candidates[0] === "盛唐·李白", "歧义候选应为「朝代·姓名」形式");

// 5. 无此人物：evidence_gap → gap outcome（纸面缺口，不编造）。
const missingResolver = createAnchorResolver({
  endpoint: GATEWAY, authToken: "t",
  fetchImpl: fakeGateway({ anchorPayload: () => ({ kind: "evidence_gap", reason: "诗文库没有与「完颜阿骨打」精确同名的作者记录。" }) }),
});
const missingResult = await resolveNotebookAnchor({ transcription: "完颜阿骨打", resolveAnchor: missingResolver });
assert(missingResult.status === "ok" && missingResult.outcome.kind === "gap" && missingResult.outcome.gap.includes("完颜阿骨打"), "无档案人物应产出证据缺口");

// 6. /api/seek 编排：无 journey + 纯人名 → 锚点；带 journey → 寻迹（journey 透传）。
const orchestrationFetch = fakeGateway({ evidence: gatewayEvidence, anchorPayload: personAnchorPayload });
const orchestratorResolveAnchor = createAnchorResolver({ endpoint: GATEWAY, authToken: "t", fetchImpl: orchestrationFetch });
const seekInputs = [];
const fakeSeek = async (input) => {
  seekInputs.push(input);
  return { status: "ok", outcome: { kind: "evidence", transcription: input.transcription, evidence: "当前图谱记录：李白是《将进酒》的作者。", association: null, source: [], path: ["李白", "作者", "将进酒"] } };
};
const orchestratedAnchor = await seekOrAnchorNotebook({ transcription: "李白", image: null }, orchestratorResolveAnchor, fakeSeek);
assert(orchestratedAnchor.status === "anchor_ready", "编排层没有把纯人名交给锚点解析");
assert(seekInputs.length === 0, "纯人名起笔不应触发寻迹");
const orchestratedSeek = await seekOrAnchorNotebook({ transcription: "他写过《将进酒》吗", image: null, journey }, orchestratorResolveAnchor, fakeSeek);
assert(orchestratedSeek.status === "ok" && orchestratedSeek.outcome.kind === "evidence", "带 journey 的寻迹没有被编排到寻迹链路");
assert(seekInputs.length === 1 && seekInputs[0].journey === journey && seekInputs[0].transcription === "他写过《将进酒》吗", "寻迹链路没有收到完整的 journey 上下文");

// 7. Pi 失败容错：会话初始化抛错 → 确定性证据直出（核验逻辑不变；问句在 runSeek 内归一化）。
const { runSeek } = await import("./run-seek.mjs");
const deterministicFetch = fakeGateway({ evidence: gatewayEvidence, anchorPayload: personAnchorPayload });
const deterministicResult = await runSeek({
  transcription: "他写过《将进酒》吗", journey,
  createSession: async () => { throw new Error("model runtime down"); },
  retrieve: createCnkgraphGatewayRetriever({ endpoint: GATEWAY, authToken: "t", fetchImpl: deterministicFetch }),
});
assert(deterministicResult.status === "ok" && deterministicResult.outcome.kind === "evidence" && deterministicResult.outcome.evidence === "当前图谱记录：李白是《将进酒》的作者。", "Pi 故障时没有确定性直出已核验证据");
const deterministicSeekCalls = deterministicFetch.calls.filter((call) => !String(call.url).endsWith("/anchor"));
assert(deterministicSeekCalls.length === 1 && deterministicSeekCalls[0].body?.query === "李白写过《将进酒》吗", "寻迹问句没有经过旅程归一化（代词未替换为锚点人名）");
assert(deterministicResult.outcome.places?.[0] === "嵩山" && deterministicResult.outcome.timeHints?.[0] === "736年" && deterministicResult.outcome.timeline?.[0]?.year === 736, "二级时空索引没有透传到 outcome");
// Pi 未配置（返回 null）仍保持显式降级，不越权生成旁批。
const unconfiguredResult = await runSeek({
  transcription: "李白写过《将进酒》吗",
  createSession: async () => null,
  retrieve: createCnkgraphGatewayRetriever({ endpoint: GATEWAY, authToken: "t", fetchImpl: fakeGateway({ evidence: gatewayEvidence, anchorPayload: personAnchorPayload }) }),
});
assert(unconfiguredResult.status === "model_unconfigured", "未配置模型时必须显式降级为 model_unconfigured");

// 8. 联想端点：无 Pi → narrative_unconfigured；有效联想 → narrative_ready；事实断言 → 拒绝。
const noModelNarrative = await runNarrative({ journey: { anchor: "李白", route: "work", step: 1 }, evidence: { evidence: "当前图谱记录：李白是《将进酒》的作者。", path: ["李白", "作者", "将进酒"] }, createSession: async () => null });
assert(noModelNarrative.status === "narrative_unconfigured", "未配置模型时联想必须显式降级");
const fakeNarrativeSession = (text) => ({
  messages: [{ role: "assistant", content: [{ type: "text", text }] }],
  async prompt() {}, async waitForIdle() {}, dispose() {},
});
const validNarrative = await runNarrative({
  journey: { anchor: "李白", route: "work", step: 1, history: [{ step: 1, transcription: "将进酒", evidence: "李白是《将进酒》的作者。", path: ["李白", "作者", "将进酒"] }] },
  evidence: { evidence: "当前图谱记录：李白是《将进酒》的作者。", path: ["李白", "作者", "将进酒"] },
  createSession: async () => fakeNarrativeSession(JSON.stringify({ association: "联想：把酒临风的一笔，可再听一句黄河入海的语气。" })),
});
assert(validNarrative.status === "narrative_ready" && validNarrative.association.startsWith("联想："), "有效联想没有被接受");
const factualNarrative = await runNarrative({
  journey: { anchor: "李白", route: "work", step: 1 },
  evidence: { evidence: "当前图谱记录：李白是《将进酒》的作者。", path: ["李白", "作者", "将进酒"] },
  createSession: async () => fakeNarrativeSession(JSON.stringify({ association: "联想：写于762年的绝笔。" })),
});
assert(factualNarrative.status === "narrative_rejected", "含年代事实的联想必须被拒绝");

// 9. gateway /anchor 端点：漂移过滤 + People 档案归一化（直接验证 handler）。
const { createAnchorHandler } = await import("./souyun-gateway-service.mjs");
const peopleProfile = { Person: { Profile: { Id: 15188, Name: "李白", BirthYear: "701", DeathYear: "762", Dynasty: "盛唐", Aliases: [{ Name: "太白", Type: "Zi" }], Titles: ["翰林"], Hometown: [{ RegionId: "CN620522", Name: "陇西成纪(今甘肃秦安西北)" }] }, Details: [{ Book: "中國歷代人名大辭典", Content: "【生卒】：701—762" }] } };
const upstream = async (url, options) => {
  const body = options?.body ? JSON.parse(options.body) : null;
  if (String(url).endsWith("/Writing/Find") && body?.author && !body?.key) {
    return { ok: true, status: 200, json: async () => ({ Dynasties: [{ Name: "盛唐", Authors: [{ Id: 15188, Name: "李白", Life: "701年1月16日 — 762" }] }] }) };
  }
  if (String(url).endsWith("/People/15188")) return { ok: true, status: 200, json: async () => peopleProfile };
  throw new Error(`fakeUpstream 无路由 ${url}`);
};
const anchorHandler = createAnchorHandler({ authToken: "t", upstreamBase: "https://api.cnkgraph.test", fetchImpl: upstream });
const anchorHandlerResult = await anchorHandler({ person: "李白" });
assert(anchorHandlerResult.status === 200 && anchorHandlerResult.body.kind === "person_anchor", "gateway /anchor 没有产出人物锚点");
assert(anchorHandlerResult.body.anchor.life === "701—762" && anchorHandlerResult.body.anchor.hometown.includes("陇西"), "人物档案归一化字段不完整");
assert(anchorHandlerResult.body.anchor.source[0].url === "https://api.cnkgraph.test/api/People/15188", "档案来源 URL 基址不正确");
const ambiguousHandler = createAnchorHandler({
  authToken: "t", upstreamBase: "https://api.cnkgraph.test",
  fetchImpl: async (url, options) => {
    if (String(url).endsWith("/Writing/Find")) return { ok: true, status: 200, json: async () => ({ Dynasties: [{ Name: "盛唐", Authors: [{ Id: 1, Name: "王维" }] }, { Name: "明", Authors: [{ Id: 2, Name: "王维" }] }] }) };
    throw new Error("不应请求档案");
  },
});
const ambiguousHandlerResult = await ambiguousHandler({ person: "王维" });
assert(ambiguousHandlerResult.body.kind === "person_ambiguous" && ambiguousHandlerResult.body.candidates[0].name === "盛唐·王维", "同名人物应产出「朝代·姓名」候选");

// 10. resolvePersonAnchor 的朝代提示收窄。
const narrowed = resolvePersonAnchor({
  findResult: { Dynasties: [{ Name: "盛唐", Authors: [{ Id: 1, Name: "王维", Dynasty: "盛唐" }] }, { Name: "明", Authors: [{ Id: 2, Name: "王维", Dynasty: "明" }] }] },
  personName: "王维", dynastyHint: "盛唐", personProfile: null,
});
assert(narrowed.kind === "person_anchor" && narrowed.anchor.id === "cnk:person:1", "朝代提示应收窄同名歧义");

// 11. 适配器 localhost http 豁免（仅回环）。
const loopbackRetriever = createCnkgraphGatewayRetriever({ endpoint: "http://localhost:8787/seek", authToken: "t", fetchImpl: fakeGateway({ evidence: gatewayEvidence, anchorPayload: personAnchorPayload }) });
assert(loopbackRetriever.isConfigured === true, "localhost http gateway 应被接受（开发豁免）");
const lanRetriever = createCnkgraphGatewayRetriever({ endpoint: "http://192.168.1.5:8787/seek", authToken: "t", fetchImpl: fakeGateway({ evidence: gatewayEvidence, anchorPayload: personAnchorPayload }) });
assert(lanRetriever.isConfigured === false, "非回环 http gateway 必须被拒绝");
const loopbackOutcome = await loopbackRetriever("李白写过《将进酒》吗");
assert(loopbackOutcome.kind === "evidence" && loopbackOutcome.temporalSpatial?.places[0] === "嵩山", "回环 gateway 的证据与时空索引没有通过归一化");

// 12. 来源子集核验：多来源图下提案引用部分真实来源 → 证据；伪造/空来源 → 缺口。
const { normalizeSeekOutcome } = await import("./seek-outcome.mjs");
const multiSourceGraph = {
  kind: "evidence",
  nodes: gatewayEvidence.nodes,
  edges: gatewayEvidence.edges,
  sources: [
    { id: "source:cnk:w:26453:a", label: "《御定全唐诗》卷十七", url: "https://api.cnkgraph.com/api/Writing/26453", claim: "收录《将进酒》。" },
    { id: "source:cnk:w:26453:b", label: "《乐府诗集》卷十七", url: "https://api.cnkgraph.com/api/Writing/26453", claim: "收录《将进酒》。" },
    { id: "source:cnk:w:26453:c", label: "《古今图书集成》", url: "https://api.cnkgraph.com/api/Writing/26453", claim: "收录《将进酒》。" },
  ],
};
const subsetOutcome = normalizeSeekOutcome({
  transcription: "他写过《将进酒》吗",
  raw: JSON.stringify({ kind: "evidence", sourceIds: ["source:cnk:w:26453:b"], path: ["李白", "作者", "将进酒"] }),
  graph: multiSourceGraph,
});
assert(subsetOutcome.kind === "evidence" && subsetOutcome.source.length === 1 && subsetOutcome.source[0].label === "《乐府诗集》卷十七", "引用部分真实来源的合法提案被误判为缺口（应显示被引用的来源）");
const emptySourcesOutcome = normalizeSeekOutcome({
  transcription: "他写过《将进酒》吗",
  raw: JSON.stringify({ kind: "evidence", sourceIds: [], path: ["李白", "作者", "将进酒"] }),
  graph: multiSourceGraph,
});
assert(emptySourcesOutcome.kind === "gap", "空 sourceIds 提案必须降级为缺口");
const forgedSubsetOutcome = normalizeSeekOutcome({
  transcription: "他写过《将进酒》吗",
  raw: JSON.stringify({ kind: "evidence", sourceIds: ["source:cnk:w:26453:a", "fabricated-source"], path: ["李白", "作者", "将进酒"] }),
  graph: multiSourceGraph,
});
assert(forgedSubsetOutcome.kind === "gap", "混入伪造来源的提案必须整体降级为缺口");
const allSourcesOutcome = normalizeSeekOutcome({
  transcription: "他写过《将进酒》吗",
  raw: JSON.stringify({ kind: "evidence", sourceIds: ["source:cnk:w:26453:a", "source:cnk:w:26453:b", "source:cnk:w:26453:c"], path: ["李白", "作者", "将进酒"] }),
  graph: multiSourceGraph,
});
assert(allSourcesOutcome.kind === "evidence" && allSourcesOutcome.source.length === 3, "全量来源提案应显示全部来源");

// 13. 开放式作品问句：识别 + 作品候选 outcome + runSeek 拦截。
assert(isOpenWorksQuestion("他写过什么", journey) === true, "旅程锚点下的开放问句没有被识别");
assert(isOpenWorksQuestion("李白写过什么", null) === true, "无旅程的「人物+写过什么」没有被识别");
assert(isOpenWorksQuestion("李白有哪些作品", null) === true, "「有哪些作品」没有被识别");
assert(isOpenWorksQuestion("代表作", journey) === true, "「代表作」没有被识别");
assert(isOpenWorksQuestion("他写过《将进酒》吗", journey) === false, "带书名的具体问句不应判为开放问句");
assert(isOpenWorksQuestion("今天天气怎么样", journey) === false, "无关问句不应判为开放问句");
const worksFetch = fakeGateway({
  evidence: gatewayEvidence,
  anchorPayload: personAnchorPayload,
});
worksFetch.routeWorks = async (url, options) => {
  if (String(url).endsWith("/works")) {
    worksFetch.calls.push({ url: String(url), options, body: options?.body ? JSON.parse(options.body) : null });
    return { ok: true, status: 200, json: async () => ({ kind: "works", name: "李白", totalCount: 1111, works: [{ id: 26453, title: "将进酒", date: "736年", place: "嵩山" }, { id: 7, title: "静夜思", date: null, place: null }] }) };
  }
  return null;
};
const worksResolver = createWorksResolver({ endpoint: GATEWAY, authToken: "t", fetchImpl: async (url, options) => (await worksFetch.routeWorks(url, options)) ?? worksFetch(url, options) });
const worksWithJourney = await resolveWorksOutcome({ transcription: "他写过什么", journey, worksResolver });
assert(withJourneyStatus(worksWithJourney) && worksWithJourney.outcome.kind === "ambiguous" && worksWithJourney.outcome.candidates[0] === "将进酒", "有锚点的开放问句应返回裸书名候选");
assert(worksWithJourney.outcome.clarification.includes("1111"), "开放问句澄清语应包含真实作品总数");
const worksNoJourney = await resolveWorksOutcome({ transcription: "李白写过什么", journey: null, worksResolver });
assert(worksNoJourney.outcome.kind === "ambiguous" && worksNoJourney.outcome.candidates[0] === "李白写过《将进酒》吗", "无锚点的开放问句应返回完整问句候选（点选后可独立寻迹）");
const worksGapResolver = createWorksResolver({ endpoint: GATEWAY, authToken: "t", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ kind: "evidence_gap", reason: "诗文库没有与「无名氏」精确同名的作者记录。" }) }) });
const worksGap = await resolveWorksOutcome({ transcription: "无名氏写过什么", journey: null, worksResolver: worksGapResolver });
assert(worksGap.outcome.kind === "gap" && worksGap.outcome.gap.includes("无名氏"), "无档案人物的开放问句应返回证据缺口");
const unconfiguredWorks = await resolveWorksOutcome({ transcription: "他写过什么", journey, worksResolver: createWorksResolver({ endpoint: undefined, authToken: undefined }) });
assert(unconfiguredWorks.status === "graph_unconfigured", "gateway 未配置时开放问句必须显式降级");
const intercepted = await runSeek({
  transcription: "他写过什么", journey,
  createSession: async () => { throw new Error("开放问句不应触发 Pi 会话"); },
  retrieve: createCnkgraphGatewayRetriever({ endpoint: GATEWAY, authToken: "t", fetchImpl: worksFetch }),
  worksResolver,
});
assert(intercepted.status === "ok" && intercepted.outcome.kind === "ambiguous", "runSeek 没有在图谱寻迹前拦截开放问句");

// 14. 地点线归一化：代词问句与裸地点词 → 「{人物}在{地点}写过什么」。
textEqual(normalizeJourneyQuery("他在嵩山写过什么", { anchor: "李白", route: "space" }), "李白在嵩山写过什么", "地点代词问句应替换人物与地点");
textEqual(normalizeJourneyQuery("嵩山", { anchor: "李白", route: "space" }), "李白在嵩山写过什么", "地点线裸地点应补全人物与问式");
textEqual(normalizeJourneyQuery("在黄州留下过什么", { anchor: "苏轼", route: "space" }), "苏轼在黄州写过什么", "「留下过什么」地点问句应归一");
assert(normalizeJourneyQuery("他在此地游历", { anchor: "李白", route: "space" }) === "他在此地游历", "未识别的「在」结构不应强行改写");

function withJourneyStatus(result) { return result.status === "ok"; }

console.log("Journey agent contract verified: 人物锚点（含朝代收窄与同名候选）、旅程问句归一化（作品与地点）、开放问句作品候选、时空索引透传、来源子集核验、Pi 容错直出与未配置降级、联想边界、localhost 豁免均通过。");
