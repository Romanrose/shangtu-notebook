import { createServer } from "node:http";
import { runFixtureSeek } from "../../server/fixture-seek.mjs";
import { transcribeInk } from "../../server/transcription-adapter.mjs";

const MAX_BODY_BYTES = 2_200_000;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const BRIDGE_PREFIX = "/spike/saber-pi/v1";

export const SABER_PI_SPIKE_PATHS = Object.freeze({
  transcribe: `${BRIDGE_PREFIX}/transcribe`,
  seek: `${BRIDGE_PREFIX}/seek`,
});

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

function validId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function validInk(image) {
  return image && typeof image === "object" && image.mimeType === "image/png" &&
    typeof image.data === "string" && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image.data);
}

function validateCommon(body) {
  if (!body || typeof body !== "object") return "invalid_request";
  if (!validId(body.pageId) || !validId(body.strokeSegmentId)) return "invalid_identity";
  if (body.mode === "quiet") return "quiet_mode_no_seek";
  if (body.mode !== "seek") return "invalid_mode";
  if (!validInk(body.image)) return "invalid_ink";
  return null;
}

function bridgeEnvelope(body, stage, result) {
  return {
    schema: "saber-pi-bridge-v1",
    pageId: body.pageId,
    strokeSegmentId: body.strokeSegmentId,
    mode: body.mode,
    stage,
    // This is an invariant, not a claim that the bridge persisted the image.
    originalInk: "retained_by_saber",
    ...result,
  };
}

/**
 * Keeps the spike offline unless a server operator explicitly selects an
 * already-supported transcription provider. Provider configuration and its
 * credentials remain in the Node process; Saber never receives either.
 */
export function createSaberPiTranscriber({
  provider = process.env.SABER_PI_TRANSCRIPTION_PROVIDER,
  modelId = process.env.SABER_PI_TRANSCRIPTION_MODEL_ID ?? process.env.VISION_MODEL_ID,
  transcribe = transcribeInk,
} = {}) {
  if (!provider) {
    return ({ image }) => transcribe({ image, fixtureMode: true });
  }
  return ({ image }) => transcribe({ image, provider, modelId });
}

/**
 * A constrained bridge for the Saber spike. It remains fixture-only by
 * default: no model, Pi session, network, or credential is used until the
 * server operator explicitly selects a supported transcription provider.
 */
export function createSaberPiFixtureHandler({
  transcribe = createSaberPiTranscriber(),
  seek = ({ transcription, image }) => runFixtureSeek({ transcription, image }),
} = {}) {
  return async (request, response, next) => {
    if (request.method !== "POST" || !Object.values(SABER_PI_SPIKE_PATHS).includes(request.url)) {
      if (next) return next();
      return writeJson(response, 404, { status: "not_found" });
    }

    try {
      const body = await readJson(request);
      const commonError = validateCommon(body);
      if (commonError) return writeJson(response, 409, bridgeEnvelope(body ?? {}, "rejected", { status: commonError }));

      if (request.url === SABER_PI_SPIKE_PATHS.transcribe) {
        const result = await transcribe({ image: body.image });
        return writeJson(response, 200, bridgeEnvelope(body, "transcription", result));
      }

      if (typeof body.confirmedText !== "string" || !body.confirmedText.trim() || body.confirmedText.length > 240) {
        return writeJson(response, 409, bridgeEnvelope(body, "rejected", { status: "confirmation_required" }));
      }
      const result = await seek({ transcription: body.confirmedText.trim(), image: body.image });
      return writeJson(response, 200, bridgeEnvelope(body, "annotation", result));
    } catch (error) {
      const status = error instanceof Error && error.message === "body_too_large" ? 413 : 400;
      return writeJson(response, status, { status: "bad_request" });
    }
  };
}

export function createSaberPiFixtureServer(options) {
  return createServer(createSaberPiFixtureHandler(options));
}

if (import.meta.main) {
  const port = Number(process.env.SABER_PI_SPIKE_PORT ?? 4175);
  createSaberPiFixtureServer().listen(port, () => {
    console.log(`Saber Pi fixture bridge listening on :${port}`);
  });
}
