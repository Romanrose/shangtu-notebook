import { createServer } from "node:http";
import { createSaberPiFixtureHandler, SABER_PI_SPIKE_PATHS } from "./bridge.mjs";
import { createSaberPiClient } from "./client.mjs";

const ink = { mimeType: "image/png", data: "data:image/png;base64,AA==" };
const calls = [];
const states = [];
const server = createServer(createSaberPiFixtureHandler());

await new Promise((resolve) => server.listen(0, resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const request = (path, body) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}).then((response) => response.json());

const client = createSaberPiClient({
  onLocalAwakening: () => calls.push("local_awakening"),
  onStateChange: (state) => states.push(state.phase),
  transport: {
    transcribe: (body) => {
      calls.push("transcribe");
      return request(SABER_PI_SPIKE_PATHS.transcribe, body);
    },
    seek: (body) => {
      calls.push("seek");
      return request(SABER_PI_SPIKE_PATHS.seek, body);
    },
  },
});

try {
  const pageId = "note-01-page-01";
  const strokeSegmentId = "segment-client-01";
  await client.penUp({ pageId, strokeSegmentId, mode: "seek", image: ink });
  if (calls.join(",") !== "local_awakening,transcribe") throw new Error("client called transport before local awakening");
  if (client.getState().phase !== "awaiting_confirmation" || client.getState().ink !== ink) throw new Error("client lost derived-layer state or Saber ink ownership");

  try {
    await client.confirm({ text: "" });
    throw new Error("client allowed empty confirmation");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "confirmation_required") throw error;
  }
  if (calls.includes("seek")) throw new Error("client sought before user confirmation");

  const evidence = await client.confirm({ text: "李白写过《将进酒》吗？" });
  if (calls.join(",") !== "local_awakening,transcribe,seek" || evidence.result.outcome?.kind !== "evidence") throw new Error("client evidence mapping failed");
  if (client.getState().ink !== ink) throw new Error("client replaced original ink after annotation");

  const ambiguous = await request(SABER_PI_SPIKE_PATHS.seek, { pageId, strokeSegmentId, mode: "seek", image: ink, confirmedText: "李贺和长安有什么关联？" });
  if (ambiguous.outcome?.kind !== "ambiguous" || ambiguous.outcome.candidates.length < 2) throw new Error("client contract does not expose ambiguity candidates");
  const gap = await request(SABER_PI_SPIKE_PATHS.seek, { pageId, strokeSegmentId, mode: "seek", image: ink, confirmedText: "珊瑚与唐诗有什么关联？" });
  if (gap.outcome?.kind !== "gap") throw new Error("client contract does not expose evidence gap");

  const beforeQuiet = calls.length;
  await client.penUp({ pageId, strokeSegmentId: "segment-quiet", mode: "quiet", image: ink });
  if (client.getState().phase !== "quiet" || calls.length !== beforeQuiet) throw new Error("quiet mode invoked Pi transport");
  if (states[0] !== "awakening" || states[1] !== "awaiting_confirmation") throw new Error("client local state order drifted");
  console.log("Saber Pi client contract verified: local awakening, confirmation gate, ink retention, three outcomes, and quiet mode.");
} finally {
  server.close();
}
