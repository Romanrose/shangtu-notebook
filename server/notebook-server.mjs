import { createServer } from "node:http";
import { createAnchorResolver, createCnkgraphGatewayRetriever } from "./cnkgraph-gateway.mjs";
import { runFixtureSeek } from "./fixture-seek.mjs";
import { resolveNotebookAnchor, runNarrative } from "./journey-agent.mjs";
import { runSeek } from "./run-seek.mjs";
import { createSouyunSnapshotRetriever } from "./souyun-snapshot-retriever.mjs";
import { transcribeInk } from "./transcription-adapter.mjs";

const MAX_BODY_BYTES = 2_200_000;

function writeJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_json");
  }
}

export function seekNotebook(input) {
  return process.env.NOTEBOOK_FIXTURE_MODE === "1"
    ? runFixtureSeek(input)
    : runSeek({ ...input, retrieve: process.env.CNKGRAPH_PROVIDER === "souyun-snapshot" ? createSouyunSnapshotRetriever() : createCnkgraphGatewayRetriever() });
}

/** 起笔人物名（无 journey 上下文）→ 人物锚点解析；其余走寻迹。 */
export async function seekOrAnchorNotebook(input, resolveAnchor = createAnchorResolver(), seek = seekNotebook) {
  if (input?.journey === undefined || input?.journey === null) {
    const anchored = await resolveNotebookAnchor({ transcription: input?.transcription, resolveAnchor });
    if (anchored) return anchored;
  }
  return seek(input);
}

export function createNotebookApiHandler({ transcribe = transcribeInk, seek = seekOrAnchorNotebook, narrative = runNarrative } = {}) {
  return async (request, response, next) => {
    if (request.method !== "POST" || !["/api/transcribe", "/api/seek", "/api/narrative"].includes(request.url)) {
      if (next) {
        next();
        return;
      }
      writeJson(response, 404, { status: "not_found" });
      return;
    }
    try {
      const body = await readJson(request);
      const result = request.url === "/api/transcribe"
        ? await transcribe({ image: body.image })
        : request.url === "/api/narrative"
          ? await narrative({ journey: body.journey, evidence: body.evidence })
          : await seek({ transcription: body.transcription, image: body.image, journey: body.journey });
      writeJson(response, 200, result);
    } catch (error) {
      const status = error instanceof Error && error.message === "body_too_large" ? 413 : 400;
      writeJson(response, status, { status: "bad_request" });
    }
  };
}

export function createNotebookServer(options) {
  return createServer(createNotebookApiHandler(options));
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 4174);
  createNotebookServer().listen(port, () => console.log(`Notebook API listening on :${port}`));
}
