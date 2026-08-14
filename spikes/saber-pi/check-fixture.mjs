import { createServer } from "node:http";
import { createSaberPiFixtureHandler, createSaberPiSeeker, createSaberPiTranscriber, SABER_PI_SPIKE_PATHS } from "./bridge.mjs";
import { runFixtureSeek } from "../../server/fixture-seek.mjs";
import { fixtureTranscription } from "../../server/transcription-adapter.mjs";

const tinyInk = { mimeType: "image/png", data: "data:image/png;base64,AA==" };
const events = [];
let transcribeCalls = 0;
let seekCalls = 0;

const defaultTranscriberCalls = [];
const defaultTranscriber = createSaberPiTranscriber({
  transcribe: async (request) => {
    defaultTranscriberCalls.push(request);
    return { status: "ok" };
  },
});
await defaultTranscriber({ image: tinyInk });
if (defaultTranscriberCalls.length !== 1 || defaultTranscriberCalls[0].fixtureMode !== true || defaultTranscriberCalls[0].provider !== undefined) {
  throw new Error("unconfigured bridge must remain fixture-only");
}

const providerTranscriberCalls = [];
const providerTranscriber = createSaberPiTranscriber({
  provider: "huawei-handwriting",
  modelId: "handwriting-v1",
  transcribe: async (request) => {
    providerTranscriberCalls.push(request);
    return { status: "ok" };
  },
});
await providerTranscriber({ image: tinyInk });
if (providerTranscriberCalls.length !== 1 || providerTranscriberCalls[0].provider !== "huawei-handwriting" || providerTranscriberCalls[0].modelId !== "handwriting-v1" || providerTranscriberCalls[0].fixtureMode !== undefined) {
  throw new Error("configured bridge did not forward the selected server provider");
}

const realSeekCalls = [];
const realSeeker = createSaberPiSeeker({
  provider: "notebook",
  seek: async (input) => {
    realSeekCalls.push(input);
    return { status: "ok", outcome: { kind: "gap", gap: "受控内核未找到可靠证据。" } };
  },
});
const realSeekResult = await realSeeker({ transcription: "李白", image: tinyInk });
if (realSeekCalls.length !== 1 || realSeekCalls[0].transcription !== "李白" || realSeekCalls[0].image !== tinyInk || realSeekResult.outcome.kind !== "gap") {
  throw new Error("explicit notebook seeker did not preserve the confirmed-text boundary");
}
for (const options of [{ provider: "unbounded" }, { provider: "notebook", fixtureScenario: "gap" }]) {
  let rejected = false;
  try {
    createSaberPiSeeker(options);
  } catch (error) {
    rejected = error instanceof Error && ["invalid_saber_pi_seek_provider", "fixture_scenario_requires_fixture_seek_provider"].includes(error.message);
  }
  if (!rejected) throw new Error("invalid Saber seek provider configuration was accepted");
}

const server = createServer(createSaberPiFixtureHandler({
  transcribe: async ({ image }) => {
    transcribeCalls++;
    if (!events.includes("local_awakening")) throw new Error("local awakening must precede bridge call");
    return { status: "ok", transcription: { text: fixtureTranscription, candidates: [] }, providerStatus: "fixture", provider: "fixture" };
  },
  seek: async ({ transcription, image }) => {
    seekCalls++;
    if (!events.includes("transcription_confirmed")) throw new Error("seek must follow confirmation");
    return runFixtureSeek({ transcription, image });
  },
}));

await new Promise((resolve) => server.listen(0, resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const post = (path, body) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}).then(async (response) => ({ status: response.status, body: await response.json() }));

try {
  const penUpAt = performance.now();
  events.push("pen_up");
  events.push("local_awakening");
  if (performance.now() - penUpAt >= 1000) throw new Error("local awakening exceeded one second");
  const transcription = await post(SABER_PI_SPIKE_PATHS.transcribe, {
    pageId: "note-01-page-01", strokeSegmentId: "segment-01", mode: "seek", image: tinyInk,
  });
  if (transcription.status !== 200 || transcription.body.stage !== "transcription" || transcription.body.transcription.text !== fixtureTranscription) throw new Error("fixture transcription vertical slice failed");
  if (transcription.body.originalInk !== "retained_by_saber") throw new Error("bridge did not preserve Saber ink ownership");

  const missingConfirmation = await post(SABER_PI_SPIKE_PATHS.seek, {
    pageId: "note-01-page-01", strokeSegmentId: "segment-01", mode: "seek", image: tinyInk,
  });
  if (missingConfirmation.status !== 409 || missingConfirmation.body.status !== "confirmation_required") throw new Error("seek was callable before confirmation");

  events.push("transcription_confirmed");
  const evidence = await post(SABER_PI_SPIKE_PATHS.seek, {
    pageId: "note-01-page-01", strokeSegmentId: "segment-01", mode: "seek", image: tinyInk, confirmedText: fixtureTranscription,
  });
  if (evidence.status !== 200 || evidence.body.outcome.kind !== "evidence" || evidence.body.outcome.path.join(" → ") !== "李白 → 作者 → 将进酒" || evidence.body.outcome.source.length !== 1) throw new Error("evidence branch failed");

  const ambiguous = await post(SABER_PI_SPIKE_PATHS.seek, {
    pageId: "note-01-page-01", strokeSegmentId: "segment-01", mode: "seek", image: tinyInk, confirmedText: "李贺和长安有什么关联？",
  });
  if (ambiguous.status !== 200 || ambiguous.body.outcome.kind !== "ambiguous" || ambiguous.body.outcome.candidates.length < 2) throw new Error("ambiguity branch failed");

  const gap = await post(SABER_PI_SPIKE_PATHS.seek, {
    pageId: "note-01-page-01", strokeSegmentId: "segment-01", mode: "seek", image: tinyInk, confirmedText: "珊瑚与唐诗有什么关联？",
  });
  if (gap.status !== 200 || gap.body.outcome.kind !== "gap" || !gap.body.outcome.gap.includes("没有这条")) throw new Error("evidence gap branch failed");

  for (const [fixtureScenario, expectedKind] of [["ambiguous", "ambiguous"], ["gap", "gap"]]) {
    const scenarioServer = createServer(createSaberPiFixtureHandler({ fixtureScenario }));
    await new Promise((resolve) => scenarioServer.listen(0, resolve));
    const scenarioOrigin = `http://127.0.0.1:${scenarioServer.address().port}`;
    try {
      const scenarioResult = await fetch(`${scenarioOrigin}${SABER_PI_SPIKE_PATHS.seek}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageId: "note-01-page-01",
          strokeSegmentId: `scenario-${fixtureScenario}`,
          mode: "seek",
          image: tinyInk,
          confirmedText: fixtureTranscription,
        }),
      }).then(async (response) => ({ status: response.status, body: await response.json() }));
      if (scenarioResult.status !== 200 || scenarioResult.body.outcome.kind !== expectedKind) {
        throw new Error(`fixture scenario ${fixtureScenario} did not select ${expectedKind}`);
      }
    } finally {
      scenarioServer.close();
    }
  }
  let invalidScenarioRejected = false;
  try {
    createSaberPiFixtureHandler({ fixtureScenario: "unbounded" });
  } catch (error) {
    invalidScenarioRejected = error instanceof Error && error.message === "invalid_fixture_scenario";
  }
  if (!invalidScenarioRejected) throw new Error("invalid fixture scenario was accepted");

  const beforeQuietCalls = { transcribeCalls, seekCalls };
  const quiet = await post(SABER_PI_SPIKE_PATHS.transcribe, {
    pageId: "note-01-page-01", strokeSegmentId: "segment-quiet", mode: "quiet", image: tinyInk,
  });
  if (quiet.status !== 409 || quiet.body.status !== "quiet_mode_no_seek" || transcribeCalls !== beforeQuietCalls.transcribeCalls || seekCalls !== beforeQuietCalls.seekCalls) throw new Error("quiet mode crossed bridge boundary");

  const forbidden = await fetch(`${origin}/spike/saber-pi/v1/anything`, { method: "POST" });
  if (forbidden.status !== 404) throw new Error("bridge exposed a non-contract route");
  if (transcribeCalls !== 1 || seekCalls !== 3) throw new Error("unexpected bridge call count");
  console.log("Saber Pi spike fixture verified: provider selection, local awakening, editable transcription, evidence, ambiguity, gap, confirmation, quiet-mode boundaries, and fixed test scenarios.");
} finally {
  server.close();
}
