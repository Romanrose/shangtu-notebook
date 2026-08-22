import { createCnkgraphGatewayRetriever } from "./cnkgraph-gateway.mjs";
import { createBoundedCache, createSeekHandler, createSouyunGatewayService, extractSlots, resolveAuthorFromFind } from "./souyun-gateway-service.mjs";

const UPSTREAM = "https://api.cnkgraph.test";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function textEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}（实际：${JSON.stringify(actual)}）`);
}

/** 按真实上游 URL 形态路由的假 fetch；可注入延迟与故障。 */
function fakeUpstream(routes) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : null;
    calls.push({ url, options, body });
    for (const route of routes) {
      if (!route.match(url, body)) continue;
      if (route.delayMs) await new Promise((resolve) => setTimeout(resolve, route.delayMs));
      if (route.ok === false) return { ok: false, status: route.status ?? 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => route.response };
    }
    throw new Error(`fakeUpstream 没有路由匹配 ${url}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const driftAuthorsResponse = {
  Notification: null,
  Dynasties: [
    { Name: "盛唐", Authors: [{ Id: 15188, Name: "李白", Surname: "李", Life: "701年1月16日 — 762", WritingCount: 1111 }] },
    { Name: "明", Authors: [
      { Id: 56800, Name: "李行", Surname: "李", Life: "1352 — 1432", WritingCount: 21 },
      { Id: 75772, Name: "\n李敬舆", Surname: "李", Life: "1585 — 1657", WritingCount: 849 },
    ] },
    { Name: "明末", Authors: [{ Id: 47407, Name: "李弃", Surname: "李", Life: "1597 — ？", WritingCount: 2 }] },
  ],
};

const jiangjinjiuFindResponse = {
  Notification: null,
  WritingCount: 1,
  PageNo: 0,
  PageSize: 20,
  Writings: [{
    Id: 26453,
    Dynasty: "盛唐",
    Author: "李白",
    AuthorId: 15188,
    Title: { Content: "鼓吹曲辞 将进酒" },
    Clauses: [{ Content: "君不见黄河之水天上来，" }],
  }],
};

const bookLinksResponse = {
  Froms: null,
  ResourceType: "Writing",
  ResourceId: 26453,
  Count: 84,
  Links: [
    { Book: "御定全唐诗-清-圣祖玄烨", Volume: "卷十七", VolumeId: "KR4h0140_017", StartPage: "6b" },
    { Book: "李太白全集", Volume: "卷三", VolumeId: "KR4h0123_003", StartPage: "1a" },
  ],
};

function standardRoutes({ authorResponse = driftAuthorsResponse, workResponse = jiangjinjiuFindResponse, bookLinksResponse: links = bookLinksResponse } = {}) {
  return [
    { match: (url, body) => url === `${UPSTREAM}/api/Writing/Find` && body?.author && !body?.key, response: authorResponse },
    { match: (url, body) => url === `${UPSTREAM}/api/Writing/Find` && body?.key && body?.author, response: workResponse },
    { match: (url) => url === `${UPSTREAM}/api/Writing/26453/BookLinks`, response: links },
  ];
}

function createHandler(routes, extra = {}) {
  return createSeekHandler({
    authToken: "server-only-token",
    upstreamBase: UPSTREAM,
    fetchImpl: fakeUpstream(routes),
    ...extra,
  });
}

// 1. 槽位抽取。
textEqual(JSON.stringify(extractSlots("李白写过《将进酒》吗")), JSON.stringify({ person: "李白", work: "将进酒", place: null }), "书名号问句抽取失败");
textEqual(JSON.stringify(extractSlots("李白写过将进酒吗？")), JSON.stringify({ person: "李白", work: "将进酒", place: null }), "无书名号问句抽取失败");
textEqual(JSON.stringify(extractSlots("李白是否写过《将进酒》")), JSON.stringify({ person: "李白", work: "将进酒", place: null }), "是否式问句抽取失败");
textEqual(JSON.stringify(extractSlots("李白有没有写过将进酒")), JSON.stringify({ person: "李白", work: "将进酒", place: null }), "有没有式问句抽取失败");
textEqual(JSON.stringify(extractSlots("苏轼写过《前赤壁赋》吗")), JSON.stringify({ person: "苏轼", work: "前赤壁赋", place: null }), "苏轼问句抽取失败");
assert(extractSlots("今天天气怎么样") === null, "不支持的问句没有被拒绝");
assert(extractSlots("") === null, "空查询没有被拒绝");
// 地点问句槽位。
textEqual(JSON.stringify(extractSlots("李白在嵩山写过什么")), JSON.stringify({ person: "李白", work: null, place: "嵩山" }), "地点问句抽取失败");
textEqual(JSON.stringify(extractSlots("李白在黄州写过《寒食帖》吗")), JSON.stringify({ person: "李白", work: "寒食帖", place: "黄州" }), "地点+书名问句抽取失败");
const pronounPlaceSlots = extractSlots("他在嵩山写过什么");
assert(pronounPlaceSlots === null || pronounPlaceSlots.place === null, "代词主语的地点问句不应产生地点槽位（由归一化层先替换代词）");
assert(extractSlots("完全不存在的人写过《将进酒》吗") !== null, "「存在」中的「在」不应让书名号问句被整体拒绝");

// 2. 作者漂移过滤：同姓陷阱（李行/李弃）与带换行的名字（"\n李敬舆"）都必须被排除。
const driftResolution = resolveAuthorFromFind(driftAuthorsResponse, "李白");
assert(driftResolution.kind === "unique" && driftResolution.author.id === 15188, "漂移过滤没有精确命中李白 15188");
const whitespaceNameResolution = resolveAuthorFromFind(driftAuthorsResponse, "李敬舆");
assert(whitespaceNameResolution.kind === "unique" && whitespaceNameResolution.author.id === 75772, "带换行的作者名字（\\n李敬舆）没有被空白归一化匹配");
assert(resolveAuthorFromFind(driftAuthorsResponse, "李白之").kind === "none", "列表中不存在的作者没有被排除");
const singleShapeResolution = resolveAuthorFromFind({ AuthorWritings: { Name: "李恒福", Id: 37512, Dynasty: "明" } }, "李恒福");
assert(singleShapeResolution.kind === "unique" && singleShapeResolution.author.id === 37512, "唯一作者 AuthorWritings 形态没有被解析");
const duplicatedAuthorResponse = {
  Dynasties: [
    { Name: "盛唐", Authors: [{ Id: 15188, Name: "李白" }] },
    { Name: "唐朝", Authors: [{ Id: 15188, Name: "李白" }] },
  ],
};
assert(resolveAuthorFromFind(duplicatedAuthorResponse, "李白").kind === "unique", "同一 Id 出现在多个朝代分组时被误判为歧义");
const ambiguousResolution = resolveAuthorFromFind({
  Dynasties: [
    { Name: "盛唐", Authors: [{ Id: 15188, Name: "李白" }] },
    { Name: "明", Authors: [{ Id: 88888, Name: "李白" }] },
  ],
}, "李白");
assert(ambiguousResolution.kind === "ambiguous" && ambiguousResolution.candidates.length === 2, "同名不同 Id 没有被判为歧义");

// 3. 完整链路：漂移过滤 + 作品解析 + BookLinks 转证据图。
const happyHandler = createHandler(standardRoutes());
const happyResult = await happyHandler({ query: "李白写过《将进酒》吗", limits: { maxHops: 2, maxNodes: 8, maxEdges: 8, maxSources: 4 } });
assert(happyResult.status === 200 && happyResult.body.kind === "evidence", "标准问句没有返回证据图");
const evidence = happyResult.body;
assert(evidence.nodes.length === 2 && evidence.nodes[0].id === "cnk:person:15188" && evidence.nodes[0].label === "李白" && evidence.nodes[0].type === "Person", "人物节点不正确");
assert(evidence.nodes[1].id === "cnk:work:26453" && evidence.nodes[1].label === "将进酒" && evidence.nodes[1].type === "Work", "作品节点没有用用户确认词作 label");
assert(evidence.edges.length === 1 && evidence.edges[0].relation === "作者" && evidence.edges[0].source === "cnk:person:15188" && evidence.edges[0].target === "cnk:work:26453", "作者关系边不正确");
assert(evidence.sources.length === 2 && evidence.sources.every((source) => source.url === `${UPSTREAM}/api/Writing/26453` && /^source:cnk:w:26453:/.test(source.id) && typeof source.claim === "string" && source.claim.length > 0), "BookLinks 来源不正确");
assert(evidence.sources[0].claim.includes("收录李白《将进酒》"), "来源 claim 不是确定性拼接");
assert(JSON.stringify(evidence.edges[0].evidenceRefs) === JSON.stringify(evidence.sources.map((source) => source.id)), "边的 evidenceRefs 与 sources 不一致");

// 4. 交叉验证：gateway 输出必须能通过真实适配器 cnkgraph-gateway.mjs 的归一化。
const adapter = createCnkgraphGatewayRetriever({
  endpoint: "https://gateway.test/seek",
  authToken: "server-only-token",
  fetchImpl: async () => ({ ok: true, json: async () => evidence }),
});
const adapted = await adapter("李白写过《将进酒》吗");
assert(adapted.kind === "evidence" && adapted.nodes.length === 2 && adapted.edges.length === 1 && adapted.edges[0].relation === "作者" && adapted.sources.length === 2, "gateway 输出没有通过真实适配器的归一化核验");

// 5. 上游 500 / 超时 → 502 / 504（不是 evidence_gap）；上游 404（无匹配）→ 证据缺口。
const upstream500 = createSeekHandler({ authToken: "t", upstreamBase: UPSTREAM, fetchImpl: fakeUpstream([{ match: () => true, ok: false, status: 500 }]) });
const upstream500Result = await upstream500({ query: "李白写过《将进酒》吗" });
assert(upstream500Result.status === 502, "上游 5xx 必须映射为 502 graph_unavailable，而不是证据缺口");
const authorNotFoundFetch = fakeUpstream([{ match: (url, body) => url === `${UPSTREAM}/api/Writing/Find` && body?.author && !body?.key, ok: false, status: 404 }]);
const authorNotFoundHandler = createSeekHandler({ authToken: "t", upstreamBase: UPSTREAM, fetchImpl: authorNotFoundFetch });
const authorNotFoundResult = await authorNotFoundHandler({ query: "完全不存在的人写过《将进酒》吗" });
assert(authorNotFoundResult.status === 200 && authorNotFoundResult.body.kind === "evidence_gap" && authorNotFoundResult.body.reason.includes("作者"), "上游 404（无匹配作者）必须映射为证据缺口而不是 502");
const workNotFoundFetch = fakeUpstream([
  { match: (url, body) => url === `${UPSTREAM}/api/Writing/Find` && body?.author && !body?.key, response: driftAuthorsResponse },
  { match: (url, body) => url === `${UPSTREAM}/api/Writing/Find` && body?.key && body?.author, ok: false, status: 404 },
]);
const workNotFoundHandler = createSeekHandler({ authToken: "t", upstreamBase: UPSTREAM, fetchImpl: workNotFoundFetch });
const workNotFoundResult = await workNotFoundHandler({ query: "李白写过《完全不存在的一首诗》吗" });
assert(workNotFoundResult.status === 200 && workNotFoundResult.body.kind === "evidence_gap" && workNotFoundResult.body.reason.includes("作品"), "上游 404（无匹配作品）必须映射为证据缺口而不是 502");
const timeoutHandler = createSeekHandler({ authToken: "t", upstreamBase: UPSTREAM, fetchImpl: fakeUpstream([{ match: () => true, delayMs: 500, response: {} }]), perCallTimeoutMs: 20 });
const timeoutResult = await timeoutHandler({ query: "李白写过《将进酒》吗" });
assert(timeoutResult.status === 504, "上游超时必须映射为 504，而不是证据缺口");

// 6. 证据缺口分支：无作者 / 无作品 / 同名歧义 / 不支持的问句。
const noAuthorHandler = createHandler(standardRoutes({ authorResponse: { Notification: null, Dynasties: [{ Name: "明", Authors: [{ Id: 56800, Name: "李行" }] }] } }));
const noAuthorResult = await noAuthorHandler({ query: "李白写过《将进酒》吗" });
assert(noAuthorResult.status === 200 && noAuthorResult.body.kind === "evidence_gap" && noAuthorResult.body.reason.includes("同名"), "无精确同名作者没有返回证据缺口");
const noWorkHandler = createHandler(standardRoutes({ workResponse: { Notification: null, WritingCount: 0, Writings: [] } }));
const noWorkResult = await noWorkHandler({ query: "李白写过《静夜思之外的某首诗》吗" });
assert(noWorkResult.status === 200 && noWorkResult.body.kind === "evidence_gap" && noWorkResult.body.reason.includes("作品"), "无作品没有返回证据缺口");
const ambiguousHandler = createHandler(standardRoutes({
  authorResponse: { Dynasties: [
    { Name: "盛唐", Authors: [{ Id: 15188, Name: "李白" }] },
    { Name: "明", Authors: [{ Id: 88888, Name: "李白" }] },
  ] },
}));
const ambiguousResult = await ambiguousHandler({ query: "李白写过《将进酒》吗" });
assert(ambiguousResult.status === 200 && ambiguousResult.body.kind === "evidence_gap" && ambiguousResult.body.reason.includes("同名"), "同名歧义没有返回证据缺口而不是静默选择");
const unsupportedHandler = createHandler(standardRoutes());
const unsupportedResult = await unsupportedHandler({ query: "今天天气怎么样" });
assert(unsupportedResult.status === 200 && unsupportedResult.body.kind === "evidence_gap", "不支持的问句没有返回证据缺口");

// 7. BookLinks 失败 → 退回作品条目来源，证据不失效。
const noLinksHandler = createHandler(standardRoutes({ bookLinksResponse: { Links: [] } }));
const noLinksResult = await noLinksHandler({ query: "李白写过《将进酒》吗" });
assert(noLinksResult.status === 200 && noLinksResult.body.kind === "evidence" && noLinksResult.body.sources.length === 1 && noLinksResult.body.sources[0].id.endsWith(":entry"), "BookLinks 为空时没有退回作品条目来源");
const linksFailedHandler = createSeekHandler({ authToken: "t", upstreamBase: UPSTREAM, fetchImpl: fakeUpstream([
  { match: (url, body) => url === `${UPSTREAM}/api/Writing/Find` && body?.author && !body?.key, response: driftAuthorsResponse },
  { match: (url, body) => url === `${UPSTREAM}/api/Writing/Find` && body?.key, response: jiangjinjiuFindResponse },
  { match: (url) => url.endsWith("/BookLinks"), ok: false, status: 500 },
]) });
const linksFailedResult = await linksFailedHandler({ query: "李白写过《将进酒》吗" });
assert(linksFailedResult.status === 200 && linksFailedResult.body.kind === "evidence" && linksFailedResult.body.sources.length === 1, "BookLinks 故障时不应该让整个证据失效");

// 8. limits 钳制：请求再大也只能拿到 4 个来源。
const manyLinks = { Links: Array.from({ length: 9 }, (_, index) => ({ Book: `书${index}`, Volume: `卷${index}`, VolumeId: `VOL${index}` })) };
const clampedHandler = createHandler(standardRoutes({ bookLinksResponse: manyLinks }));
const clampedResult = await clampedHandler({ query: "李白写过《将进酒》吗", limits: { maxSources: 99 } });
assert(clampedResult.body.sources.length === 4, "maxSources 没有被钳制到合同上限 4");

// 9. 有界缓存：同一问句重复寻迹只打一次上游；负缓存同样生效。
const cachedFetch = fakeUpstream(standardRoutes());
const cacheHandler = createSeekHandler({ authToken: "t", upstreamBase: UPSTREAM, fetchImpl: cachedFetch });
await cacheHandler({ query: "李白写过《将进酒》吗" });
await cacheHandler({ query: "李白写过《将进酒》吗" });
assert(cachedFetch.calls.length === 3, "同一问句第二次寻迹不应再请求上游");
const gapFetch = fakeUpstream(standardRoutes({ workResponse: { Writings: [] } }));
const gapHandler = createSeekHandler({ authToken: "t", upstreamBase: UPSTREAM, fetchImpl: gapFetch });
await gapHandler({ query: "李白写过《不存在》吗" });
await gapHandler({ query: "李白写过《不存在》吗" });
assert(gapFetch.calls.length === 2, "证据缺口负缓存没有生效（作者+作品各一次后不应重复请求）");

// 10. 缓存容量有界。
const tinyCache = createBoundedCache({ maxEntries: 2, positiveTtlMs: 60_000, negativeTtlMs: 60_000 });
tinyCache.set("a", 1);
tinyCache.set("b", 2);
tinyCache.set("c", 3);
assert(tinyCache.get("a") === null && tinyCache.get("c") === 3, "缓存没有保持有界淘汰");

// 11. HTTP 层：健康检查、鉴权与方法限制。
const httpFetch = fakeUpstream(standardRoutes());
const service = createSouyunGatewayService({ authToken: "server-only-token", upstreamBase: UPSTREAM, fetchImpl: httpFetch });
await new Promise((resolve) => service.listen(0, resolve));
const httpBase = `http://127.0.0.1:${service.address().port}`;
const health = await fetch(`${httpBase}/healthz`);
assert(health.status === 200, "健康检查端点不可用");
const unauthorized = await fetch(`${httpBase}/seek`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer wrong" }, body: JSON.stringify({ query: "李白写过《将进酒》吗" }) });
assert(unauthorized.status === 401, "错误 token 没有被拒绝");
const methodNotAllowed = await fetch(`${httpBase}/seek`);
assert(methodNotAllowed.status === 404, "非 POST 请求没有被拒绝");
const noUpstreamBeforeAuth = httpFetch.calls.length;
await fetch(`${httpBase}/seek`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer wrong" }, body: JSON.stringify({ query: "李白写过《将进酒》吗" }) });
assert(httpFetch.calls.length === noUpstreamBeforeAuth, "鉴权失败的请求不得触达上游");
const authorized = await fetch(`${httpBase}/seek`, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer server-only-token" }, body: JSON.stringify({ query: "李白写过《将进酒》吗", limits: { maxHops: 2, maxNodes: 8, maxEdges: 8, maxSources: 4 } }) });
const authorizedBody = await authorized.json();
assert(authorized.status === 200 && authorizedBody.kind === "evidence", "HTTP 层没有透传核心处理结果");
const noTokenService = () => createSouyunGatewayService({ authToken: "" });
let threw = false;
try { noTokenService(); } catch { threw = true; }
assert(threw, "未配置认证 token 时服务必须拒绝启动");
await new Promise((resolve) => service.close(resolve));

// 13. /seek 地点流：key=地点 命中优先，AuthorPlace 过滤兜底，复用证据链与时空索引。
const authorWorksResponse = {
  AuthorWritings: {
    Name: "李白", Dynasty: "盛唐", Id: 15188, WritingCount: 1111,
    Writings: [
      { Id: 26453, Title: { Content: "鼓吹曲辞 将进酒" }, AuthorDate: "736年", AuthorPlace: "CN410185,嵩山" },
      { Id: 501, Title: { Content: "无地点的诗" }, AuthorPlace: null },
    ],
  },
};
const placeKeyFetch = fakeUpstream([
  { match: (url, body) => url === `${UPSTREAM}/api/Writing/Find` && body?.author && !body?.key && !body?.dynasty, response: driftAuthorsResponse },
  { match: (url, body) => url === `${UPSTREAM}/api/Writing/Find` && body?.key === "嵩山" && body?.author, response: { WritingCount: 1, Writings: [{ Id: 9, Title: { Content: "送杨山人归嵩山" }, AuthorDate: "744年" }] } },
  { match: (url) => url === `${UPSTREAM}/api/Writing/9/BookLinks`, response: bookLinksResponse },
]);
const placeKeyHandler = createSeekHandler({ authToken: "t", upstreamBase: UPSTREAM, fetchImpl: placeKeyFetch });
const placeKeyResult = await placeKeyHandler({ query: "李白在嵩山写过什么" });
assert(placeKeyResult.status === 200 && placeKeyResult.body.kind === "evidence", "地点问句（key 命中）没有产出证据");
assert(placeKeyResult.body.nodes[1].id === "cnk:work:9" && placeKeyResult.body.nodes[1].label === "送杨山人归嵩山", "key 命中的地点流作品节点不正确");
assert(placeKeyResult.body.temporalSpatial?.timeHints?.includes("744年"), "key 命中的地点流没有透传时间索引");
const placeFetch = fakeUpstream([
  { match: (url, body) => url === `${UPSTREAM}/api/Writing/Find` && body?.author && !body?.key && !body?.dynasty, response: driftAuthorsResponse },
  { match: (url, body) => url === `${UPSTREAM}/api/Writing/Find` && body?.key && body?.author, ok: false, status: 404 },
  { match: (url, body) => url === `${UPSTREAM}/api/Writing/Find` && body?.author && body?.dynasty === "盛唐", response: authorWorksResponse },
  { match: (url) => url === `${UPSTREAM}/api/Writing/26453/BookLinks`, response: bookLinksResponse },
]);
const placeHandler = createSeekHandler({ authToken: "t", upstreamBase: UPSTREAM, fetchImpl: placeFetch });
const placeResult = await placeHandler({ query: "李白在嵩山写过什么" });
assert(placeResult.status === 200 && placeResult.body.kind === "evidence", "地点问句（AuthorPlace 兜底）没有产出证据");
assert(placeResult.body.nodes[1].id === "cnk:work:26453" && placeResult.body.nodes[1].label === "将进酒", "兜底地点流作品节点没有用短标题");
assert(placeResult.body.temporalSpatial?.places?.includes("嵩山"), "兜底地点流没有透传时空索引");
const dynastyFindCall = placeFetch.calls.find((call) => call.body?.dynasty === "盛唐");
assert(Boolean(dynastyFindCall) && dynastyFindCall.body?.author === "李白", "兜底地点流没有带 dynasty 重查 Find 收窄作者作品页");
const noPlaceFetch = fakeUpstream([
  { match: (url, body) => url === `${UPSTREAM}/api/Writing/Find` && body?.author && !body?.key && !body?.dynasty, response: driftAuthorsResponse },
  { match: (url, body) => url === `${UPSTREAM}/api/Writing/Find` && body?.key && body?.author, ok: false, status: 404 },
  { match: (url, body) => url === `${UPSTREAM}/api/Writing/Find` && body?.author && body?.dynasty === "盛唐", response: authorWorksResponse },
]);
const noPlaceHandler = createSeekHandler({ authToken: "t", upstreamBase: UPSTREAM, fetchImpl: noPlaceFetch });
const noPlaceResult = await noPlaceHandler({ query: "李白在长安写过什么" });
assert(noPlaceResult.status === 200 && noPlaceResult.body.kind === "evidence_gap" && noPlaceResult.body.reason.includes("长安"), "无地点记录应返回证据缺口");
await noPlaceHandler({ query: "李白在长安写过什么" });
assert(noPlaceFetch.calls.length === 3, "地点缺口的负缓存没有生效");

// 14. /works 端点：漂移过滤 + 有界候选 + 时空优先。
const { createWorksHandler } = await import("./souyun-gateway-service.mjs");
const worksUpstream = async (url, options) => {
  const body = options?.body ? JSON.parse(options.body) : null;
  if (String(url).endsWith("/Writing/Find") && body?.author) {
    return { ok: true, status: 200, json: async () => ({ AuthorWritings: { Name: "李白", Dynasty: "盛唐", Id: 15188, WritingCount: 1111, Writings: [
      { Id: 1, Title: { Content: "无日期无地点的诗" } },
      { Id: 2, Title: { Content: "望庐山瀑布" }, AuthorPlace: "CNxxxx,庐山" },
      { Id: 3, Title: { Content: "静夜思" }, AuthorDate: "726年" },
      { Id: 4, Title: { Content: "早发白帝城" }, AuthorDate: "759年", AuthorPlace: "CNyyyy,白帝城" },
    ] } }) };
  }
  throw new Error(`worksUpstream 无路由 ${url}`);
};
const worksHandler = createWorksHandler({ authToken: "t", upstreamBase: UPSTREAM, fetchImpl: worksUpstream });
const worksResult = await worksHandler({ person: "李白" });
assert(worksResult.status === 200 && worksResult.body.kind === "works", "/works 没有产出作品列表");
assert(worksResult.body.totalCount === 1111, "/works 没有透传作品总数");
assert(worksResult.body.works.length === 3, "/works 候选应封顶 3 条");
assert(worksResult.body.works.every((work) => work.date || work.place), "/works 没有优先返回带时空信息的作品");
assert(worksResult.body.works.some((work) => work.title === "静夜思"), "/works 标题没有归一化");
const worksAmbiguousHandler = createWorksHandler({
  authToken: "t", upstreamBase: UPSTREAM,
  fetchImpl: async (url) => {
    if (String(url).endsWith("/Writing/Find")) return { ok: true, status: 200, json: async () => ({ Dynasties: [{ Name: "盛唐", Authors: [{ Id: 1, Name: "王维" }] }, { Name: "明", Authors: [{ Id: 2, Name: "王维" }] }] }) };
    throw new Error("不应再请求作品页");
  },
});
const worksAmbiguous = await worksAmbiguousHandler({ person: "王维" });
assert(worksAmbiguous.body.kind === "person_ambiguous" && worksAmbiguous.body.candidates[0].name === "盛唐·王维", "/works 同名人物应返回朝代候选");

console.log("Souyun CNKGraph gateway contract verified: 作者漂移过滤（同姓陷阱与换行名字）、双响应形态、证据转换、来源钳制、缓存边界、HTTP 鉴权、地点流与作品列表端点均通过。");
