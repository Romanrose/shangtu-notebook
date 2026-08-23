import { proxyNotebookRequest } from "../api/_proxy.mjs";

const origin = "https://shangtu.romanrose.top";
const env = {
  NOTEBOOK_ALLOWED_ORIGINS: origin,
  NOTEBOOK_UPSTREAM_URL: "https://xmubox.example.test:10000",
  NOTEBOOK_UPSTREAM_AUTH_TOKEN: "server-only-proxy-token",
};
let upstreamRequest;
const response = await proxyNotebookRequest(new Request(`${origin}/api/seek`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Origin": origin },
  body: JSON.stringify({ transcription: "李白" }),
}), "seek", {
  env,
  fetchImpl: async (url, options) => {
    upstreamRequest = { url: url.toString(), options };
    return Response.json({ status: "ok" });
  },
});
if (response.status !== 200 || upstreamRequest?.url !== "https://xmubox.example.test:10000/api/seek" || upstreamRequest.options.headers.Authorization !== "Bearer server-only-proxy-token") throw new Error("Vercel 代理没有保持固定路由或服务端认证。");

const forbidden = await proxyNotebookRequest(new Request(`${origin}/api/seek`, { method: "POST", headers: { "Origin": "https://attacker.example" }, body: "{}" }), "seek", { env, fetchImpl: async () => { throw new Error("不应访问上游"); } });
if (forbidden.status !== 403) throw new Error("Vercel 代理没有拒绝非纸页来源。");

const unconfigured = await proxyNotebookRequest(new Request(`${origin}/api/seek`, { method: "POST", headers: { "Origin": origin }, body: "{}" }), "seek", { env: { NOTEBOOK_ALLOWED_ORIGINS: origin }, fetchImpl: async () => { throw new Error("不应访问上游"); } });
if (unconfigured.status !== 503) throw new Error("Vercel 代理没有在缺少服务端配置时安全停止。");

console.log("Vercel notebook proxy contract verified.");
