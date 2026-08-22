import { createAnchorResolver, createWorksResolver } from "./cnkgraph-gateway.mjs";
import { createPiNotebookSession, narrativeSystemPrompt } from "./notebook-agent.mjs";

/**
 * 旅程智能体编排：把前端已实现的完整智能体流程接上真实服务端。
 *
 * 三个入口：
 *   1. resolveNotebookAnchor——起笔人物名 → gateway /anchor → anchor_ready（人物档案）；
 *      同名歧义 → ambiguous outcome（「朝代·姓名」候选，点选后重试）。
 *   2. normalizeJourneyQuery——旅程寻迹时把代词/裸作品名归一成 gateway 可解析的
 *      「某人物写过某作品吗」问句（人物由锚点提供，不让用户重复写）。
 *   3. runNarrative——第二条证据后的 Pi 文化联想；未配置/失败时显式降级，
 *      前端已有本地模板兜底。
 *
 * 事实正文仍由 seek-outcome 的确定性核验生成；本文件只做编排与上下文组装。
 */

// 与前端 isPersonAnchorText 同一规则的简化版：2–8 个汉字（允许·）。
const PERSON_NAME_PATTERN = /^[\p{Script=Han}·]{2,8}$/u;
const PERSON_NOISE = /(什么|为什么|为何|哪里|关联|写过|作品|地点|经历|怎么样|怎么)/u;
const PRONOUN_PATTERN = /^(他|她|其|此人|該人|这个人)/u;

export function isPersonName(text) {
  const candidate = String(text ?? "").trim();
  return PERSON_NAME_PATTERN.test(candidate) && !PERSON_NOISE.test(candidate) && !(candidate.length > 4 && /[与和]/u.test(candidate));
}

/** 解析「朝代·姓名」（歧义候选点选后前端会回传这种形式）。 */
function splitDynastyName(text) {
  const match = /^([^·]{1,6})·([^·]{1,8})$/u.exec(String(text ?? "").trim());
  return match ? { person: match[2].trim(), dynasty: match[1].trim() } : null;
}

/**
 * 旅程感知的问句归一化：锚点人物已知时，把「他写过将进酒吗」「《将进酒》」
 * 归一成「{人物}写过{作品}吗」；地点线上把「在{地点}写过什么」或裸地点归一成
 * 「{人物}在{地点}写过什么」，供 gateway 的槽位抽取使用。已含人物名的问句原样返回。
 */
export function normalizeJourneyQuery(transcription, journey) {
  const text = String(transcription ?? "").replace(/\s+/g, " ").trim();
  const anchorName = typeof journey?.anchor === "string" && journey.anchor.trim() ? journey.anchor.trim() : null;
  if (!text || !anchorName) return text;
  if (text.includes(anchorName)) return text;
  // 「朝代·姓名」中的姓名部分也算已含人物名。
  const split = splitDynastyName(text);
  if (split && split.person === anchorName) return `${anchorName}写过什么吗`;
  // 地点线：「他在嵩山写过什么」→「李白在嵩山写过什么」。
  const placeQuestion = /^(?:他|她|其|此人)?的?在([\p{Script=Han}]{1,8}?)(?:写过什么|写过啥|留下过什么|留下过)(?:作品|笔墨|诗|词)?[吗呢吧？?。！，,]*$/u.exec(text);
  if (placeQuestion) return `${anchorName}在${placeQuestion[1]}写过什么`;
  // 地点路线上的裸地点词：「嵩山」→「李白在嵩山写过什么」（不含代词/「在」等结构词）。
  if (journey?.route === "space" && /^[\p{Script=Han}]{1,6}$/u.test(text) && !PERSON_NOISE.test(text) && !/[他她其在此]/u.test(text)) {
    return `${anchorName}在${text}写过什么`;
  }
  // 其余含「在」的结构不强行改写，交给 gateway 自行解析或给出问式缺口。
  if (/在/.test(text)) return text;
  const book = /《([^《》]{1,60})》/u.exec(text);
  if (book) return `${anchorName}写过《${book[1]}》吗`;
  const withoutPronoun = text.replace(PRONOUN_PATTERN, "").replace(/^(的|写过|写过什么)/u, "");
  const cleaned = withoutPronoun.replace(/^[，。？！,?!]+|[，。？！,?!]+$/gu, "");
  if (!cleaned) return `${anchorName}写过什么吗`;
  // 「写过X」「有没有X」等剩余动词结构保持动词，只补人物主语。
  return `${anchorName}${cleaned.startsWith("写过") || cleaned.startsWith("作过") || cleaned.startsWith("创作") ? "" : "写过"}${cleaned}吗`;
}

/** 开放式作品问句：「他写过什么」「李白有哪些作品」「代表作」。 */
const OPEN_WORKS_PATTERN = /(写过什么|写过哪些|留下过什么|有哪些作品|作品有哪些|有什么作品|什么作品|代表作)/u;

export function isOpenWorksQuestion(transcription, journey) {
  const text = String(transcription ?? "").replace(/\s+/g, "").trim();
  if (!text || text.length > 60 || /《/.test(text)) return false;
  // 含「在」的问句优先走地点流（「李白在嵩山写过什么」不是开放问句）。
  if (/在/.test(text)) return false;
  if (!OPEN_WORKS_PATTERN.test(text)) return false;
  return Boolean(journey?.anchor?.trim()) || personFromOpenQuestion(text) !== null;
}

function personFromOpenQuestion(text) {
  const match = /^([\p{Script=Han}·]{1,8}?)(?=写过什么|写过哪些|留下过什么|有哪些作品|作品有哪些|有什么作品|什么作品|代表作)/u.exec(text);
  const candidate = match?.[1];
  return candidate && isPersonName(candidate) ? candidate : null;
}

/**
 * 开放式作品问句 → 真实作品列表候选（gateway /works）。
 * 有旅程锚点时候选是裸书名（点选后由归一化补全人物）；
 * 无锚点时候选是完整问句（点选后可独立走通证据链）。
 */
export async function resolveWorksOutcome({ transcription, journey, worksResolver = createWorksResolver() }) {
  if (worksResolver.isConfigured === false) return { status: "graph_unconfigured" };
  const text = String(transcription ?? "").trim();
  const anchorName = typeof journey?.anchor === "string" && journey.anchor.trim() ? journey.anchor.trim() : null;
  const person = anchorName ?? personFromOpenQuestion(text.replace(/\s+/g, ""));
  if (!person) return null;
  const resolution = await worksResolver(person);
  if (resolution.kind === "works") {
    const titles = resolution.works.map((work) => work.title).filter((title) => title && title.length <= 24).slice(0, 3);
    if (titles.length === 0) {
      return { status: "ok", outcome: { kind: "gap", transcription: text, gap: `诗文库暂无「${resolution.name}」可展示的作品列表。`, association: null } };
    }
    const candidates = anchorName ? titles : titles.map((title) => `${person}写过《${title}》吗`);
    const count = Number.isFinite(resolution.totalCount) ? resolution.totalCount : titles.length;
    return {
      status: "ok",
      outcome: {
        kind: "ambiguous",
        transcription: text,
        clarification: `「${resolution.name}」名下诗文共 ${count} 首，先从哪一件继续寻迹？`,
        candidates,
      },
    };
  }
  if (resolution.kind === "person_ambiguous") {
    const candidates = resolution.candidates.map((candidate) => candidate?.name).filter((name) => typeof name === "string" && name.length <= 24);
    if (candidates.length >= 2) {
      return { status: "ok", outcome: { kind: "ambiguous", transcription: text, clarification: `诗文库有多位「${person}」，请点选或写明「朝代·姓名」：`, candidates } };
    }
  }
  if (resolution.kind === "evidence_gap") {
    return { status: "ok", outcome: { kind: "gap", transcription: text, gap: (resolution.reason ?? "诗文库没有该人物的记录。").slice(0, 200), association: null } };
  }
  return { status: resolution.kind };
}

/**
 * 起笔人物锚点解析。返回前端 /api/seek 合同的三种形态之一：
 *   {status:"anchor_ready", anchor} | {status:"ok", outcome(ambiguous)} | {status:"graph_*"|"evidence_gap"...}
 */
export async function resolveNotebookAnchor({ transcription, resolveAnchor = createAnchorResolver() }) {
  // anchor 端点未配置时跳过锚点分支（fixture 模式与未配置寻迹由后续链路自行降级）。
  if (resolveAnchor.isConfigured === false) return null;
  const raw = String(transcription ?? "").trim();
  const split = splitDynastyName(raw);
  const person = split ? split.person : raw;
  const dynasty = split ? split.dynasty : null;
  if (!isPersonName(person)) return null;
  const resolution = await resolveAnchor(person, dynasty);
  if (resolution.kind === "person_anchor") {
    const anchor = resolution.anchor;
    return {
      status: "anchor_ready",
      anchor: {
        id: anchor.id,
        name: anchor.name,
        dynasty: anchor.dynasty,
        life: anchor.life,
        aliases: anchor.aliases ?? [],
        titles: anchor.titles ?? [],
        hometown: anchor.hometown ?? null,
        details: (anchor.details ?? []).map((detail) => ({ source: detail.book, section: null, text: detail.text })),
        source: anchor.source ?? [],
      },
    };
  }
  if (resolution.kind === "person_ambiguous") {
    const candidates = resolution.candidates.map((candidate) => candidate.name).filter((name) => typeof name === "string" && name.length <= 24);
    if (candidates.length >= 2) {
      return {
        status: "ok",
        outcome: {
          kind: "ambiguous",
          transcription: raw,
          clarification: `诗文库有多位「${person}」，请点选或写明「朝代·姓名」：`,
          candidates,
        },
      };
    }
  }
  if (resolution.kind === "evidence_gap") {
    return { status: "ok", outcome: { kind: "gap", transcription: raw, gap: resolution.reason, association: null } };
  }
  return { status: resolution.kind };
}

/**
 * Pi 文化联想（/api/narrative）。输出必须以「联想：」开头且不含事实断言；
 * 寻迹结果已在纸上，失败与未配置都显式降级，前端有本地模板兜底。
 */
export async function runNarrative({ journey, evidence, createSession = createPiNotebookSession }) {
  const anchor = String(journey?.anchor ?? "").trim();
  const route = journey?.route;
  if (!anchor || !route) return { status: "narrative_unconfigured" };
  // 联想会话不需要图谱：给一个恒定返回缺口的 retriever，工具面白名单保持不变。
  const narrativeRetrieve = async (query) => ({ kind: "evidence_gap", query, reason: "联想生成不检索图谱。", sources: [] });
  const session = await createSession({ retrieve: narrativeRetrieve });
  if (!session) return { status: "narrative_unconfigured" };
  try {
    const history = (journey.history ?? []).slice(-6).map((entry) => `${entry.path.join("→")}（${entry.evidence}）`);
    const prompt = [
      narrativeSystemPrompt(anchor, route, journey.step ?? 0),
      `已核验证据：${String(evidence?.evidence ?? "")}；路径：${Array.isArray(evidence?.path) ? evidence.path.join("→") : ""}。`,
      history.length > 0 ? `最近线索：${history.join("；")}。` : "",
      "只返回 JSON：{\"association\":\"联想：…\"}，60 字以内，不得出现年代、出处、馆藏或人物关系事实。",
    ].filter(Boolean).join("\n");
    await session.prompt(prompt);
    await session.waitForIdle();
    const raw = [...session.messages].reverse().find((message) => message.role === "assistant")?.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim() ?? "";
    const parsed = (() => {
      try {
        const candidate = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
        const value = JSON.parse(candidate);
        return value && typeof value === "object" ? value : null;
      } catch {
        return null;
      }
    })();
    const association = typeof parsed?.association === "string" ? parsed.association.trim() : "";
    if (association.startsWith("联想：") && association.length <= 120 && !/\d{3,4}\s*年|馆藏|出处|生于|卒于|收录于/u.test(association)) {
      return { status: "narrative_ready", association };
    }
    return { status: "narrative_rejected" };
  } catch {
    return { status: "narrative_unavailable" };
  } finally {
    session.dispose();
  }
}
