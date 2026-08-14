import { inspectPiModelConfiguration } from "./preflight-pi-model.mjs";

function isHttpUrl(value, { httpsOnly = false } = {}) {
  try {
    const url = new URL(value);
    return httpsOnly ? url.protocol === "https:" : ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function configured(env, names) {
  return names.every((name) => typeof env[name] === "string" && env[name].trim());
}

function inspectOcrConfiguration(env) {
  const provider = env.SABER_PI_TRANSCRIPTION_PROVIDER ?? env.VISION_MODEL_PROVIDER;
  if (!provider) return { status: "ocr_unconfigured" };

  if (provider === "huawei-handwriting") {
    const required = ["HUAWEI_OCR_ENDPOINT", "HUAWEI_OCR_PROJECT_ID", "HUAWEI_OCR_AUTH_TOKEN"];
    if (!configured(env, required)) return { status: "ocr_auth_or_endpoint_missing", provider };
    if (!isHttpUrl(env.HUAWEI_OCR_ENDPOINT, { httpsOnly: true })) return { status: "ocr_endpoint_invalid", provider };
    return { status: "ocr_ready_for_controlled_call", provider };
  }

  const endpointByProvider = {
    paddleocr: "PADDLEOCR_ENDPOINT",
    "paddleocr-vl": "PADDLEOCR_VL_ENDPOINT",
    "vlm-openai-compatible": "VISION_VLM_ENDPOINT",
  };
  const endpointName = endpointByProvider[provider];
  if (endpointName) {
    if (!configured(env, [endpointName])) return { status: "ocr_endpoint_missing", provider };
    if (!isHttpUrl(env[endpointName])) return { status: "ocr_endpoint_invalid", provider };
    if (provider === "vlm-openai-compatible" && !configured(env, ["VISION_VLM_API_KEY", "VISION_MODEL_ID"])) {
      return { status: "ocr_auth_or_model_missing", provider };
    }
    return { status: "ocr_ready_for_controlled_call", provider };
  }

  if (provider === "tesseract") {
    return configured(env, ["TESSERACT_BIN"])
      ? { status: "ocr_ready_for_controlled_call", provider }
      : { status: "ocr_binary_missing", provider };
  }
  return { status: "ocr_provider_unknown", provider };
}

function inspectCnkgraphGatewayConfiguration(env) {
  const endpoint = env.CNKGRAPH_GATEWAY_ENDPOINT;
  const authToken = env.CNKGRAPH_GATEWAY_AUTH_TOKEN;
  if (!endpoint && !authToken) return { status: "graph_unconfigured" };
  if (!endpoint || !authToken) return { status: "graph_auth_or_endpoint_missing" };
  if (!isHttpUrl(endpoint, { httpsOnly: true })) return { status: "graph_endpoint_invalid" };
  return { status: "graph_ready_for_controlled_call" };
}

/**
 * Reads only configuration presence and static catalog state. It never issues
 * a network request or includes an endpoint, token, project ID, or API key in
 * its output.
 */
export function inspectRealServicesConfiguration({ env = process.env } = {}) {
  const ocr = inspectOcrConfiguration(env);
  const pi = inspectPiModelConfiguration({
    provider: env.PI_MODEL_PROVIDER,
    modelId: env.PI_MODEL_ID,
    env,
  });
  const graph = inspectCnkgraphGatewayConfiguration(env);
  return {
    schema: "shangtu-real-services-preflight-v1",
    ocr,
    pi,
    graph,
    readyForOcrCall: ocr.status === "ocr_ready_for_controlled_call",
    readyForSeekCall: pi.status === "pi_ready_for_controlled_call" && graph.status === "graph_ready_for_controlled_call",
  };
}

if (import.meta.main) console.log(JSON.stringify(inspectRealServicesConfiguration()));
