import { createTranscription } from "./transcription-contract.mjs";
import { invokeOpenAiCompatibleVlm } from "./providers/openai-compatible-vlm.mjs";
import { invokePaddleOcr } from "./providers/paddleocr.mjs";
import { invokePaddleOcrVl } from "./providers/paddleocr-vl.mjs";
import { invokeTesseract } from "./providers/tesseract.mjs";

const MAX_IMAGE_BYTES = 2_000_000;
export const TRANSCRIPTION_TIMEOUT_MS = 8_000;
export const fixtureTranscription = "李白写过《将进酒》吗？";

function decodeDataUrl(image) {
  if (!image || typeof image !== "object") return null;
  if (image.mimeType !== "image/png" || typeof image.data !== "string") return null;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(image.data);
  if (!match) return null;
  if (Buffer.byteLength(match[1], "base64") > MAX_IMAGE_BYTES) return null;
  return match[1];
}

/**
 * Runs a future provider behind one bounded server-side boundary. Providers
 * receive an AbortSignal, but must still arrange their own request cleanup.
 */
export async function runTranscriptionProvider({ invoke, timeoutMs = TRANSCRIPTION_TIMEOUT_MS }) {
  const controller = new AbortController();
  let timer;
  try {
    const proposal = await Promise.race([
      Promise.resolve().then(() => invoke({ signal: controller.signal })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("transcription_timed_out"));
        }, timeoutMs);
      }),
    ]);
    const transcription = createTranscription(proposal);
    return transcription
      ? { status: "ok", transcription, providerStatus: "ready" }
      : { status: "vision_unavailable", providerStatus: "unavailable" };
  } catch (error) {
    return error instanceof Error && error.message === "transcription_timed_out"
      ? { status: "vision_timed_out", providerStatus: "timed_out" }
      : { status: "vision_unavailable", providerStatus: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Replace this adapter on the server when a vision provider is selected.
 * It deliberately accepts an opaque PNG and never exposes provider settings
 * or credentials to the browser.
 */
export async function transcribeInk({ image, provider = process.env.VISION_MODEL_PROVIDER, modelId = process.env.VISION_MODEL_ID, fixtureMode = process.env.NOTEBOOK_FIXTURE_MODE, endpoint = process.env.PADDLEOCR_ENDPOINT, vlEndpoint = process.env.PADDLEOCR_VL_ENDPOINT, tesseractBin = process.env.TESSERACT_BIN, tessdataPrefix = process.env.TESSDATA_PREFIX, tesseractLanguage = process.env.TESSERACT_LANG, tesseractPsm = process.env.TESSERACT_PSM, vlmEndpoint = process.env.VISION_VLM_ENDPOINT, vlmApiKey = process.env.VISION_VLM_API_KEY, invokeProvider, fetchImpl, spawnImpl }) {
  if (!decodeDataUrl(image)) return { status: "invalid_ink", providerStatus: "rejected" };
  if (fixtureMode === true || fixtureMode === "1") {
    return { status: "ok", transcription: createTranscription({ text: fixtureTranscription }), providerStatus: "fixture" };
  }
  if (!provider || !modelId) return { status: "vision_unconfigured", providerStatus: "unconfigured" };
  if (provider === "paddleocr" && !endpoint) return { status: "vision_unconfigured", providerStatus: "unconfigured" };
  if (provider === "paddleocr-vl" && !vlEndpoint) return { status: "vision_unconfigured", providerStatus: "unconfigured" };
  if (provider === "tesseract" && !tesseractBin) return { status: "vision_unconfigured", providerStatus: "unconfigured" };
  if (provider === "vlm-openai-compatible" && (!vlmEndpoint || !vlmApiKey)) return { status: "vision_unconfigured", providerStatus: "unconfigured" };
  if (invokeProvider) return runTranscriptionProvider({ invoke: ({ signal }) => invokeProvider({ image, signal }) });
  if (provider === "paddleocr" && endpoint) {
    return runTranscriptionProvider({ invoke: ({ signal }) => invokePaddleOcr({ image, endpoint, signal, fetchImpl }) });
  }
  if (provider === "paddleocr-vl" && vlEndpoint) {
    return runTranscriptionProvider({ invoke: ({ signal }) => invokePaddleOcrVl({ image, endpoint: vlEndpoint, signal, fetchImpl }) });
  }
  if (provider === "tesseract" && tesseractBin) {
    return runTranscriptionProvider({ invoke: ({ signal }) => invokeTesseract({ image, command: tesseractBin, language: tesseractLanguage, tessdataPrefix, psm: tesseractPsm, signal, spawnImpl }) });
  }
  if (provider === "vlm-openai-compatible" && vlmEndpoint && vlmApiKey) {
    return runTranscriptionProvider({ invoke: ({ signal }) => invokeOpenAiCompatibleVlm({ image, modelId, endpoint: vlmEndpoint, apiKey: vlmApiKey, signal, fetchImpl }) });
  }
  return {
    status: "provider_not_implemented",
    providerStatus: "not_implemented",
    message: "视觉转写适配器尚未接入已配置的服务商。",
  };
}
