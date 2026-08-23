const ROUTES = new Set(["transcribe", "seek", "narrative"]);
const MAX_BODY_BYTES = 2_200_000;
const UPSTREAM_TIMEOUT_MS = 25_000;

function json(status, body) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function allowedOrigins(value) {
  return new Set((value ?? "").split(",").map((origin) => origin.trim()).filter(Boolean));
}

export async function proxyNotebookRequest(request, route, { env = process.env, fetchImpl = fetch } = {}) {
  if (request.method !== "POST" || !ROUTES.has(route)) return json(404, { status: "not_found" });

  const origins = allowedOrigins(env.NOTEBOOK_ALLOWED_ORIGINS);
  const origin = request.headers.get("Origin");
  if (!origin || !origins.has(origin)) return json(403, { status: "forbidden" });

  const upstreamBase = env.NOTEBOOK_UPSTREAM_URL?.trim();
  const authToken = env.NOTEBOOK_UPSTREAM_AUTH_TOKEN?.trim();
  let upstream;
  try {
    upstream = new URL(`/api/${route}`, upstreamBase);
  } catch {
    return json(503, { status: "upstream_unconfigured" });
  }
  if (upstream.protocol !== "https:" || !authToken) return json(503, { status: "upstream_unconfigured" });

  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) return json(413, { status: "body_too_large" });
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) return json(413, { status: "body_too_large" });

  try {
    const response = await fetchImpl(upstream, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") ?? "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return json(502, { status: "upstream_unavailable" });
  }
}
