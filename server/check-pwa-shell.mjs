import { readFile } from "node:fs/promises";

const serviceWorker = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const client = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
if (!/^const CACHE = "shangtu-notebook-shell-v\d+";/mu.test(serviceWorker)) throw new Error("PWA shell 缓存版本未声明。");
if (!serviceWorker.includes('event.request.mode === "navigate"')) throw new Error("PWA shell 没有区分导航请求。");
const navigationBlock = serviceWorker.slice(serviceWorker.indexOf('event.request.mode === "navigate"'));
if (navigationBlock.indexOf("fetch(event.request)") === -1 || navigationBlock.indexOf("caches.match(event.request)") === -1 || navigationBlock.indexOf("fetch(event.request)") > navigationBlock.indexOf("caches.match(event.request)")) {
  throw new Error("PWA 导航没有采用网络优先、缓存回退策略。");
}
if (!serviceWorker.includes("self.skipWaiting()") || !serviceWorker.includes("self.clients.claim()")) throw new Error("PWA service worker 没有立即接管更新。");
if (!client.includes('registration.unregister()') || !client.includes('name.startsWith("shangtu-notebook-shell-")') || !client.includes("window.location.reload()")) throw new Error("开发模式没有清理旧 service worker shell。");
if (!client.includes("起点—转折—回望—收束") || !client.includes("if (step >= 4)") || !client.includes("function journeyBeatLabel") || !client.includes("function journeyClueHint") || !client.includes("journey-clue-hint")) throw new Error("人物旅程没有保留四拍收束和线索提示。");
if (!client.includes("function JourneyBeatProgress") || !client.includes("journey-beats") || !styles.includes(".journey-beats")) throw new Error("纸面没有显示人物路线节拍进度。");
if (!client.includes('<dt>继续</dt>') || !client.includes("ritual.invitation")) throw new Error("人物旅程没有在四拍卡片中显示下一步邀请。");
if (!client.includes("personId") || !client.includes("visitedNodes") || !client.includes("unresolvedQuestions") || !client.includes("normalizeJourneyState")) throw new Error("人物旅程没有保存可迁移的锚点、已访问节点和悬置问题状态。");
if (!client.includes("else if (!journey.route)") || !client.includes("makeDemoJourneyOutcome(journey.route)")) throw new Error("人物演练在路线未选定时错误地自动进入了默认路线。");
if (!client.includes("question markers before they reach the anchor resolver") || !client.includes("什么|为什么|为何|哪里|关联")) throw new Error("人物首笔没有在本地拦截压缩问题句，可能误进入人物锚点解析。");
if (!client.includes("我想知道他去过哪里") || !client.includes("我想从地点开始") || !client.includes("我想知道他的经历") || !client.includes("我想从经历开始") || !client.includes("我想知道他的作品") || !client.includes("我想从作品开始")) throw new Error("路线没有保留明确自然语言选择短句。");
if (!client.includes('className="journey-collect"') || !client.includes("collectJourney")) throw new Error("人物旅程没有提供收纳动作。");
if (!client.includes("const clearCurrentPage") || !client.includes('className="clear-page-mark"') || !client.includes("清空当前页？")) throw new Error("纸页没有安全的当前页清空动作。");
if (!client.includes('className="journey-guide-kicker"') || !client.includes("引导 · 人物已确认") || !client.includes('aria-label="人物路线引导"') || !styles.includes(".journey-guide-kicker")) throw new Error("人物锚点确认后没有显著的纸页路线引导。");
if (!client.includes('annotation.outcome.kind === "evidence"')) throw new Error("路线收纳没有保留歧义和证据缺口分支。");
if (!client.includes('annotation.outcome.path[0] === journey?.anchor')) throw new Error("路线收纳没有限制到当前人物锚点。");
if (!styles.includes(".journey-route-picker button { min-height: 32px") || !styles.includes(".journey-collect { min-height: 30px") || !styles.includes(".journey-switch { min-height: 30px")) throw new Error("路线控制没有达到平板触控的最小点击高度。");

console.log("PWA shell network-first contract verified.");
