import { PointerEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { getDemoCase, isJourneyDemo, makeDemoCandidateOutcome, makeDemoJourneyOutcome, makeDemoOutcome, type TraceOutcome } from "./demo-agent";
import { loadNotebookState, saveNotebookState } from "./notebook-store";
import { PaperReply } from "./modules/paper-reply/PaperReply";
import { ScrollOpening } from "./modules/scroll-opening/ScrollOpening";
import "./styles.css";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    if (import.meta.env.DEV) {
      const resetKey = "shangtu-dev-service-worker-reset";
      void navigator.serviceWorker.getRegistrations().then(async (registrations) => {
        const hadController = Boolean(navigator.serviceWorker.controller);
        await Promise.all(registrations.map((registration) => registration.unregister()));
        if ("caches" in globalThis) {
          const names = await caches.keys();
          await Promise.all(names.filter((name) => name.startsWith("shangtu-notebook-shell-")).map((name) => caches.delete(name)));
        }
        // An unregistered worker can still control the current tab until the
        // next navigation. Reload once so local development cannot keep an
        // old shell or stale event handlers alive indefinitely.
        if (registrations.length > 0 && hadController && sessionStorage.getItem(resetKey) !== "1") {
          sessionStorage.setItem(resetKey, "1");
          window.location.reload();
        }
      });
      return;
    }
    void navigator.serviceWorker.register("/sw.js");
  });
}

type Mode = "quiet" | "seek";
type InkState = "rest" | "awakening" | "reading" | "ready";
type InkImage = { data: string; mimeType: "image/png" };
type InkBounds = { left: number; top: number; right: number; bottom: number };
type TranscriptionProposal = { text: string; candidates: string[]; lines?: Array<{ text: string; box: { x: number; y: number; width: number; height: number } }> };
type PersonAnchor = { id: string; name: string; dynasty: string | null; life: string | null; aliases: string[]; titles: string[]; hometown: string | null; details: Array<{ source: string; section: string | null; text: string }>; source: Array<{ label: string; url: string }> };
type PendingTranscription = { text: string; initialText: string; candidates: string[]; image: InkImage; anchor: InkBounds; isFixture: boolean };
type TranscriptionTiming = { event: "pen_up" | "local_awakening" | "transcription_request" | "transcription_result" | "transcription_confirmed"; elapsedMs: number; status?: string; providerStatus?: string; provider?: string; edited?: boolean };
type PageAnnotation = { id: string; outcome: TraceOutcome; anchor: InkBounds; image: InkImage | null; isCollected: boolean };
type JourneyRoute = "life" | "space" | "work";
type JourneyEntry = { step: number; transcription: string; evidence: string; path: string[]; places?: string[]; timeline?: Array<{ year: number; label: string }>; timeHints?: string[] };
type AnchorSource = { label: string; url: string };
type JourneyState = { personId: string; anchor: string; anchorId: string | null; dynasty: string | null; life: string | null; hometown?: string | null; bio?: string | null; anchorSource?: AnchorSource | null; route: JourneyRoute | null; step: number; nextPrompt: string; visitedNodes: string[]; unresolvedQuestions: string[]; narrative?: string | null; history?: JourneyEntry[] };
type StoredJourneyState = Omit<JourneyState, "personId" | "visitedNodes" | "unresolvedQuestions"> & { personId?: string | null; visitedNodes?: string[]; unresolvedQuestions?: string[] };
type PageRecord = { ink: string | null; inkBounds: InkBounds | null; annotations: PageAnnotation[]; transcription: PendingTranscription | null; journey: JourneyState | null; newPersonRequested: boolean; experimentSample: InkImage | null; experimentTimings: TranscriptionTiming[]; experimentSampleId: string | null };
type StoredPage = { ink: string | null; inkBounds: InkBounds | null; annotations: PageAnnotation[]; transcription: PendingTranscription | null; journey: StoredJourneyState | null; newPersonRequested: boolean };
type StoredNotebook = { schema: "shangtu-notebook-v1"; pageIndex: number; pages: StoredPage[] };

const INK_CAPTURE_PADDING = 56;
const OCR_CAPTURE_MIN_HEIGHT = 256;
// The CPU PaddleOCR service becomes markedly slower on 2K crops. Keep the
// upload bounded while preserving enough resolution for short handwritten
// lines; the original page canvas is still stored at its native resolution.
const OCR_CAPTURE_MAX_DIMENSION = 1_280;
const SEEK_IDLE_DELAY_MS = 800;
// A seek may spend up to 8s in graph retrieval and another 8s in Pi. Keep a
// small transport margin so the browser does not abort a healthy server call.
const CLIENT_REQUEST_TIMEOUT_MS = 20_000;
// This request is optional and runs after evidence is already on paper; the
// extra margin covers a cold Pi runtime without delaying the next stroke.
const NARRATIVE_REQUEST_TIMEOUT_MS = 10_000;
const isTranscriptionExperiment = new URLSearchParams(window.location.search).get("experiment") === "transcription";
const PERSON_ANCHOR_NOTE = "起笔请先确认一位人物：请把人物姓名写入转写框，再继续寻迹。";
const PERSON_SWITCH_NOTE = "换人物：下一笔请写一位人物姓名，再确认转写。";
const ROUTE_SELECTION_NOTE = "人物已经确认；请先点选地点、经历或作品路线，或写下“地点线 / 经历线 / 作品线”，再写下一笔。";

function downloadInkSample(image: InkImage, pageIndex: number, sampleId: string) {
  const encoded = image.data.split(",", 2)[1] ?? "";
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
  const link = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  link.download = `shangtu-ink-${sampleId}-page-${String(pageIndex + 1).padStart(2, "0")}-${stamp}.png`;
  link.href = objectUrl;
  document.body.append(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }, 1000);
}

function downloadTranscriptionTimings(timings: TranscriptionTiming[], pageIndex: number, sampleId: string) {
  const payload = JSON.stringify({ schema: "shangtu-transcription-timing-v1", page: pageIndex + 1, sampleId, timings }, null, 2);
  const objectUrl = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const link = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  link.download = `shangtu-transcription-timing-${sampleId}-page-${String(pageIndex + 1).padStart(2, "0")}-${stamp}.json`;
  link.href = objectUrl;
  document.body.append(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }, 1000);
}

async function postJson(path: string, body: unknown, timeoutMs = CLIENT_REQUEST_TIMEOUT_MS, externalSignal?: AbortSignal) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  externalSignal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json() as { status?: string; transcription?: TranscriptionProposal; providerStatus?: string; provider?: string; outcome?: TraceOutcome; anchor?: PersonAnchor; association?: string };
    if (!response.ok) {
      const status = typeof payload.status === "string" ? payload.status : `http_${response.status}`;
      throw new Error(`api_${status}`);
    }
    if (typeof payload.status !== "string") throw new Error("api_invalid_response");
    return payload as { status: string; transcription?: TranscriptionProposal; providerStatus?: string; provider?: string; outcome?: TraceOutcome; anchor?: PersonAnchor; association?: string };
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abort);
  }
}

function unavailableMessage(status: string, subject: "转写" | "寻迹") {
  if (status === "vision_unconfigured") return "这页笔迹已保留；视觉转写尚未配置，暂不能生成机器转写。";
  if (status === "provider_not_implemented") return "视觉转写服务已预留，但尚未接入；这页笔迹会留在纸上。";
  if (status === "vision_timed_out") return "转写等候过久，已停止本次尝试；这页笔迹仍留在纸上。";
  if (status === "vision_empty") return "这笔没有读出清晰文字；原始笔迹已保留，请手动补写或重写。";
  if (status === "vision_unavailable") return "转写服务暂不可达；这页笔迹已保留。";
  if (status === "model_unconfigured") return "转写已确认；寻迹内核尚未配置，因此没有生成旁批。";
  if (status === "graph_unconfigured") return "转写已确认；证据图谱尚未配置，因此没有生成旁批。";
  if (status === "graph_timed_out") return "证据图谱等候过久，已停止本次寻迹；原始笔迹与确认转写均已保留。";
  if (status === "graph_unavailable") return "证据图谱服务暂不可达；原始笔迹与确认转写均已保留。";
  if (status === "model_timed_out") return "寻迹内核等候过久，已停止本次尝试；原始笔迹与确认转写均已保留。";
  if (status === "model_unavailable") return "寻迹内核暂不可达；原始笔迹与确认转写均已保留。";
  if (status === "needs_transcription") return "请先确认这页的机器转写，再继续寻迹。";
  if (status === "needs_person_anchor") return PERSON_ANCHOR_NOTE;
  if (status === "needs_route_selection") return ROUTE_SELECTION_NOTE;
  if (status === "invalid_ink") return "这页笔迹截图无法识别；请再写一笔后重试。";
  return `${subject}暂时没有完成；原始笔迹已保留。`;
}

function needsManualTranscription(status: string) {
  return ["vision_unconfigured", "provider_not_implemented", "vision_timed_out", "vision_empty", "vision_unavailable"].includes(status);
}

function isInkBounds(value: unknown): value is InkBounds {
  if (!value || typeof value !== "object") return false;
  const bounds = value as Record<string, unknown>;
  return ["left", "top", "right", "bottom"].every((key) => typeof bounds[key] === "number" && (bounds[key] as number) >= 0 && (bounds[key] as number) <= 1) && (bounds.left as number) <= (bounds.right as number) && (bounds.top as number) <= (bounds.bottom as number);
}

function isInkImage(value: unknown): value is InkImage {
  return Boolean(value) && typeof value === "object" && (value as Record<string, unknown>).mimeType === "image/png" && typeof (value as Record<string, unknown>).data === "string";
}

function isJourneyState(value: unknown): value is StoredJourneyState {
  if (!value || typeof value !== "object") return false;
  const journey = value as Record<string, unknown>;
  const history = journey.history;
  const validHistory = history === undefined || (Array.isArray(history) && history.length <= 6 && history.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const item = entry as Record<string, unknown>;
    return typeof item.step === "number" && Number.isInteger(item.step) && item.step >= 0 && typeof item.transcription === "string" && item.transcription.length <= 120 && typeof item.evidence === "string" && item.evidence.length <= 120 && Array.isArray(item.path) && item.path.length >= 3 && item.path.length <= 9 && item.path.every((node) => typeof node === "string" && node.length <= 80) && (item.places === undefined || (Array.isArray(item.places) && item.places.length <= 4 && item.places.every((place) => typeof place === "string" && place.length <= 80))) && (item.timeline === undefined || (Array.isArray(item.timeline) && item.timeline.length <= 4 && item.timeline.every((point) => point && typeof point === "object" && typeof (point as Record<string, unknown>).year === "number" && typeof (point as Record<string, unknown>).label === "string" && ((point as Record<string, unknown>).label as string).length <= 120))) && (item.timeHints === undefined || (Array.isArray(item.timeHints) && item.timeHints.length <= 4 && item.timeHints.every((hint) => typeof hint === "string" && hint.length <= 80)));
  }));
  const source = journey.anchorSource;
  const sourceRecord = source && typeof source === "object" ? source as Record<string, unknown> : null;
  const sourceLabel = sourceRecord?.label;
  const sourceUrl = sourceRecord?.url;
  const validSource = source === undefined || source === null || (Boolean(sourceRecord) && typeof sourceLabel === "string" && sourceLabel.length <= 120 && typeof sourceUrl === "string" && sourceUrl.length <= 500);
  const validPersonId = journey.personId === undefined || journey.personId === null || (typeof journey.personId === "string" && journey.personId.length <= 120);
  const validVisitedNodes = journey.visitedNodes === undefined || (Array.isArray(journey.visitedNodes) && journey.visitedNodes.length <= 24 && journey.visitedNodes.every((node) => typeof node === "string" && node.length <= 80));
  const validUnresolvedQuestions = journey.unresolvedQuestions === undefined || (Array.isArray(journey.unresolvedQuestions) && journey.unresolvedQuestions.length <= 4 && journey.unresolvedQuestions.every((question) => typeof question === "string" && question.length <= 160));
  return typeof journey.anchor === "string" && (journey.anchorId === undefined || journey.anchorId === null || typeof journey.anchorId === "string") && (journey.dynasty === undefined || journey.dynasty === null || typeof journey.dynasty === "string") && (journey.life === undefined || journey.life === null || typeof journey.life === "string") && (journey.hometown === undefined || journey.hometown === null || (typeof journey.hometown === "string" && journey.hometown.length <= 120)) && (journey.bio === undefined || journey.bio === null || (typeof journey.bio === "string" && journey.bio.length <= 180)) && validSource && validPersonId && validVisitedNodes && validUnresolvedQuestions && (journey.route === null || journey.route === "life" || journey.route === "space" || journey.route === "work") && typeof journey.step === "number" && Number.isInteger(journey.step) && journey.step >= 0 && typeof journey.nextPrompt === "string" && (journey.narrative === undefined || journey.narrative === null || (typeof journey.narrative === "string" && journey.narrative.length <= 120 && journey.narrative.startsWith("联想："))) && validHistory;
}

function classifyJourneyRoute(text: string): JourneyRoute | null {
  if (/(作品|诗|词|赋|文章|诗句|写了|创作|《[^》]+》)/u.test(text)) return "work";
  if (/(地点|哪里|何处|黄州|赤壁|眉山|杭州|密州|徐州|湖州|长安|洛阳|儋州)/u.test(text)) return "space";
  if (/(为什么|为何|事件|转折|被贬|入仕|冲突|经历|一生|晚年|去世)/u.test(text)) return "life";
  return null;
}

function explicitJourneyRouteChoice(value: string): JourneyRoute | null {
  const candidate = value.trim().replace(/[\s，。！？、：；,.!?]/gu, "");
  if (/^(地点|地点线|地点路线|空间线|空间路线|他走过哪里|走过哪里|我想看地点|我想看他的地点|我想知道他去过哪里|我想了解他去过哪里|看地点|看地点线|他的地点|我想从地点开始|从地点开始|沿着地点|沿着他的地点|先看地点|先看地点线|我想看他的地点线)$/u.test(candidate)) return "space";
  if (/^(经历|经历线|经历路线|人生线|人生路线|转折线|人生转折|我想看经历|我想看他的经历|我想知道他的经历|我想了解他的经历|他经历了什么|看经历|看经历线|他的经历|我想从经历开始|从经历开始|沿着经历|沿着他的人生|先看经历|先看经历线|我想看他的人生线)$/u.test(candidate)) return "life";
  if (/^(作品|作品线|作品路线|诗文线|创作线|创作路线|我想看作品|我想看他的作品|我想知道他的作品|我想了解他的作品|看作品|看作品线|他的作品|我想从作品开始|从作品开始|沿着作品|沿着他的作品|先看作品|先看作品线|我想看他的作品线)$/u.test(candidate)) return "work";
  return null;
}

function isPersonAnchorText(value: string) {
  const candidate = value.trim();
  if (!/^[\p{Script=Han}·]{2,8}$/u.test(candidate)) return false;
  // A first stroke should be a name, not a compressed open-ended question.
  // Keep short names such as 和珅 valid, while rejecting common relation and
  // question markers before they reach the anchor resolver.
  if (/(什么|为什么|为何|哪里|关联|写过|作品|地点|经历|怎么样|怎么)/u.test(candidate)) return false;
  if (candidate.length > 4 && /[与和]/u.test(candidate)) return false;
  return true;
}

function anchorFromOutcome(outcome: TraceOutcome): string {
  if (outcome.kind === "evidence" && outcome.path[0]) return outcome.path[0];
  const text = outcome.transcription.trim();
  return text.length > 20 ? text.slice(0, 20) : text;
}

function nextJourneyPrompt(route: JourneyRoute | null, step: number) {
  if (route === "space") {
    if (step === 0) return "下一笔，写下这条人生线的第一个地点。";
    if (step === 1) return "下一笔，再写一个与他有关的地点。";
    if (step === 2) return "下一笔，写下前面地点之间发生了怎样的变化。";
    if (step === 3) return "下一笔，回望这条地点线，写下你想留下的最后一个问题。";
    return "这条地点线已完成起点—转折—回望—收束；可以收纳这页，也可以继续写新的回声。";
  }
  if (route === "work") {
    if (step === 0) return "下一笔，写下他的一件作品或一句诗。";
    if (step === 1) return "下一笔，再写一件作品或一句诗。";
    if (step === 2) return "下一笔，写下这些作品背后的经历。";
    if (step === 3) return "下一笔，回望这条作品线，写下你想留下的最后一个问题。";
    return "这条作品线已完成起点—转折—回望—收束；可以收纳这页，也可以继续写新的回声。";
  }
  if (route === "life") {
    if (step === 0) return "下一笔，写下他人生中的一次转折。";
    if (step === 1) return "下一笔，再写一次改变方向的经历。";
    if (step === 2) return "下一笔，写下这段经历与时代的关系。";
    if (step === 3) return "下一笔，回望这条经历线，写下你想留下的最后一个问题。";
    return "这条经历线已完成起点—转折—回望—收束；可以收纳这页，也可以继续写新的回声。";
  }
  return "先选一条路线，再写第一条线索。";
}

function journeyClueHint(journey: JourneyState) {
  const latest = journey.history?.at(-1)?.places?.[0] ?? journey.history?.at(-1)?.timeHints?.[0] ?? journey.history?.at(-1)?.path.at(-1) ?? null;
  if (journey.route === "space") {
    if (journey.step === 0) return journey.hometown ? `可从「${journey.hometown}」起笔，也可以写一个任职地、贬谪地或游历处。` : "可写一个具体地点名，例如籍贯、任职地、贬谪地或游历处。";
    if (journey.step === 1) return latest ? `再写一个具体地点，例如「${latest}」之后的去处。` : "再写一个具体地点名，不要只写“去了哪里”。";
    if (journey.step === 2) return "可写两个地点之间的迁徙、任职或贬谪变化。";
    if (journey.step === 3) return "可写一个仍未核对的地点或时间词，尽量具体。";
    return "若继续，可写一个新的具体地点；也可以收纳这条地点线。";
  }
  if (journey.route === "work") {
    if (journey.step <= 1) return "可写一件作品的篇名（如《篇名》）或一句诗中的关键词。";
    if (journey.step === 2) return "可写作品背后的经历、写作地点或原文中的时间词。";
    if (journey.step === 3) return "可写一个仍未核对的作品名或创作线索，尽量具体。";
    return "若继续，可写一件新的作品或篇名；也可以收纳这条作品线。";
  }
  if (journey.route === "life") {
    if (journey.step === 0) return "可写一次具体转折：任职、迁徙、贬谪、交游或事件。";
    if (journey.step === 1) return "再写一个具体事件或身份变化，不要只写“生平”。";
    if (journey.step === 2) return "可写一个时代、地点或事件词，把个人经历接到历史背景。";
    if (journey.step === 3) return "可写一个仍未核对的事件或时间词，尽量具体。";
    return "若继续，可写一个新的具体经历或事件；也可以收纳这条经历线。";
  }
  return "尽量写一个具体名词：地点、作品、事件或时间词；不要只写“生平”或“有什么”。";
}

function journeyBeatLabel(route: JourneyRoute | null, step: number) {
  if (!route) return "人物起点";
  if (step <= 1) return `${journeyRouteLabel(route)} · 起点`;
  if (step === 2) return `${journeyRouteLabel(route)} · 转折`;
  if (step === 3) return `${journeyRouteLabel(route)} · 回望`;
  return `${journeyRouteLabel(route)} · 收束`;
}

function firstJourneyPrompt(hometown: string | null) {
  const routeHint = "先选一条路线（也可写‘地点线 / 经历线 / 作品线’）";
  return hometown ? `${routeHint}，再写第一条线索（地点线可从${hometown}起笔）。` : `${routeHint}，再写第一条线索。`;
}

function visitedNodesForJourney(anchor: string, history: JourneyEntry[]) {
  return Array.from(new Set(history.flatMap((entry) => entry.path).filter((node) => node !== anchor))).slice(-24);
}

function normalizeJourneyState(stored: StoredJourneyState): JourneyState {
  const history = stored.history ?? [];
  const nextPrompt = stored.nextPrompt;
  return {
    ...stored,
    personId: stored.personId ?? stored.anchorId ?? stored.anchor,
    anchorId: stored.anchorId ?? stored.personId ?? null,
    visitedNodes: stored.visitedNodes ?? visitedNodesForJourney(stored.anchor, history),
    unresolvedQuestions: stored.unresolvedQuestions ?? [nextPrompt],
    history,
  };
}

function boundedJourneyNarrative(value: string) {
  return value.length <= 120 ? value : `${value.slice(0, 117)}…`;
}

function localJourneyNarrative(outcome: TraceOutcome, route: JourneyRoute | null, step: number, previousCues: string[] = []) {
  if (outcome.kind !== "evidence" || !route) return null;
  const cue = outcome.places?.[0] ?? outcome.path.at(-1) ?? "这条线索";
  const previousCue = previousCues.at(-1);
  if (route === "space") {
    if (step <= 1) return boundedJourneyNarrative(`联想：可以把“${cue}”当作人物行旅的起点，继续观察他如何观看世界。`);
    if (step === 2 && previousCue) return boundedJourneyNarrative(`联想：从“${previousCue}”到“${cue}”，可以把它看作行旅中的转折，追问脚步为何改变方向。`);
    if (step >= 4) return boundedJourneyNarrative(`联想：从“${previousCue ?? "前面地点"}”到“${cue}”，这条地点线可以暂时收束，也留下继续追问的回声。`);
    return boundedJourneyNarrative(`联想：可以回望“${previousCue ?? "前面地点"}”与“${cue}”的回声，感受一条人生线如何展开。`);
  }
  if (route === "work") {
    if (step <= 1) return boundedJourneyNarrative(`联想：可以从“${cue}”听见人物落笔时的语气，再寻找下一件作品。`);
    if (step === 2 && previousCue) return boundedJourneyNarrative(`联想：从“${previousCue}”到“${cue}”，可以把它看作作品线的转折，追问语气如何发生变化。`);
    if (step >= 4) return boundedJourneyNarrative(`联想：从“${previousCue ?? "前面作品"}”到“${cue}”，这条作品线可以暂时收束，也留下继续追问的回声。`);
    return boundedJourneyNarrative(`联想：可以回看“${previousCue ?? "前面作品"}”与“${cue}”的呼应，感受创作如何留下连续的回声。`);
  }
  if (step <= 1) return boundedJourneyNarrative(`联想：可以沿着“${cue}”找到人物选择的起点，再慢慢靠近他的处境。`);
  if (step === 2 && previousCue) return boundedJourneyNarrative(`联想：从“${previousCue}”到“${cue}”，可以把它看作人生线的转折，观察个人选择与时代风向如何交错。`);
  if (step >= 4) return boundedJourneyNarrative(`联想：从“${previousCue ?? "前面经历"}”到“${cue}”，这条经历线可以暂时收束，也留下继续追问的回声。`);
  return boundedJourneyNarrative(`联想：可以回望“${previousCue ?? "前面经历"}”与“${cue}”的关系，让一条人生线显出更长的回声。`);
}

function journeyAfter(outcome: TraceOutcome, previous: JourneyState | null, anchor?: PersonAnchor): JourneyState {
  // Once the user chooses a route, keep every subsequent clue on that thread.
  // Route words inside a clue are content, not an implicit mode switch.
  const route = previous?.route ?? classifyJourneyRoute(outcome.transcription) ?? null;
  // A gap is a prompt to add a better clue, not a completed beat in the
  // narrative. Only a verified evidence path advances 起点 → 转折 → 回望.
  const step = outcome.kind === "evidence" ? (previous?.step ?? 0) + 1 : (previous?.step ?? 0);
  const history = previous?.history ? [...previous.history] : [];
  const previousCues = history.map((entry) => entry.places?.[0] ?? entry.timeHints?.[0] ?? entry.path.at(-1)).filter((cue): cue is string => Boolean(cue));
  if (outcome.kind === "evidence") history.push({ step, transcription: outcome.transcription.slice(0, 120), evidence: outcome.evidence.slice(0, 120), path: outcome.path.slice(0, 9), ...(outcome.places ? { places: outcome.places.slice(0, 4) } : {}), ...(outcome.timeline ? { timeline: outcome.timeline.slice(0, 4) } : {}), ...(outcome.timeHints ? { timeHints: outcome.timeHints.slice(0, 4) } : {}) });
  const boundedHistory = history.slice(-6);
  const personName = anchor?.name ?? previous?.anchor ?? anchorFromOutcome(outcome);
  const nextPrompt = nextJourneyPrompt(route, step);
  return { personId: anchor?.id ?? previous?.personId ?? previous?.anchorId ?? personName, anchor: personName, anchorId: anchor?.id ?? previous?.anchorId ?? previous?.personId ?? null, dynasty: anchor?.dynasty ?? previous?.dynasty ?? null, life: anchor?.life ?? previous?.life ?? null, hometown: anchor?.hometown ?? previous?.hometown ?? null, bio: anchor?.details?.[0]?.text?.slice(0, 180) ?? previous?.bio ?? null, anchorSource: anchor?.source?.[0] ?? previous?.anchorSource ?? null, route, step, nextPrompt, visitedNodes: visitedNodesForJourney(personName, boundedHistory), unresolvedQuestions: [nextPrompt], narrative: outcome.kind === "evidence" && outcome.association === null ? localJourneyNarrative(outcome, route, step, previousCues) : null, history: boundedHistory };
}

function journeyFromAnchor(anchor: PersonAnchor): JourneyState {
  const nextPrompt = firstJourneyPrompt(anchor.hometown);
  return { personId: anchor.id, anchor: anchor.name, anchorId: anchor.id, dynasty: anchor.dynasty, life: anchor.life, hometown: anchor.hometown, bio: anchor.details?.[0]?.text?.slice(0, 180) ?? null, anchorSource: anchor.source[0] ?? null, route: null, step: 0, nextPrompt, visitedNodes: [], unresolvedQuestions: [nextPrompt], narrative: null, history: [] };
}

function demoJourneyAnchor(): PersonAnchor {
  return {
    id: "demo:person:su-shi",
    name: "苏轼",
    dynasty: "北宋",
    life: "1036—1101",
    aliases: ["苏东坡", "东坡"],
    titles: ["东坡居士"],
    hometown: "眉州眉山",
    details: [],
    source: [{ label: "演练固定来源 · 苏轼人物档案", url: "https://zh.wikisource.org/wiki/%E8%98%87%E8%BB%BE" }],
  };
}

function continueJourney(current: JourneyState | null): JourneyState | null {
  if (!current) return null;
  const history = current.history?.map((entry) => ({ ...entry, path: [...entry.path], ...(entry.places ? { places: [...entry.places] } : {}), ...(entry.timeline ? { timeline: entry.timeline.map((point) => ({ ...point })) } : {}), ...(entry.timeHints ? { timeHints: [...entry.timeHints] } : {}) })) ?? [];
  return { ...current, personId: current.personId ?? current.anchorId ?? current.anchor, anchorSource: current.anchorSource ? { ...current.anchorSource } : null, visitedNodes: [...(current.visitedNodes ?? visitedNodesForJourney(current.anchor, history))], unresolvedQuestions: [...(current.unresolvedQuestions ?? [current.nextPrompt])], history, narrative: current.narrative ?? null };
}

function journeyForSeek(current: JourneyState | null, newPersonRequested: boolean) {
  // An explicit person replacement starts a fresh anchor-resolution request;
  // carrying the old route would make an ambiguous new name look like an
  // unselected route and suppress the candidate clarification.
  if (!current || newPersonRequested) return undefined;
  return { anchor: current.anchor, anchorId: current.anchorId, route: current.route };
}

function journeyRouteLabel(route: JourneyRoute | null) {
  if (route === "space") return "地点线";
  if (route === "work") return "作品线";
  if (route === "life") return "经历线";
  return "待展开";
}

function JourneyBeatProgress({ step }: { step: number }) {
  const beats = ["起点", "转折", "回望", "收束"];
  return <ol className="journey-beats" aria-label="人物路线节拍">{beats.map((beat, index) => {
    const beatStep = index + 1;
    const state = step >= beatStep ? "done" : step === index ? "current" : "pending";
    return <li key={beat} className={`journey-beat-${state}`}><span>{beatStep}</span><small>{beat}</small></li>;
  })}</ol>;
}

function journeyThreadSummary(journey: JourneyState) {
  const cues = journey.history
    ?.map((entry) => {
      const temporal = entry.timeline?.[0]?.year ? `${entry.timeline[0].year}年` : entry.timeHints?.[0];
      const spatial = entry.places?.[0];
      return [spatial, temporal].filter(Boolean).join(" · ") || entry.path.at(-1);
    })
    .filter((cue): cue is string => Boolean(cue));
  return cues && cues.length > 0 ? `线索：${cues.join(" → ")}` : null;
}

function journeyRitual(journey: JourneyState) {
  const latest = journey.history?.at(-1);
  if (!journey.route || !latest) return null;
  return {
    position: `你现在进入了「${journey.anchor}」的${journeyRouteLabel(journey.route)}。`,
    evidence: `据：${latest.evidence}`,
    connection: latest.path.join(" → "),
    invitation: journey.nextPrompt,
  };
}

function isTraceOutcome(value: unknown): value is TraceOutcome {
  if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>).transcription !== "string") return false;
  const outcome = value as Record<string, unknown>;
  if (outcome.kind === "evidence") return typeof outcome.evidence === "string" && (outcome.association === null || typeof outcome.association === "string") && Array.isArray(outcome.path) && outcome.path.every((node) => typeof node === "string") && Array.isArray(outcome.source) && outcome.source.every((source) => source && typeof source === "object" && typeof (source as Record<string, unknown>).label === "string" && typeof (source as Record<string, unknown>).url === "string") && (outcome.places === undefined || (Array.isArray(outcome.places) && outcome.places.every((place) => typeof place === "string"))) && (outcome.timeline === undefined || (Array.isArray(outcome.timeline) && outcome.timeline.every((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).year === "number" && typeof (item as Record<string, unknown>).label === "string"))) && (outcome.timeHints === undefined || (Array.isArray(outcome.timeHints) && outcome.timeHints.length <= 4 && outcome.timeHints.every((hint) => typeof hint === "string" && hint.length <= 80)));
  if (outcome.kind === "ambiguous") return typeof outcome.clarification === "string" && Array.isArray(outcome.candidates) && outcome.candidates.every((candidate) => typeof candidate === "string");
  return outcome.kind === "gap" && typeof outcome.gap === "string" && (outcome.association === null || typeof outcome.association === "string");
}

function isStoredNotebook(value: unknown): value is StoredNotebook {
  if (!value || typeof value !== "object") return false;
  const notebook = value as Record<string, unknown>;
  const pageIndex = notebook.pageIndex;
  const pages = notebook.pages;
  if (notebook.schema !== "shangtu-notebook-v1" || typeof pageIndex !== "number" || !Number.isInteger(pageIndex) || !Array.isArray(pages) || pages.length === 0 || pageIndex < 0 || pageIndex >= pages.length) return false;
  return pages.every((page) => {
    if (!page || typeof page !== "object") return false;
    const entry = page as Record<string, unknown>;
    const validInk = entry.ink === null || typeof entry.ink === "string";
    const validBounds = entry.inkBounds === null || isInkBounds(entry.inkBounds);
    const validAnnotations = Array.isArray(entry.annotations) && entry.annotations.every((annotation) => annotation && typeof annotation === "object" && typeof (annotation as Record<string, unknown>).id === "string" && isTraceOutcome((annotation as Record<string, unknown>).outcome) && isInkBounds((annotation as Record<string, unknown>).anchor) && ((annotation as Record<string, unknown>).image === undefined || (annotation as Record<string, unknown>).image === null || isInkImage((annotation as Record<string, unknown>).image)) && typeof (annotation as Record<string, unknown>).isCollected === "boolean");
    const transcription = entry.transcription;
    const transcriptionEntry = transcription && typeof transcription === "object" ? transcription as Record<string, unknown> : null;
    const validTranscription = transcription === null || Boolean(transcriptionEntry && typeof transcriptionEntry.text === "string" && typeof transcriptionEntry.initialText === "string" && Array.isArray(transcriptionEntry.candidates) && transcriptionEntry.candidates.every((candidate) => typeof candidate === "string") && isInkImage(transcriptionEntry.image) && isInkBounds(transcriptionEntry.anchor) && typeof transcriptionEntry.isFixture === "boolean");
    const journey = entry.journey;
    const validJourney = journey === undefined || journey === null || isJourneyState(journey);
    const newPersonRequested = entry.newPersonRequested;
    const validNewPersonRequested = newPersonRequested === undefined || typeof newPersonRequested === "boolean";
    return validInk && validBounds && validAnnotations && validTranscription && validJourney && validNewPersonRequested;
  });
}

function Notebook() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const hasInkRef = useRef(false);
  const inkBoundsRef = useRef<InkBounds | null>(null);
  const activeInkBoundsRef = useRef<InkBounds | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const resultTimerRef = useRef<number | null>(null);
  const [mode, setMode] = useState<Mode>("seek");
  const [inkState, setInkState] = useState<InkState>("rest");
  const [hasInk, setHasInk] = useState(false);
  const [annotations, setAnnotations] = useState<PageAnnotation[]>([]);
  const [pendingTranscription, setPendingTranscription] = useState<PendingTranscription | null>(null);
  const [systemNote, setSystemNote] = useState<string | null>(null);
  const [showTraceId, setShowTraceId] = useState<string | null>(null);
  const [pages, setPages] = useState<PageRecord[]>([{ ink: null, inkBounds: null, annotations: [], transcription: null, journey: null, newPersonRequested: false, experimentSample: null, experimentTimings: [], experimentSampleId: null }]);
  const [pageIndex, setPageIndex] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [inkRevision, setInkRevision] = useState(0);
  const [journey, setJourney] = useState<JourneyState | null>(null);
  const [newPersonRequested, setNewPersonRequested] = useState(false);
  const [experimentSample, setExperimentSample] = useState<InkImage | null>(null);
  const [experimentTimings, setExperimentTimings] = useState<TranscriptionTiming[]>([]);
  const [experimentSampleId, setExperimentSampleId] = useState<string | null>(null);
  const penUpAtRef = useRef<number | null>(null);
  const annotationSerialRef = useRef(0);
  const modeRef = useRef<Mode>("seek");
  const transcriptionRequestRef = useRef(0);
  const narrativeRequestRef = useRef(0);
  const networkAbortRef = useRef<AbortController | null>(null);

  const cancelNetworkRequest = () => {
    networkAbortRef.current?.abort();
    networkAbortRef.current = null;
  };

  const beginNetworkRequest = () => {
    cancelNetworkRequest();
    const controller = new AbortController();
    networkAbortRef.current = controller;
    return controller;
  };

  const finishNetworkRequest = (controller: AbortController) => {
    if (networkAbortRef.current === controller) networkAbortRef.current = null;
  };

  const recordTiming = (event: TranscriptionTiming["event"], status?: string, providerStatus?: string, provider?: string, edited?: boolean) => {
    if (!isTranscriptionExperiment || penUpAtRef.current === null) return;
    const timing = { event, elapsedMs: Math.round(performance.now() - penUpAtRef.current), ...(status ? { status } : {}), ...(providerStatus ? { providerStatus } : {}), ...(provider ? { provider } : {}), ...(edited !== undefined ? { edited } : {}) } satisfies TranscriptionTiming;
    setExperimentTimings((current) => [...current, timing]);
  };

  const rememberPage = () => {
    const ink = hasInkRef.current ? canvasRef.current?.toDataURL() ?? null : null;
    setPages((current) => current.map((page, index) => index === pageIndex ? { ink, inkBounds: inkBoundsRef.current, annotations, transcription: pendingTranscription, journey, newPersonRequested, experimentSample, experimentTimings, experimentSampleId } : page));
  };

  const appendAnnotation = (nextOutcome: TraceOutcome, anchor: InkBounds, image: InkImage | null, personAnchor?: PersonAnchor) => {
    const id = `annotation-${++annotationSerialRef.current}`;
    setAnnotations((current) => [...current, { id, outcome: nextOutcome, anchor, image, isCollected: false }]);
    if (nextOutcome.kind !== "ambiguous") setJourney((current) => journeyAfter(nextOutcome, current, personAnchor));
    setShowTraceId(null);
  };

  const requestNarrative = async (outcome: TraceOutcome, nextJourney: JourneyState | null) => {
    // The first verified beat gets an immediate local association. Wait until
    // two beats exist before spending a model call on a meaningful thread.
    if (outcome.kind !== "evidence" || !nextJourney?.route || (nextJourney.history?.length ?? 0) < 2) return;
    const requestId = ++narrativeRequestRef.current;
    const controller = beginNetworkRequest();
    try {
      const result = await postJson("/api/narrative", {
        journey: { personId: nextJourney.personId, anchor: nextJourney.anchor, anchorId: nextJourney.anchorId, route: nextJourney.route, visitedNodes: nextJourney.visitedNodes.slice(-24), unresolvedQuestions: nextJourney.unresolvedQuestions.slice(0, 4), history: nextJourney.history?.slice(-6) ?? [] },
        evidence: { kind: outcome.kind, evidence: outcome.evidence, path: outcome.path, ...(outcome.places ? { places: outcome.places } : {}), ...(outcome.timeline ? { timeline: outcome.timeline } : {}), ...(outcome.timeHints ? { timeHints: outcome.timeHints } : {}) },
      }, NARRATIVE_REQUEST_TIMEOUT_MS, controller.signal);
      if (requestId !== narrativeRequestRef.current || modeRef.current !== "seek") return;
      if (result.status === "narrative_ready" && result.association) setJourney((current) => current && current.anchor === nextJourney.anchor ? { ...current, narrative: result.association } : current);
    } catch {
      // The evidence is already on paper; an unavailable optional association is silent.
    } finally {
      finishNetworkRequest(controller);
    }
  };

  const chooseJourneyRoute = (route: JourneyRoute) => {
    if (!journey || journey.route !== null) return;
    narrativeRequestRef.current += 1;
    setNewPersonRequested(false);
    setJourney((current) => {
      if (!current) return current;
      const nextPrompt = nextJourneyPrompt(route, current.step);
      return { ...current, route, nextPrompt, unresolvedQuestions: [nextPrompt], narrative: null };
    });
    setSystemNote(null);
  };

  const requestNewPerson = () => {
    if (!journey) return;
    narrativeRequestRef.current += 1;
    setNewPersonRequested(true);
    setSystemNote(PERSON_SWITCH_NOTE);
  };

  const cancelNewPerson = () => {
    setNewPersonRequested(false);
    setSystemNote(null);
  };

  const collectJourney = () => {
    setAnnotations((current) => current.map((annotation) => annotation.outcome.kind === "evidence" && annotation.outcome.path[0] === journey?.anchor ? { ...annotation, isCollected: true } : annotation));
  };

  const restoreInk = (ink: string | null) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!ink) return;
    const image = new Image();
    image.onload = () => {
      const rect = canvas.getBoundingClientRect();
      context.drawImage(image, 0, 0, rect.width, rect.height);
    };
    image.src = ink;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const snapshot = hasInkRef.current ? canvas.toDataURL() : null;
      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * scale);
      canvas.height = Math.round(rect.height * scale);
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.lineCap = "round";
      context.lineJoin = "round";
      context.strokeStyle = "#25221d";
      context.lineWidth = 3;
      if (snapshot) {
        const image = new Image();
        image.onload = () => context.drawImage(image, 0, 0, rect.width, rect.height);
        image.src = snapshot;
      }
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => () => {
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    if (resultTimerRef.current) window.clearTimeout(resultTimerRef.current);
    cancelNetworkRequest();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadNotebookState<unknown>().then((stored) => {
      if (cancelled || !isStoredNotebook(stored)) return;
      const restoredPages: PageRecord[] = stored.pages.map((page) => ({ ...page, newPersonRequested: page.newPersonRequested ?? false, annotations: page.annotations.map((annotation) => ({ ...annotation, image: annotation.image ?? null })), journey: page.journey ? normalizeJourneyState(page.journey) : null, experimentSample: null, experimentTimings: [], experimentSampleId: null }));
      const restoredIndex = Math.min(stored.pageIndex, restoredPages.length - 1);
      const current = restoredPages[restoredIndex];
      annotationSerialRef.current = restoredPages.flatMap((page) => page.annotations).reduce((largest, annotation) => Math.max(largest, Number(annotation.id.replace("annotation-", "")) || 0), 0);
      setPages(restoredPages);
      setPageIndex(restoredIndex);
      hasInkRef.current = Boolean(current.ink);
      inkBoundsRef.current = current.inkBounds;
      activeInkBoundsRef.current = null;
      setHasInk(Boolean(current.ink));
      setAnnotations(current.annotations);
      setPendingTranscription(current.transcription);
      setJourney(current.journey ?? null);
      setNewPersonRequested(Boolean(current.newPersonRequested));
      setInkState(current.annotations.length > 0 ? "ready" : "rest");
      restoreInk(current.ink);
    }).finally(() => {
      if (!cancelled) setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const ink = hasInkRef.current ? canvasRef.current?.toDataURL() ?? null : null;
    setPages((current) => current.map((page, index) => index === pageIndex
      ? { ...page, ink, inkBounds: inkBoundsRef.current, annotations, transcription: pendingTranscription, journey, newPersonRequested, experimentSample, experimentTimings, experimentSampleId }
      : page));
  }, [hydrated, pageIndex, annotations, pendingTranscription, journey, newPersonRequested, experimentSample, experimentTimings, experimentSampleId, inkRevision]);

  useEffect(() => {
    if (!hydrated) return;
    const snapshot: StoredNotebook = {
      schema: "shangtu-notebook-v1",
      pageIndex,
      pages: pages.map(({ ink, inkBounds, annotations, transcription, journey: pageJourney, newPersonRequested: pageNewPersonRequested }) => ({ ink, inkBounds, annotations, transcription, journey: pageJourney, newPersonRequested: pageNewPersonRequested })),
    };
    void saveNotebookState(snapshot);
    }, [hydrated, pageIndex, pages]);

  const pointFor = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const makeDot = (canvas: HTMLCanvasElement, point: { x: number; y: number }) => {
    const context = canvas.getContext("2d");
    if (!context) return;
    context.beginPath();
    context.arc(point.x, point.y, 1.5, 0, Math.PI * 2);
    context.fillStyle = "#25221d";
    context.fill();
  };

  const includeInInkBounds = (canvas: HTMLCanvasElement, point: { x: number; y: number }) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = point.x / rect.width;
    const y = point.y / rect.height;
    const include = (bounds: InkBounds | null) => bounds
      ? { left: Math.min(bounds.left, x), top: Math.min(bounds.top, y), right: Math.max(bounds.right, x), bottom: Math.max(bounds.bottom, y) }
      : { left: x, top: y, right: x, bottom: y };
    inkBoundsRef.current = include(inkBoundsRef.current);
    activeInkBoundsRef.current = include(activeInkBoundsRef.current);
  };

  const begin = (event: PointerEvent<HTMLCanvasElement>) => {
    cancelNetworkRequest();
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    transcriptionRequestRef.current += 1;
    narrativeRequestRef.current += 1;
    const continuingSegment = idleTimerRef.current !== null && activeInkBoundsRef.current !== null;
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = null;
    if (!continuingSegment) activeInkBoundsRef.current = null;
    const point = pointFor(event);
    lastPointRef.current = point;
    makeDot(event.currentTarget, point);
    includeInInkBounds(event.currentTarget, point);
    hasInkRef.current = true;
    setHasInk(true);
    if (resultTimerRef.current) window.clearTimeout(resultTimerRef.current);
    setInkState("rest");
    setPendingTranscription(null);
    setExperimentSample(null);
    setExperimentTimings([]);
    setExperimentSampleId(null);
    penUpAtRef.current = null;
    setSystemNote(null);
    setShowTraceId(null);
  };

  const draw = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !lastPointRef.current) return;
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    const next = pointFor(event);
    context.beginPath();
    context.moveTo(lastPointRef.current.x, lastPointRef.current.y);
    context.lineTo(next.x, next.y);
    context.stroke();
    includeInInkBounds(event.currentTarget, next);
    lastPointRef.current = next;
  };

  const captureInk = (bounds: InkBounds | null): InkImage | null => {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !hasInkRef.current || !bounds || !rect?.width || !rect.height) return null;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const left = Math.max(0, Math.floor(bounds.left * canvas.width - INK_CAPTURE_PADDING * scaleX));
    const top = Math.max(0, Math.floor(bounds.top * canvas.height - INK_CAPTURE_PADDING * scaleY));
    const right = Math.min(canvas.width, Math.ceil(bounds.right * canvas.width + INK_CAPTURE_PADDING * scaleX));
    const bottom = Math.min(canvas.height, Math.ceil(bounds.bottom * canvas.height + INK_CAPTURE_PADDING * scaleY));
    const sourceWidth = Math.max(1, right - left);
    const sourceHeight = Math.max(1, bottom - top);
    const outputScale = Math.min(
      OCR_CAPTURE_MAX_DIMENSION / sourceWidth,
      OCR_CAPTURE_MAX_DIMENSION / sourceHeight,
      Math.max(1, OCR_CAPTURE_MIN_HEIGHT / sourceHeight),
    );
    const crop = document.createElement("canvas");
    crop.width = Math.max(1, Math.round(sourceWidth * outputScale));
    crop.height = Math.max(1, Math.round(sourceHeight * outputScale));
    const context = crop.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, crop.width, crop.height);
    context.drawImage(canvas, left, top, sourceWidth, sourceHeight, 0, 0, crop.width, crop.height);
    return { data: crop.toDataURL("image/png"), mimeType: "image/png" };
  };

  const requestTranscription = async (image: InkImage, anchor: InkBounds) => {
    const requestId = ++transcriptionRequestRef.current;
    const controller = beginNetworkRequest();
    recordTiming("transcription_request");
    try {
      const result = await postJson("/api/transcribe", { image }, CLIENT_REQUEST_TIMEOUT_MS, controller.signal);
      if (requestId !== transcriptionRequestRef.current || modeRef.current !== "seek") return;
      recordTiming("transcription_result", result.status, result.providerStatus, result.provider);
      if (result.status === "ok" && result.transcription?.text) {
        setPendingTranscription({ image, anchor, text: result.transcription.text, initialText: result.transcription.text, candidates: result.transcription.candidates ?? [], isFixture: result.providerStatus === "fixture" });
      } else if (result.status === "ok" || needsManualTranscription(result.status)) {
        setPendingTranscription({ image, anchor, text: "", initialText: "", candidates: [], isFixture: false });
      } else {
        setSystemNote(unavailableMessage(result.status, "转写"));
      }
    } catch {
      if (requestId === transcriptionRequestRef.current && modeRef.current === "seek") {
        recordTiming("transcription_result", "network_error", "unavailable");
        setPendingTranscription({ image, anchor, text: "", initialText: "", candidates: [], isFixture: false });
      }
    } finally {
      finishNetworkRequest(controller);
      if (requestId === transcriptionRequestRef.current && modeRef.current === "seek") setInkState("ready");
    }
  };

  const retryTranscription = () => {
    if (!pendingTranscription || inkState !== "ready") return;
    setSystemNote(null);
    setInkState("awakening");
    void requestTranscription(pendingTranscription.image, pendingTranscription.anchor);
  };

  const confirmTranscription = async () => {
    if (modeRef.current !== "seek" || inkState === "reading" || !pendingTranscription?.text.trim()) return;
    if (journey && journey.route === null && !newPersonRequested) {
      const routeChoice = explicitJourneyRouteChoice(pendingTranscription.text);
      if (routeChoice) {
        chooseJourneyRoute(routeChoice);
        setPendingTranscription(null);
        setInkState("ready");
        setSystemNote(`已沿纸面选择「${journeyRouteLabel(routeChoice)}」路线；下一笔再写具体线索。`);
        return;
      }
    }
    if (journey && newPersonRequested && !isJourneyDemo() && !getDemoCase() && !isPersonAnchorText(pendingTranscription.text)) {
      setSystemNote(PERSON_ANCHOR_NOTE);
      setInkState("ready");
      return;
    }
    if (journey && journey.route === null && !isJourneyDemo() && !getDemoCase() && !isPersonAnchorText(pendingTranscription.text)) {
      setSystemNote(ROUTE_SELECTION_NOTE);
      setInkState("ready");
      return;
    }
    if (!journey && !isJourneyDemo() && !getDemoCase() && !isPersonAnchorText(pendingTranscription.text)) {
      setSystemNote(PERSON_ANCHOR_NOTE);
      setInkState("ready");
      return;
    }
    const requestId = ++transcriptionRequestRef.current;
    const controller = beginNetworkRequest();
    recordTiming("transcription_confirmed", undefined, undefined, undefined, pendingTranscription.text !== pendingTranscription.initialText);
    setInkState("reading");
    setSystemNote(null);
    try {
      const result = await postJson("/api/seek", { transcription: pendingTranscription.text, image: pendingTranscription.image, journey: journeyForSeek(journey, newPersonRequested) }, CLIENT_REQUEST_TIMEOUT_MS, controller.signal);
      if (requestId !== transcriptionRequestRef.current || modeRef.current !== "seek") return;
      if (result.status === "anchor_ready" && result.anchor) {
        setJourney(journeyFromAnchor(result.anchor));
        setNewPersonRequested(false);
        setPendingTranscription(null);
      } else if (result.status === "ok" && result.outcome) {
        const nextJourney = journeyAfter(result.outcome, journey, result.anchor);
        appendAnnotation(result.outcome, pendingTranscription.anchor, pendingTranscription.image, result.anchor);
        void requestNarrative(result.outcome, nextJourney);
        setPendingTranscription(null);
      } else {
        setSystemNote(unavailableMessage(result.status, "寻迹"));
      }
    } catch {
      if (requestId === transcriptionRequestRef.current && modeRef.current === "seek") setSystemNote("寻迹服务暂不可达；原始笔迹与确认转写均已保留。");
    } finally {
      finishNetworkRequest(controller);
      if (requestId === transcriptionRequestRef.current && modeRef.current === "seek") setInkState("ready");
    }
  };

  const chooseCandidate = async (annotationId: string, candidate: string) => {
    if (modeRef.current !== "seek" || inkState === "reading") return;
    const annotation = annotations.find((item) => item.id === annotationId);
    if (!annotation || annotation.outcome.kind !== "ambiguous") return;
    if (!annotation.image) {
      const nextOutcome = getDemoCase() === "ambiguous" ? makeDemoCandidateOutcome(candidate) : { ...annotation.outcome, transcription: candidate };
      setAnnotations((current) => current.map((item) => item.id === annotationId && item.outcome.kind === "ambiguous" ? { ...item, outcome: nextOutcome } : item));
      if (nextOutcome.kind !== "ambiguous") {
        const selectedAnchor = getDemoCase() === "ambiguous" && candidate === "苏轼" ? demoJourneyAnchor() : undefined;
        setJourney((current) => journeyAfter(nextOutcome, current, selectedAnchor));
      }
      return;
    }
    setInkState("reading");
    const requestId = ++transcriptionRequestRef.current;
    const controller = beginNetworkRequest();
    setSystemNote(null);
    try {
      const result = await postJson("/api/seek", { transcription: candidate, image: annotation.image, journey: journeyForSeek(journey, newPersonRequested) }, CLIENT_REQUEST_TIMEOUT_MS, controller.signal);
      if (requestId !== transcriptionRequestRef.current || modeRef.current !== "seek") return;
      if (result.status === "anchor_ready" && result.anchor) {
        setAnnotations((current) => current.filter((item) => item.id !== annotationId));
        setJourney(journeyFromAnchor(result.anchor));
        setNewPersonRequested(false);
      } else if (result.status === "ok" && result.outcome) {
        const nextJourney = result.outcome.kind === "ambiguous" ? journey : journeyAfter(result.outcome, journey, result.anchor);
        setAnnotations((current) => current.map((item) => item.id === annotationId ? { ...item, outcome: result.outcome! } : item));
        if (result.outcome.kind !== "ambiguous") {
          setJourney(nextJourney);
          void requestNarrative(result.outcome, nextJourney);
        }
      } else {
        setSystemNote(unavailableMessage(result.status, "寻迹"));
      }
    } catch {
      if (requestId === transcriptionRequestRef.current && modeRef.current === "seek") setSystemNote("寻迹服务暂不可达；原始笔迹与确认转写均已保留。");
    } finally {
      finishNetworkRequest(controller);
      if (requestId === transcriptionRequestRef.current && modeRef.current === "seek") setInkState("ready");
    }
  };

  const beginSeeking = () => {
    if (modeRef.current !== "seek") return;
    recordTiming("local_awakening");
    setInkState("awakening");
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      setInkState("reading");
    }, 460);
    const anchor = activeInkBoundsRef.current;
    if (!anchor) {
      setInkState("ready");
      setSystemNote("这页还没有可供转写的笔迹。");
      return;
    }
    activeInkBoundsRef.current = null;
    const demoCase = getDemoCase();
    if (isJourneyDemo()) {
      resultTimerRef.current = window.setTimeout(() => {
        if (!journey) {
          setJourney(journeyFromAnchor(demoJourneyAnchor()));
        } else if (!journey.route) {
          setSystemNote(ROUTE_SELECTION_NOTE);
        } else {
          appendAnnotation(makeDemoJourneyOutcome(journey.route), anchor, null);
        }
        setInkState("ready");
      }, 1150);
      return;
    }
    if (demoCase) {
      resultTimerRef.current = window.setTimeout(() => {
        appendAnnotation(makeDemoOutcome(demoCase), anchor, null);
        setInkState("ready");
      }, 1150);
      return;
    }
    const image = captureInk(anchor);
    if (!image) {
      setInkState("ready");
      setSystemNote("这页还没有可供转写的笔迹。");
      return;
    }
    if (isTranscriptionExperiment) {
      setExperimentSample(image);
      setExperimentSampleId((current) => current ?? crypto.randomUUID().replace(/-/g, "").slice(0, 12));
    }
    // Keep the local awakening legible before any service response can replace it.
    resultTimerRef.current = window.setTimeout(() => void requestTranscription(image, anchor), 480);
  };

  const retrySeeking = () => {
    // A failed confirmed seek still keeps the editable transcription. Retry that
    // exact request instead of forcing another OCR pass over the same ink.
    if (pendingTranscription?.text.trim()) {
      void confirmTranscription();
      return;
    }
    if (!hasInkRef.current || !inkBoundsRef.current) return;
    activeInkBoundsRef.current = inkBoundsRef.current;
    setSystemNote(null);
    beginSeeking();
  };

  const finish = () => {
    drawingRef.current = false;
    lastPointRef.current = null;
    setInkRevision((current) => current + 1);
    if (modeRef.current === "seek" && hasInkRef.current && isTranscriptionExperiment) {
      penUpAtRef.current = performance.now();
      setExperimentTimings([]);
      setExperimentTimings([{ event: "pen_up", elapsedMs: 0 }]);
    }
    if (modeRef.current === "seek" && hasInkRef.current) {
      // No network work occurs before this local response is visible.
      idleTimerRef.current = window.setTimeout(() => {
        idleTimerRef.current = null;
        beginSeeking();
      }, SEEK_IDLE_DELAY_MS);
    }
  };

  const newPage = () => {
    cancelNetworkRequest();
    transcriptionRequestRef.current += 1;
    narrativeRequestRef.current += 1;
    const inheritedJourney = continueJourney(journey);
    rememberPage();
    setPages((current) => [...current, { ink: null, inkBounds: null, annotations: [], transcription: null, journey: inheritedJourney, newPersonRequested: false, experimentSample: null, experimentTimings: [], experimentSampleId: null }]);
    setPageIndex((current) => current + 1);
    restoreInk(null);
    hasInkRef.current = false;
    inkBoundsRef.current = null;
    activeInkBoundsRef.current = null;
    setHasInk(false);
    setInkState("rest");
    setAnnotations([]);
    setPendingTranscription(null);
    setJourney(inheritedJourney);
    setNewPersonRequested(false);
    setExperimentSample(null);
    setExperimentTimings([]);
    setExperimentSampleId(null);
    penUpAtRef.current = null;
    setSystemNote(null);
    setShowTraceId(null);
  };

  const turnPage = (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= pages.length || nextIndex === pageIndex) return;
    cancelNetworkRequest();
    transcriptionRequestRef.current += 1;
    narrativeRequestRef.current += 1;
    rememberPage();
    const next = pages[nextIndex];
    hasInkRef.current = Boolean(next.ink);
    inkBoundsRef.current = next.inkBounds;
    activeInkBoundsRef.current = null;
    setHasInk(Boolean(next.ink));
    setAnnotations(next.annotations);
    setPendingTranscription(next.transcription);
    setJourney(next.journey ?? null);
    setNewPersonRequested(Boolean(next.newPersonRequested));
    setExperimentSample(next.experimentSample);
    setExperimentTimings(next.experimentTimings);
    setExperimentSampleId(next.experimentSampleId);
    penUpAtRef.current = null;
    setSystemNote(null);
    setShowTraceId(null);
    setInkState(next.annotations.length > 0 ? "ready" : "rest");
    setPageIndex(nextIndex);
    restoreInk(next.ink);
  };

  const clearCurrentPage = () => {
    if (!window.confirm("清空当前页？本页笔迹、转写和旁批会被移除，其他页面不会改变。")) return;
    cancelNetworkRequest();
    transcriptionRequestRef.current += 1;
    narrativeRequestRef.current += 1;
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    if (resultTimerRef.current) window.clearTimeout(resultTimerRef.current);
    idleTimerRef.current = null;
    resultTimerRef.current = null;
    const blankPage: PageRecord = { ink: null, inkBounds: null, annotations: [], transcription: null, journey: null, newPersonRequested: false, experimentSample: null, experimentTimings: [], experimentSampleId: null };
    setPages((current) => current.map((page, index) => index === pageIndex ? blankPage : page));
    restoreInk(null);
    hasInkRef.current = false;
    inkBoundsRef.current = null;
    activeInkBoundsRef.current = null;
    setHasInk(false);
    setInkState("rest");
    setAnnotations([]);
    setPendingTranscription(null);
    setJourney(null);
    setNewPersonRequested(false);
    setExperimentSample(null);
    setExperimentTimings([]);
    setExperimentSampleId(null);
    penUpAtRef.current = null;
    setSystemNote(null);
    setShowTraceId(null);
  };

  const toggleMode = () => {
    const nextMode = modeRef.current === "seek" ? "quiet" : "seek";
    cancelNetworkRequest();
    modeRef.current = nextMode;
    if (nextMode === "quiet") {
      transcriptionRequestRef.current += 1;
      narrativeRequestRef.current += 1;
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      if (resultTimerRef.current) window.clearTimeout(resultTimerRef.current);
      idleTimerRef.current = null;
      resultTimerRef.current = null;
      setPendingTranscription(null);
      setSystemNote(null);
      setNewPersonRequested(false);
      setInkState("ready");
    }
    setMode(nextMode);
  };

  const prompt = mode === "seek"
    ? newPersonRequested
      ? "换人物：写下下一位人物的姓名。"
      : journey
      ? `沿着${journey.anchor}继续写：${journey.nextPrompt}`
      : "起笔：写下一个你想追寻的人物。"
    : "静读中：这页只记录你的笔迹。";
  const journeyEvidenceAnnotations = journey ? annotations.filter((annotation) => annotation.outcome.kind === "evidence" && annotation.outcome.path[0] === journey.anchor) : [];
  const hasUncollectedJourneyEvidence = journeyEvidenceAnnotations.some((annotation) => !annotation.isCollected);
  const allJourneyEvidenceCollected = journeyEvidenceAnnotations.length > 0 && journeyEvidenceAnnotations.every((annotation) => annotation.isCollected);
  const ritual = journey ? journeyRitual(journey) : null;

  return <>
    <ScrollOpening />
    <main className="book-shell">
      <header className="book-spine">
        <div className="brand-lockup">
          <div className="title-mark">时空探索手札</div>
          <small>以笔为舟，沿史寻迹</small>
        </div>
        <div className="mode-control">
          <span>阅读方式</span>
          <button className="mode-toggle" onClick={toggleMode} aria-pressed={mode === "seek"}>
            <i aria-hidden="true" />
            {mode === "seek" ? "寻迹" : "静读"}
          </button>
        </div>
      </header>
      <div className="paper-stage">
      <section className={`paper paper-mode-${mode} ink-${inkState}`} aria-label="可书写纸页">
      <div className="paper-grain" />
      <header className="paper-masthead">
        <p className="quiet-note"><span>{mode === "seek" ? "寻迹提示" : "静读提示"}</span>{prompt}</p>
        <div className="page-number"><span>札记</span><strong>{String(pageIndex + 1).padStart(2, "0")}</strong></div>
      </header>
      <div className="writing-field-label" aria-hidden="true"><span>WRITING FIELD</span>纸上留白</div>
      {mode === "seek" && !hasInk && !pendingTranscription && annotations.length === 0 && <aside className="first-trace" aria-label="起笔提示"><span>起笔</span><p>写下一个你想追寻的人物。</p><em>试写：苏轼　白居易　李清照</em><small>先定人物，再沿着他的时间、地点与作品继续寻迹。</small></aside>}
      {annotations.some((annotation) => !annotation.isCollected) && <div className="relation-trail" aria-hidden="true"><i /><i /><i /></div>}
      <canvas ref={canvasRef} className="ink-canvas" onPointerDown={begin} onPointerMove={draw} onPointerUp={finish} onPointerCancel={finish} />
      {(inkState === "awakening" || inkState === "reading") && <aside className="awakening" aria-live="polite"><span className="ink-orb" />{inkState === "awakening" ? "识字中" : "寻人地 · 核对出处"}</aside>}
      {pendingTranscription && <TranscriptionNote transcription={pendingTranscription} disabled={inkState !== "ready"} onRetry={retryTranscription} onChange={(text) => setPendingTranscription((current) => current ? { ...current, text } : current)} onChoose={(text) => setPendingTranscription((current) => current ? { ...current, text } : current)} onConfirm={confirmTranscription} />}
      {annotations.filter((annotation) => !annotation.isCollected).map((annotation, index) => <PaperReply key={`reply-${annotation.id}`} outcome={annotation.outcome} anchor={annotation.anchor} index={index} />)}
      <aside className="page-note-rail" aria-label="纸页旁批">
        <div className="note-rail-heading"><span>纸上旁批</span><small>MARGINALIA</small></div>
        {!journey && !systemNote && annotations.length === 0 && !experimentSample && <div className="note-rail-empty"><span>候</span><p>{mode === "seek" ? "落笔后，有出处的线索会在这里显现。" : "静读时，纸页只保存你的原始笔迹。"}</p></div>}
        {isTranscriptionExperiment && experimentSample && experimentSampleId && <aside className="experiment-export"><span className="note-seal">样</span><p>样本 {experimentSampleId}；记录只含匿名时间与状态，不含笔迹文字。</p><button onClick={() => downloadInkSample(experimentSample, pageIndex, experimentSampleId)}>下载样本 PNG</button>{experimentTimings.length > 0 && <button onClick={() => downloadTranscriptionTimings(experimentTimings, pageIndex, experimentSampleId)}>下载时延 JSON</button>}</aside>}
        {journey && <aside className="journey-guide" aria-live="polite"><span className="note-seal">续</span><p>你已从「{journey.anchor}」起笔{journey.dynasty ? ` · ${journey.dynasty}` : ""}{journey.life ? ` · ${journey.life}` : ""}{journey.hometown ? ` · 籍贯 ${journey.hometown}` : ""}。</p>{journey.bio && <small className="journey-bio"><span>档案摘录：</span>{journey.bio}</small>}{journey.anchorSource && <a className="journey-source" href={journey.anchorSource.url} target="_blank" rel="noreferrer">人物档案 · {journey.anchorSource.label}</a>}<strong className="journey-route">{journeyBeatLabel(journey.route, journey.step)}</strong>{journey.route && <JourneyBeatProgress step={journey.step} />}{ritual && <dl className="journey-ritual"><dt>定位</dt><dd>{ritual.position}</dd><dt>据</dt><dd>{ritual.evidence}</dd><dt>连接</dt><dd>{ritual.connection}</dd><dt>继续</dt><dd>{ritual.invitation}</dd></dl>}{journey.route && !newPersonRequested && <small className="journey-clue-hint"><span>线索提示：</span>{journeyClueHint(journey)}</small>}{journeyThreadSummary(journey) && <small className="journey-thread-summary">{journeyThreadSummary(journey)}</small>}{journey.route === null && !newPersonRequested && <div className="journey-route-picker" role="group" aria-label="人物路线引导"><strong className="journey-guide-kicker">引导 · 人物已确认</strong><small>下一步请选择一条路线，纸页会告诉你下一笔写什么：</small><div className="journey-route-options"><button type="button" onClick={() => chooseJourneyRoute("space")}><b>地点</b><span>他走过哪里</span></button><button type="button" onClick={() => chooseJourneyRoute("life")}><b>经历</b><span>哪些事改变了他</span></button><button type="button" onClick={() => chooseJourneyRoute("work")}><b>作品</b><span>哪些文字留下回声</span></button></div></div>}{!newPersonRequested && !isJourneyDemo() && !getDemoCase() && <button className="journey-switch" type="button" onClick={requestNewPerson}>换人物</button>}{newPersonRequested && !isJourneyDemo() && !getDemoCase() && <button className="journey-switch" type="button" onClick={cancelNewPerson}>继续当前路线</button>}{journey.history && journey.history.length > 0 && <ol className="journey-thread">{journey.history.map((entry) => <li key={`${entry.step}-${entry.transcription}`}><span>{entry.path[0]} → {entry.path.at(-1)}</span>{entry.timeline && entry.timeline.length > 0 && <small>{entry.timeline.map((point) => point.year).join("、")} · </small>}{entry.timeHints && entry.timeHints.length > 0 && <small>时间词：{entry.timeHints.join("、")} · </small>}{entry.places && entry.places.length > 0 && <small>{entry.places.join("、")}</small>}</li>)}</ol>}{journey.narrative && <small className="journey-association">{journey.narrative}</small>}{journey.step >= 4 && hasUncollectedJourneyEvidence && <button className="journey-collect" type="button" onClick={collectJourney}>收纳这条路线</button>}{journey.step >= 4 && allJourneyEvidenceCollected && <small className="journey-collected-note">这条路线已收纳为印。</small>}{newPersonRequested && <em>请写下一位人物姓名；当前路线暂不接收线索。</em>}{!newPersonRequested && <em>{journey.nextPrompt}</em>}</aside>}
        {systemNote && <aside className="margin-note service-note"><span className="note-seal">记</span><p>{systemNote}</p>{hasInk && systemNote !== PERSON_ANCHOR_NOTE && systemNote !== PERSON_SWITCH_NOTE && systemNote !== ROUTE_SELECTION_NOTE && <button onClick={retrySeeking}>再试一次</button>}</aside>}
        {annotations.map((annotation, index) => <MarginNotes key={annotation.id} annotation={annotation} index={index} showTrace={showTraceId === annotation.id} canSeek={mode === "seek" && inkState !== "reading"} onTrace={() => setShowTraceId((shown) => shown === annotation.id ? null : annotation.id)} onCandidate={(candidate) => void chooseCandidate(annotation.id, candidate)} onCollect={() => setAnnotations((current) => current.map((item) => item.id === annotation.id ? { ...item, isCollected: !item.isCollected } : item))} />)}
      </aside>
      <footer className="page-footer">
        <button className="new-page-mark" onClick={newPage} aria-label={journey ? "续写一页札记" : "新建一页札记"}>{journey ? "续页" : "新页"}</button>
        <nav className="page-turns" aria-label="翻页"><button onClick={() => turnPage(pageIndex - 1)} disabled={pageIndex === 0}>前页</button><span>{pageIndex + 1} / {pages.length}</span><button onClick={() => turnPage(pageIndex + 1)} disabled={pageIndex === pages.length - 1}>后页</button></nav>
        <button className="clear-page-mark" onClick={clearCurrentPage} aria-label="清空当前页">清空</button>
      </footer>
      </section>
      </div>
    </main>
  </>;
}

function MarginNotes({ annotation, index, showTrace, canSeek, onTrace, onCandidate, onCollect }: { annotation: PageAnnotation; index: number; showTrace: boolean; canSeek: boolean; onTrace: () => void; onCandidate: (candidate: string) => void; onCollect: () => void }) {
  const { outcome, anchor, isCollected } = annotation;
  const style = {
    top: `${Math.min(68, Math.max(18, anchor.top * 100 + (index % 2) * 6))}%`,
    ...(anchor.left > 0.58 ? { left: "22px", right: "auto" } : { right: "23px" }),
  };
  if (isCollected) {
    return <button className="annotation-stamp" style={style} onClick={onCollect} aria-label="展开寻迹">寻</button>;
  }
  if (outcome.kind === "ambiguous") {
    return <aside className="margin-note clarification page-annotation" style={style}><span className="note-seal">问</span><p>{outcome.clarification}</p><div className="candidate-row">{outcome.candidates.map((candidate) => <button key={candidate} type="button" disabled={!canSeek} onClick={() => onCandidate(candidate)}>{candidate}</button>)}</div><small>转写：{outcome.transcription}</small><button className="annotation-collect" onClick={onCollect}>收为印</button></aside>;
  }
  if (outcome.kind === "gap") {
    return <aside className="margin-notes page-annotation" style={style}><div className="margin-note gap"><span className="note-seal">缺</span><p>{outcome.gap}</p><small>转写：{outcome.transcription}</small></div>{outcome.association && <div className="margin-note association"><span className="note-seal">联想</span><p>{outcome.association}</p></div>}<button className="annotation-collect" onClick={onCollect}>收为印</button></aside>;
  }
  const hasSecondaryIndex = (outcome.places?.length ?? 0) > 0 || (outcome.timeline?.length ?? 0) > 0 || (outcome.timeHints?.length ?? 0) > 0;
  return <aside className="margin-notes page-annotation" style={style}><div className="margin-note evidence"><button className="evidence-trigger" onClick={onTrace} aria-expanded={showTrace}><span className="note-seal">据</span><p>{outcome.evidence}</p><small>转写：{outcome.transcription}</small><em>点按展开寻迹</em></button>{showTrace && <section className="trace-card"><strong>寻迹卡</strong><p>识别：{outcome.path.join(" → ")}；已核对有界来源。</p>{hasSecondaryIndex && <div className="trace-secondary-index"><b>二级时空索引</b>{outcome.timeline && outcome.timeline.length > 0 && <div className="trace-index-group"><span className="trace-index-label">时间线</span><ol className="trace-timeline">{outcome.timeline.map((item) => <li key={`${item.year}-${item.label}`}><time>{item.year}</time><span>{item.label}</span></li>)}</ol></div>}{outcome.places && outcome.places.length > 0 && <p>地点：{outcome.places.join("、")}</p>}{outcome.timeHints && outcome.timeHints.length > 0 && <p>原文时间词：{outcome.timeHints.join("、")}</p>}</div>}<ol>{outcome.path.map((node) => <li key={node}>{node}</li>)}</ol>{outcome.source.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.label}</a>)}</section>}</div>{outcome.association && <div className="margin-note association"><span className="note-seal">联想</span><p>{outcome.association}</p></div>}<button className="annotation-collect" onClick={onCollect}>收为印</button></aside>;
}

function TranscriptionNote({ transcription, disabled, onRetry, onChange, onChoose, onConfirm }: { transcription: PendingTranscription; disabled: boolean; onRetry: () => void; onChange: (text: string) => void; onChoose: (text: string) => void; onConfirm: () => void }) {
  const editRef = useRef<HTMLDivElement>(null);
  const label = transcription.isFixture
    ? "演练转写（未调用视觉模型），请在纸页边确认："
    : transcription.initialText
      ? "机器转写，请在纸页边确认："
      : "未识别出文字，请补写后再寻迹：";
  useEffect(() => {
    if (editRef.current && editRef.current.textContent !== transcription.text) editRef.current.textContent = transcription.text;
  }, [transcription.text]);
  const style = {
    left: `${Math.max(10, Math.min(54, transcription.anchor.left * 100))}%`,
    top: `${Math.max(31, Math.min(74, transcription.anchor.bottom * 100 + 5))}%`,
  };
  return <aside className="transcription-note paper-transcription" style={style}>
    <span className="paper-transcription-seal">识</span>
    <span className="paper-transcription-label">{label}</span>
    <div ref={editRef} className="transcription-edit" contentEditable={!disabled} suppressContentEditableWarning role="textbox" aria-label="可编辑转写" onInput={(event) => onChange(event.currentTarget.textContent ?? "")}>{transcription.text}</div>
    {transcription.candidates.length > 0 && <div className="candidate-row" aria-label="候选转写"><span>候选：</span>{transcription.candidates.map((candidate) => <button key={candidate} type="button" disabled={disabled} onClick={() => onChoose(candidate)}>{candidate}</button>)}</div>}
    <button className="paper-transcription-confirm" disabled={disabled || !transcription.text.trim()} onClick={onConfirm}>以此寻迹</button>
    {!transcription.initialText && !transcription.text.trim() && <button className="paper-transcription-retry" disabled={disabled} onClick={onRetry}>再识别一次</button>}
  </aside>;
}

createRoot(document.getElementById("root")!).render(<Notebook />);
