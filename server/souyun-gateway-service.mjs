import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

/**
 * 独立部署的搜韵 CNKGraph gateway 骨架。
 *
 * 位置（见 docs/souyun-cnkgraph-gateway-contract.md）：
 *   notebook 服务端适配器 (cnkgraph-gateway.mjs)
 *     -> 本服务（HTTPS + Bearer 认证，server-only）
 *       -> https://api.cnkgraph.com（真实搜韵开放 API，仅限非商业用途）
 *
 * 本服务负责三件事：
 *   1. 作者漂移过滤：Writing/Find 的 exactlyMatch 对 author 不生效，
 *      会返回整个同姓作者列表（含带换行的名字，如 "\n李敬舆"），必须按
 *      Name 全等过滤；且唯一作者时响应是 AuthorWritings 形态，多位作者
 *      时是 Dynasties 形态，两种都要解析。
 *   2. 响应转换：把上游 JSON 转成内部合同的 evidence / evidence_gap 形状。
 *   3. 有界查询：最多 8 节点、8 边、4 来源，只取第 0 页，不分页不二次发现。
 *
 * 上游实测行为（2026-08-22 审计）：
 *   - 无需认证，公开 GET/POST；
 *   - Accept-Language: zh-hans 转简体（但 Classes 等字段仍可能是繁体）；
 *   - 上游 404 有两种不一致的错误体（ProblemDetails / {Message}），
 *     不要依赖统一错误 schema；
 *   - cnkgraph.com/Writing/{id} 会 302 到登录页，来源 URL 必须用
 *     https://api.cnkgraph.com/api/Writing/{id}。
 */

const DEFAULT_UPSTREAM_BASE = "https://api.cnkgraph.com";
const DEFAULT_PORT = 8787;
const QUERY_MAX_CHARS = 160;
const MAX_REQUEST_BODY_BYTES = 10_000;
const CONTRACT_LIMITS = Object.freeze({ maxHops: 2, maxNodes: 8, maxEdges: 8, maxSources: 4 });

function collapseWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function safeIdFragment(value) {
  const fragment = String(value ?? "").trim().replace(/[^A-Za-z0-9._:-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return fragment || null;
}

function clampLimit(value, fallback, cap) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), cap);
}

/** 问句槽位抽取：支持「某人物写过某作品」与「某人物在某地写过（什么）」。 */
const VERB_PATTERN = /(写过|写了|作过|创作过)/u;
const PLACE_QUESTION = /^(.{1,24}?)(?:的)?在(.{1,16}?)(?=写过|留下过|作过|吗|呢|吧|？|。|！|，|,|$)/u;
const PERSON_LEADING_NOISE = /^(?:请问|我想知道|是不是|是否|有没有|是)/u;
const PERSON_TRAILING_NOISE = /(?:的|了|是不是|是否|有没有|吗|呢|吧)$/u;
const WORK_TAIL_NOISE = /(?:吗|呢|吧|么|啊|没有)+$/u;

export function extractSlots(rawQuery) {
  const query = collapseWhitespace(rawQuery);
  if (!query || query.length > QUERY_MAX_CHARS) return null;

  // 地点线问句：「李白在嵩山写过什么」「李白在黄州写过《寒食帖》吗」。
  // 注意「存在」等词也含「在」：guard 不通过时 fall through 到普通问句解析，
  // 不整体拒绝（否则「完全不存在的人写过《将进酒》吗」会被误判为不支持）。
  const placeMatch = PLACE_QUESTION.exec(query);
  if (placeMatch) {
    const person = collapseWhitespace(placeMatch[1].replace(PERSON_LEADING_NOISE, "").replace(PERSON_TRAILING_NOISE, ""));
    const place = collapseWhitespace(placeMatch[2]);
    const book = /《([^《》]{1,60})》/u.exec(query);
    const work = book ? collapseWhitespace(book[1]) : null;
    if (person && person.length >= 2 && person.length <= 24 && place && place.length <= 16 && !VERB_PATTERN.test(person) && !/《|》|在|的|人|什/.test(place)) {
      return { person, work, place };
    }
  }

  let work = null;
  let rest = query;
  const book = /《([^《》]{1,60})》/u.exec(query);
  if (book) {
    work = collapseWhitespace(book[1]);
    rest = collapseWhitespace(`${query.slice(0, book.index)} ${query.slice(book.index + book[0].length)}`);
  }
  let person = null;
  if (work) {
    // 有书名号：书名号前的第一段就是人物候选。
    const firstSegment = rest.split(/[，。？！,?!]/)[0] ?? "";
    person = collapseWhitespace(firstSegment.replace(VERB_PATTERN, " "));
  } else {
    const verb = VERB_PATTERN.exec(query);
    if (!verb) return null;
    person = collapseWhitespace(query.slice(0, verb.index));
    work = collapseWhitespace(query.slice(verb.index + verb[0].length).replace(WORK_TAIL_NOISE, "").replace(/[?？。！!，,]/g, ""));
  }
  person = collapseWhitespace(person.replace(PERSON_LEADING_NOISE, "").replace(PERSON_TRAILING_NOISE, ""));
  work = collapseWhitespace((work ?? "").replace(WORK_TAIL_NOISE, "").replace(/[?？。！!，,]/g, ""));
  if (!person || !work || person.length > 24 || work.length > 60) return null;
  if (/《|》/.test(person) || VERB_PATTERN.test(person) || VERB_PATTERN.test(work)) return null;
  return { person, work, place: null };
}

/**
 * 作者漂移过滤（核心）。exactlyMatch 对 author 不生效，必须 Name 全等；
 * 同一 Id 可能出现在多个朝代分组里，先去重再判歧义。
 */
export function resolveAuthorFromFind(findResult, personName) {
  const target = collapseWhitespace(personName);
  if (!target) return { kind: "none" };
  const candidates = [];
  const seenIds = new Set();
  const push = (author, dynasty) => {
    const name = collapseWhitespace(author?.Name);
    const id = Number(author?.Id);
    if (name !== target || !Number.isInteger(id) || seenIds.has(id)) return;
    seenIds.add(id);
    candidates.push({ id, name, dynasty: collapseWhitespace(dynasty) || null });
  };
  for (const dynasty of Array.isArray(findResult?.Dynasties) ? findResult.Dynasties : []) {
    for (const author of Array.isArray(dynasty?.Authors) ? dynasty.Authors : []) push(author, dynasty?.Name);
  }
  if (candidates.length === 0) {
    // 唯一作者时上游直接返回 AuthorWritings 形态。
    push(findResult?.AuthorWritings, findResult?.AuthorWritings?.Dynasty);
  }
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  return { kind: "unique", author: candidates[0] };
}

/** 作品解析：优先取清洗后标题包含关键词的结果（处理「鼓吹曲辞 将进酒」前缀）。 */
export function resolveWorkFromFind(findResult, workKeyword) {
  const writings = Array.isArray(findResult?.Writings) ? findResult.Writings : [];
  if (writings.length === 0) return null;
  const keyword = collapseWhitespace(workKeyword);
  const matchedByTitle = writings.find((writing) => collapseWhitespace(writing?.Title?.Content).includes(keyword));
  const chosen = matchedByTitle ?? writings[0];
  const id = Number(chosen?.Id);
  if (!Number.isInteger(id)) return null;
  const title = collapseWhitespace(chosen?.Title?.Content);
  // 标题命中时用用户确认词做展示 label；否则退回真实标题。
  return { id, title, label: matchedByTitle ? keyword : (title || keyword) };
}

/** 展示用短标题：「鼓吹曲辞 将进酒」→「将进酒」；组诗「其一」不单独成题。 */
export function shortDisplayTitle(title) {
  const text = collapseWhitespace(title);
  if (!text) return null;
  if (text.includes(" ")) {
    const last = text.split(/\s+/).at(-1);
    if (last.length >= 2 && !/^[其第][一二三四五六七八九十百]+$/.test(last)) return last;
  }
  return text.length <= 24 ? text : `${text.slice(0, 23)}…`;
}

/** AuthorPlace 形如 "CN410185,嵩山"；去掉行政区划码后做包含匹配。 */
export function placeInAuthorPlace(rawPlace, place) {
  const normalized = collapseWhitespace(String(rawPlace ?? "").replace(/CN\d+/g, "").replace(/[\s,，、;；]/g, ""));
  const target = collapseWhitespace(place);
  return Boolean(target) && normalized.includes(target);
}

/** 从 Writing 条目解析作品；keyword 命中标题时优先用用户确认词做 label。 */
export function workFromWriting(writing, keyword) {
  const id = Number(writing?.Id);
  if (!Number.isInteger(id)) return null;
  const title = collapseWhitespace(writing?.Title?.Content);
  if (!title) return null;
  const wanted = collapseWhitespace(keyword);
  return { id, title, label: wanted && title.includes(wanted) ? wanted : shortDisplayTitle(title) };
}

/**
 * 取作者作品页（仅第 0 页，20 首）。唯一作者时 Writing/Find 直接附带；
 * 否则带 dynasty（漂移分组名）重查 Find 收窄到 AuthorWritings——
 * 注意 OpenAPI 所写的 /api/Writing/{dynasty}/{author}/{authorId} 路径
 * 实测返回 CSV 而非 JSON（2026-08-22 审计），不可用。
 */
async function fetchAuthorWritings({ fetchImpl, base, author, authorFind, timeoutMs, findUrl }) {
  const initial = Array.isArray(authorFind?.AuthorWritings?.Writings)
    ? { writings: authorFind.AuthorWritings.Writings, totalCount: Number(authorFind.AuthorWritings.WritingCount) || null }
    : null;
  if (initial) return initial;
  if (!author?.dynasty || !author?.name) return null;
  const url = findUrl ?? `${base}/api/Writing/Find`;
  try {
    const payload = await callUpstream({ fetchImpl, url, method: "POST", body: { author: author.name, dynasty: author.dynasty, exactlyMatch: true, pageNo: 0 }, timeoutMs });
    return Array.isArray(payload?.AuthorWritings?.Writings)
      ? { writings: payload.AuthorWritings.Writings, totalCount: Number(payload.AuthorWritings.WritingCount) || null }
      : null;
  } catch {
    return null;
  }
}

/** 从 Writing/Find 的 AuthorPlace（"CN410185,嵩山"）与 AuthorDate（"736年"）提取有界时空索引。 */
export function extractTemporalSpatial(findResult, workLabel) {
  const places = [];
  for (const place of String(findResult?.Writings?.[0]?.AuthorPlace ?? "").split(",")) {
    const name = collapseWhitespace(place).replace(/^CN\d+/, "");
    if (name && !places.includes(name) && places.length < 4) places.push(name);
  }
  const rawDate = collapseWhitespace(findResult?.Writings?.[0]?.AuthorDate ?? "");
  const year = /(\d{3,4})/.exec(rawDate)?.[1];
  const timeHints = [];
  if (rawDate && timeHints.length < 4) timeHints.push(truncate(rawDate, 80));
  return {
    places,
    timeHints,
    timeline: year ? [{ year: Number(year), label: truncate(`《${workLabel}》创作于${rawDate}`, 120) }] : [],
  };
}

/**
 * 解析「朝代·姓名」或纯姓名的人物请求（歧义澄清后用户可能写「盛唐·李白」）。
 */
export function parsePersonInput(rawInput) {
  const text = collapseWhitespace(rawInput);
  if (!text || text.length > 24) return null;
  const match = /^([^·]{1,6})·([^·]{1,8})$/u.exec(text);
  if (match) return { person: collapseWhitespace(match[2]), dynastyHint: collapseWhitespace(match[1]) };
  return { person: text, dynastyHint: null };
}

/**
 * 人物锚点解析：漂移过滤 → （歧义时按朝代提示过滤）→ People/{id} 档案归一化。
 * 返回 person_anchor / person_ambiguous / evidence_gap。
 */
export function resolvePersonAnchor({ findResult, personName, dynastyHint, personProfile, upstreamBase = DEFAULT_UPSTREAM_BASE }) {
  const target = collapseWhitespace(personName);
  if (!target) return { kind: "evidence_gap", reason: "人物名为空。" };
  let resolution = resolveAuthorFromFind(findResult, target);
  if (resolution.kind === "ambiguous" && dynastyHint) {
    const narrowed = resolution.candidates.filter((candidate) => candidate.dynasty && candidate.dynasty.includes(dynastyHint));
    if (narrowed.length === 1) resolution = { kind: "unique", author: narrowed[0] };
  }
  if (resolution.kind === "none") {
    return { kind: "evidence_gap", reason: `诗文库没有与「${target}」精确同名的作者记录。` };
  }
  if (resolution.kind === "ambiguous") {
    return {
      kind: "person_ambiguous",
      candidates: resolution.candidates.slice(0, 4).map((candidate) => ({
        name: `${candidate.dynasty ?? "朝代不详"}·${candidate.name}`,
        dynasty: candidate.dynasty,
        life: candidate.life ?? null,
      })),
    };
  }
  const author = resolution.author;
  const profile = personProfile?.Person?.Profile;
  const details = Array.isArray(personProfile?.Person?.Details) ? personProfile.Person.Details : [];
  return {
    kind: "person_anchor",
    anchor: {
      id: `cnk:person:${author.id}`,
      name: profile?.Name ?? target,
      dynasty: profile?.Dynasty ?? author.dynasty ?? null,
      life: [profile?.BirthYear, profile?.DeathYear].filter(Boolean).join("—") || null,
      aliases: (Array.isArray(profile?.Aliases) ? profile.Aliases : []).map((alias) => collapseWhitespace(alias?.Name)).filter(Boolean).slice(0, 8),
      titles: (Array.isArray(profile?.Titles) ? profile.Titles : []).map(collapseWhitespace).filter(Boolean).slice(0, 8),
      hometown: collapseWhitespace(profile?.Hometown?.[0]?.Name) || null,
      details: details.slice(0, 2).map((detail) => ({
        book: collapseWhitespace(detail?.Book) || "CNKGraph 人物档案",
        text: truncate(collapseWhitespace(detail?.Content), 180),
      })),
      source: [{ label: "CNKGraph 人物档案（搜韵）", url: `${upstreamBase}/api/People/${author.id}` }],
    },
  };
}

/** 把 BookLinks 转成内部合同 sources；无可用出处时退回作品条目本身。 */
export function buildSources({ work, authorName, bookLinks, maxSources, upstreamBase }) {
  const writingUrl = `${upstreamBase}/api/Writing/${work.id}`;
  const sources = [];
  const usedIds = new Set();
  for (const link of Array.isArray(bookLinks?.Links) ? bookLinks.Links : []) {
    if (sources.length >= maxSources) break;
    const book = collapseWhitespace(link?.Book);
    if (!book) continue;
    const volume = collapseWhitespace(link?.Volume);
    const fragment = safeIdFragment(link?.VolumeId) ?? safeIdFragment(link?.StartPage) ?? String(sources.length);
    const base = `《${book}》${volume}`;
    const id = `source:cnk:w:${work.id}:${fragment}`;
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    sources.push({
      id,
      label: truncate(base, 240),
      claim: truncate(`${base}收录${authorName}《${work.label}》。`, 240),
      url: writingUrl,
    });
  }
  if (sources.length === 0) {
    sources.push({
      id: `source:cnk:w:${work.id}:entry`,
      label: truncate(`CNKGraph 诗文库《${work.label}》条目`, 240),
      claim: truncate(`CNKGraph 诗文库收录${authorName}《${work.label}》。`, 240),
      url: writingUrl,
    });
  }
  return sources;
}

async function callUpstream({ fetchImpl, url, method = "GET", body, timeoutMs }) {
  const controller = new AbortController();
  let timer;
  try {
    const response = await Promise.race([
      fetchImpl(url, {
        method,
        headers: { "Content-Type": "application/json", "Accept-Language": "zh-hans" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("upstream_timeout"));
        }, timeoutMs);
      }),
    ]);
    if (!response?.ok) {
      const error = new Error(`upstream_status_${response?.status ?? "unknown"}`);
      error.status = response?.status;
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (error instanceof Error && (error.message === "upstream_timeout" || error.name === "AbortError")) {
      throw new Error("upstream_timeout");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 有界 TTL 缓存：成功结果长缓存，证据缺口短负缓存，容量有限。 */
export function createBoundedCache({ maxEntries = 128, positiveTtlMs = 600_000, negativeTtlMs = 30_000 } = {}) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key, value, { negative = false } = {}) {
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      entries.set(key, { value, expiresAt: Date.now() + (negative ? negativeTtlMs : positiveTtlMs) });
    },
  };
}

function upstreamFailure(error) {
  return error instanceof Error && error.message === "upstream_timeout"
    ? { status: 504, body: { error: "upstream_timeout" } }
    : { status: 502, body: { error: "upstream_unavailable" } };
}

/**
 * 纯核心：输入适配器请求体 { query, limits }，输出 { status, body }。
 * status 200 + evidence/evidence_gap 为正常结果；401/400/502/504 由 HTTP 层语义映射。
 */
export function createSeekHandler({
  authToken,
  upstreamBase = process.env.SOUYUN_API_BASE || DEFAULT_UPSTREAM_BASE,
  fetchImpl = fetch,
  perCallTimeoutMs = 2_500,
  totalBudgetMs = 7_000,
  cache = createBoundedCache(),
} = {}) {
  if (!authToken) throw new Error("SOUYUN_GATEWAY_AUTH_TOKEN 未配置；gateway 拒绝在无认证时启动。");
  const base = String(upstreamBase).replace(/\/+$/, "");
  const findUrl = `${base}/api/Writing/Find`;

  return async function handleSeek(requestBody) {
    const query = collapseWhitespace(requestBody?.query);
    if (!query || query.length > QUERY_MAX_CHARS) {
      return { status: 400, body: { error: "invalid_query" } };
    }
    const maxSources = clampLimit(requestBody?.limits?.maxSources, CONTRACT_LIMITS.maxSources, CONTRACT_LIMITS.maxSources);
    const slots = extractSlots(query);
    const gap = (reason) => ({ status: 200, body: { kind: "evidence_gap", reason: truncate(reason, 240) } });
    if (!slots) {
      return gap("当前 gateway 只支持「某人物写过某作品」式的问句，例如「李白写过《将进酒》吗」。");
    }
    const cacheKey = `${slots.person}\u0000${slots.work ?? ""}\u0000${slots.place ?? ""}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const deadline = Date.now() + totalBudgetMs;
    const callBudget = () => Math.min(perCallTimeoutMs, Math.max(deadline - Date.now(), 1));

    // 第 1 步：作者检索 + 漂移过滤。
    let authorFind;
    try {
      authorFind = await callUpstream({ fetchImpl, url: findUrl, method: "POST", body: { author: slots.person, exactlyMatch: true, pageNo: 0 }, timeoutMs: callBudget() });
    } catch (error) {
      // 上游对「无匹配」返回 404（"沒找到與搜索條件相符的作品"），是明确无结果而不是故障。
      if (error instanceof Error && error.status === 404) {
        const result = gap(`诗文库没有与「${slots.person}」精确同名的作者记录。`);
        cache.set(cacheKey, result, { negative: true });
        return result;
      }
      return upstreamFailure(error);
    }
    const authorResolution = resolveAuthorFromFind(authorFind, slots.person);
    if (authorResolution.kind === "none") {
      const result = gap(`诗文库没有与「${slots.person}」精确同名的作者记录。`);
      cache.set(cacheKey, result, { negative: true });
      return result;
    }
    if (authorResolution.kind === "ambiguous") {
      const dynasties = authorResolution.candidates.map((candidate) => candidate.dynasty ?? "朝代不详").filter(Boolean).join("、");
      const result = gap(`存在多位同名作者（${truncate(dynasties, 120)}），需要朝代等线索澄清后再寻迹。`);
      cache.set(cacheKey, result, { negative: true });
      return result;
    }
    const author = authorResolution.author;

    // 第 2 步：作品定位——地点问句先按 key=地点 搜标题/内容，再兜底 AuthorPlace 过滤；其余按 key+author 检索。
    let work = null;
    let workFind = null;
    if (slots.place) {
      let located = null;
      try {
        workFind = await callUpstream({ fetchImpl, url: findUrl, method: "POST", body: { key: slots.place, author: author.name, exactlyMatch: true, pageNo: 0 }, timeoutMs: callBudget() });
        located = (Array.isArray(workFind?.Writings) ? workFind.Writings : []).find((candidate) => collapseWhitespace(candidate?.Title?.Content).includes(slots.place) && Number.isInteger(Number(candidate?.Id))) ?? null;
      } catch (error) {
        if (error instanceof Error && error.status === 404) {
          workFind = null;
          located = null;
        } else {
          return upstreamFailure(error);
        }
      }
      if (!located) {
        const worksPage = await fetchAuthorWritings({ fetchImpl, base, author, authorFind, timeoutMs: callBudget(), findUrl });
        const placeMatches = (worksPage?.writings ?? []).filter((candidate) => placeInAuthorPlace(candidate?.AuthorPlace, slots.place) && Number.isInteger(Number(candidate?.Id)));
        located = (slots.work ? placeMatches.find((candidate) => collapseWhitespace(candidate?.Title?.Content).includes(slots.work)) : undefined) ?? placeMatches[0] ?? null;
        if (located) workFind = { Writings: [located] };
      } else {
        workFind = { Writings: [located] };
      }
      if (!located) {
        const result = gap(`没有找到${author.name}在「${slots.place}」留下笔墨的作品记录。`);
        cache.set(cacheKey, result, { negative: true });
        return result;
      }
      work = workFromWriting(located, slots.work);
    } else {
      try {
        workFind = await callUpstream({ fetchImpl, url: findUrl, method: "POST", body: { key: slots.work, author: author.name, exactlyMatch: true, pageNo: 0 }, timeoutMs: callBudget() });
      } catch (error) {
        // 同上：404 表示明确无匹配作品。
        if (error instanceof Error && error.status === 404) {
          const result = gap(`没有找到${author.name}名下与「${slots.work}」对应的作品。`);
          cache.set(cacheKey, result, { negative: true });
          return result;
        }
        return upstreamFailure(error);
      }
      work = resolveWorkFromFind(workFind, slots.work);
    }
    if (!work) {
      const result = gap(`没有找到${author.name}名下与「${slots.work ?? slots.place}」对应的作品。`);
      cache.set(cacheKey, result, { negative: true });
      return result;
    }

    // 第 3 步：证据出处（BookLinks 失败不致命，退回作品条目来源）。
    let bookLinks = null;
    try {
      bookLinks = await callUpstream({ fetchImpl, url: `${base}/api/Writing/${work.id}/BookLinks`, timeoutMs: callBudget() });
    } catch {
      bookLinks = null;
    }
    const sources = buildSources({ work, authorName: author.name, bookLinks, maxSources, upstreamBase: base });
    const personNodeId = `cnk:person:${author.id}`;
    const workNodeId = `cnk:work:${work.id}`;
    const temporalSpatial = extractTemporalSpatial(workFind, work.label);
    const evidence = {
      kind: "evidence",
      nodes: [
        { id: personNodeId, label: author.name, type: "Person" },
        { id: workNodeId, label: work.label, type: "Work" },
      ],
      edges: [{
        source: personNodeId,
        relation: "作者",
        target: workNodeId,
        evidenceRefs: sources.map((source) => source.id),
      }],
      sources,
      // 内部合同扩展：可选的二级时空索引（有界 4 项），由上游 AuthorPlace/AuthorDate 确定性提取。
      ...(temporalSpatial.places.length > 0 || temporalSpatial.timeHints.length > 0 || temporalSpatial.timeline.length > 0
        ? { temporalSpatial: { places: temporalSpatial.places, timeHints: temporalSpatial.timeHints, timeline: temporalSpatial.timeline } }
        : {}),
    };
    const result = { status: 200, body: evidence };
    cache.set(cacheKey, result);
    return result;
  };
}

async function readJsonBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * 人物锚点端点：{ person } → 漂移过滤 → People/{id} → person_anchor。
 * 歧义时返回 person_ambiguous（带「朝代·姓名」候选，用户点选后可带 dynastyHint 重试）。
 */
export function createAnchorHandler({
  authToken,
  upstreamBase = process.env.SOUYUN_API_BASE || DEFAULT_UPSTREAM_BASE,
  fetchImpl = fetch,
  perCallTimeoutMs = 2_500,
  totalBudgetMs = 7_000,
  cache = createBoundedCache(),
} = {}) {
  if (!authToken) throw new Error("SOUYUN_GATEWAY_AUTH_TOKEN 未配置；gateway 拒绝在无认证时启动。");
  const base = String(upstreamBase).replace(/\/+$/, "");
  const findUrl = `${base}/api/Writing/Find`;

  return async function handleAnchor(requestBody) {
    const parsed = parsePersonInput(requestBody?.person);
    if (!parsed || !/^[\p{Script=Han}·]{2,12}$/u.test(parsed.person)) {
      return { status: 400, body: { error: "invalid_person" } };
    }
    const cacheKey = `anchor\u0000${parsed.person}\u0000${parsed.dynastyHint ?? ""}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const deadline = Date.now() + totalBudgetMs;
    const callBudget = () => Math.min(perCallTimeoutMs, Math.max(deadline - Date.now(), 1));

    let authorFind;
    try {
      authorFind = await callUpstream({ fetchImpl, url: findUrl, method: "POST", body: { author: parsed.person, exactlyMatch: true, pageNo: 0 }, timeoutMs: callBudget() });
    } catch (error) {
      if (error instanceof Error && error.status === 404) {
        const result = { status: 200, body: { kind: "evidence_gap", reason: `诗文库没有与「${parsed.person}」精确同名的作者记录。` } };
        cache.set(cacheKey, result, { negative: true });
        return result;
      }
      return upstreamFailure(error);
    }
    const anchorResolution = resolvePersonAnchor({ findResult: authorFind, personName: parsed.person, dynastyHint: parsed.dynastyHint, personProfile: null, upstreamBase: base });
    if (anchorResolution.kind !== "person_anchor") {
      const result = { status: 200, body: anchorResolution };
      cache.set(cacheKey, result, { negative: true });
      return result;
    }
    let personProfile = null;
    try {
      personProfile = await callUpstream({ fetchImpl, url: `${base}/api/People/${Number(anchorResolution.anchor.id.split(":").pop())}`, timeoutMs: callBudget() });
    } catch {
      personProfile = null;
    }
    const full = resolvePersonAnchor({ findResult: authorFind, personName: parsed.person, dynastyHint: parsed.dynastyHint, personProfile, upstreamBase: base });
    const result = { status: 200, body: full };
    cache.set(cacheKey, result);
    return result;
  };
}

/**
 * 作品列表端点：{ person } → 漂移过滤 → 作者作品页（第 0 页）→ 有界候选。
 * 优先返回带创作时间/地点的作品（可支撑后续时空索引），确定性排序，不经过模型。
 */
export function createWorksHandler({
  authToken,
  upstreamBase = process.env.SOUYUN_API_BASE || DEFAULT_UPSTREAM_BASE,
  fetchImpl = fetch,
  perCallTimeoutMs = 2_500,
  totalBudgetMs = 7_000,
  cache = createBoundedCache(),
} = {}) {
  if (!authToken) throw new Error("SOUYUN_GATEWAY_AUTH_TOKEN 未配置；gateway 拒绝在无认证时启动。");
  const base = String(upstreamBase).replace(/\/+$/, "");
  const findUrl = `${base}/api/Writing/Find`;

  return async function handleWorks(requestBody) {
    const parsed = parsePersonInput(requestBody?.person);
    const name = parsed?.person;
    if (!name || !/^[\p{Script=Han}·]{2,12}$/u.test(name)) {
      return { status: 400, body: { error: "invalid_person" } };
    }
    const cacheKey = `works\u0000${name}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const deadline = Date.now() + totalBudgetMs;
    const callBudget = () => Math.min(perCallTimeoutMs, Math.max(deadline - Date.now(), 1));

    let authorFind;
    try {
      authorFind = await callUpstream({ fetchImpl, url: findUrl, method: "POST", body: { author: name, exactlyMatch: true, pageNo: 0 }, timeoutMs: callBudget() });
    } catch (error) {
      if (error instanceof Error && error.status === 404) {
        const result = { status: 200, body: { kind: "evidence_gap", reason: `诗文库没有与「${name}」精确同名的作者记录。` } };
        cache.set(cacheKey, result, { negative: true });
        return result;
      }
      return upstreamFailure(error);
    }
    const resolution = resolveAuthorFromFind(authorFind, name);
    if (resolution.kind === "none") {
      const result = { status: 200, body: { kind: "evidence_gap", reason: `诗文库没有与「${name}」精确同名的作者记录。` } };
      cache.set(cacheKey, result, { negative: true });
      return result;
    }
    if (resolution.kind === "ambiguous") {
      const result = {
        status: 200,
        body: {
          kind: "person_ambiguous",
          candidates: resolution.candidates.slice(0, 4).map((candidate) => ({
            name: `${candidate.dynasty ?? "朝代不详"}·${candidate.name}`,
            dynasty: candidate.dynasty,
            life: candidate.life ?? null,
          })),
        },
      };
      cache.set(cacheKey, result, { negative: true });
      return result;
    }
    const author = resolution.author;
    const worksPage = await fetchAuthorWritings({ fetchImpl, base, author, authorFind, timeoutMs: callBudget(), findUrl });
    const valid = (worksPage?.writings ?? [])
      .map((writing) => {
        const parsedWork = workFromWriting(writing, null);
        return parsedWork ? {
          id: parsedWork.id,
          title: parsedWork.label,
          date: collapseWhitespace(writing?.AuthorDate) || null,
          place: collapseWhitespace(String(writing?.AuthorPlace ?? "").replace(/CN\d+/g, "").replace(/^[,，、\s]+|[,，、\s]+$/g, "")) || null,
        } : null;
      })
      .filter(Boolean);
    if (valid.length === 0) {
      const result = { status: 200, body: { kind: "evidence_gap", reason: `诗文库暂无「${author.name}」可展示的作品列表。` } };
      cache.set(cacheKey, result, { negative: true });
      return result;
    }
    const preferred = valid.filter((work) => work.date || work.place);
    const chosen = (preferred.length > 0 ? preferred : valid).slice(0, 3);
    const result = {
      status: 200,
      body: {
        kind: "works",
        name: author.name,
        dynasty: author.dynasty,
        totalCount: worksPage?.totalCount ?? valid.length,
        works: chosen,
      },
    };
    cache.set(cacheKey, result);
    return result;
  };
}

export function createSouyunGatewayService(options = {}) {
  const { authToken = process.env.SOUYUN_GATEWAY_AUTH_TOKEN } = options;
  const handleSeek = createSeekHandler({ ...options, authToken });
  const handleAnchor = createAnchorHandler({ ...options, authToken });
  const handleWorks = createWorksHandler({ ...options, authToken });
  return createServer(async (request, response) => {
    const send = (status, payload) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(payload));
    };
    if (request.method === "GET" && (request.url ?? "").split("?")[0] === "/healthz") {
      send(200, { status: "ok" });
      return;
    }
    const route = (request.url ?? "").split("?")[0];
    if (request.method !== "POST" || !["/seek", "/anchor", "/works"].includes(route)) {
      send(404, { error: "not_found" });
      return;
    }
    if ((request.headers.authorization ?? "") !== `Bearer ${authToken}`) {
      send(401, { error: "unauthorized" });
      return;
    }
    try {
      const body = await readJsonBody(request, MAX_REQUEST_BODY_BYTES);
      const result = route === "/anchor" ? await handleAnchor(body) : route === "/works" ? await handleWorks(body) : await handleSeek(body);
      send(result.status, result.body);
    } catch {
      send(400, { error: "bad_request" });
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.SOUYUN_GATEWAY_PORT || DEFAULT_PORT);
  const service = createSouyunGatewayService();
  service.listen(port, () => {
    console.log(`Souyun CNKGraph gateway listening on http://localhost:${port} (部署时必须置于 HTTPS 之后)`);
    console.log(`Upstream: ${process.env.SOUYUN_API_BASE || DEFAULT_UPSTREAM_BASE}`);
  });
}
