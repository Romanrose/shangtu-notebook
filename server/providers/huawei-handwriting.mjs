import { createTranscription } from "../transcription-contract.mjs";

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const characterSets = new Set(["digit", "letter", "digit_letter", "general"]);

function decodePngDataUrl(image) {
  if (!image || image.mimeType !== "image/png" || typeof image.data !== "string") return null;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(image.data);
  return match?.[1] ?? null;
}

function pngDimensions(base64) {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 24 || !pngSignature.every((byte, index) => bytes[index] === byte)) return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function normalizedBox(location, dimensions) {
  if (!Array.isArray(location) || !dimensions || location.length < 4) return null;
  const points = location.filter(
    (point) => Array.isArray(point) && point.length === 2 && point.every((value) => typeof value === "number" && Number.isFinite(value)),
  );
  if (points.length !== location.length) return null;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return {
    x: Math.max(0, left / dimensions.width),
    y: Math.max(0, top / dimensions.height),
    width: Math.max(0, (right - left) / dimensions.width),
    height: Math.max(0, (bottom - top) / dimensions.height),
  };
}

function handwritingEndpoint(endpoint, projectId) {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") return null;
    const basePath = url.pathname.replace(/\/$/, "");
    url.pathname = `${basePath}/v2/${encodeURIComponent(projectId)}/ocr/handwriting`;
    return url.toString();
  } catch {
    return null;
  }
}

function isEnabled({ endpoint, projectId, authToken }) {
  return Boolean(endpoint && projectId && authToken);
}

/**
 * Adapt Huawei Cloud's handwriting OCR REST API into the notebook's editable
 * transcription contract. Its short-lived X-Auth-Token stays server-only and
 * the supplied AbortSignal cancels the in-flight HTTP request on timeout.
 */
export async function invokeHuaweiHandwriting({
  image,
  endpoint = process.env.HUAWEI_OCR_ENDPOINT,
  projectId = process.env.HUAWEI_OCR_PROJECT_ID,
  authToken = process.env.HUAWEI_OCR_AUTH_TOKEN,
  charSet = process.env.HUAWEI_OCR_CHAR_SET ?? "general",
  quickMode = process.env.HUAWEI_OCR_QUICK_MODE === "1",
  detectDirection = process.env.HUAWEI_OCR_DETECT_DIRECTION === "1",
  fetchImpl = fetch,
  signal,
}) {
  const base64 = decodePngDataUrl(image);
  if (!base64 || !isEnabled({ endpoint, projectId, authToken }) || !characterSets.has(charSet)) return null;
  const url = handwritingEndpoint(endpoint, projectId);
  if (!url) return null;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": authToken,
    },
    body: JSON.stringify({
      image: base64,
      quick_mode: quickMode,
      char_set: charSet,
      detect_direction: detectDirection,
    }),
    signal,
  });
  if (!response.ok) throw new Error(`huawei_handwriting_http_${response.status}`);

  const payload = await response.json();
  const blocks = payload?.result?.words_block_list;
  if (!Array.isArray(blocks)) return null;
  const dimensions = pngDimensions(base64);
  const lines = blocks
    .map((block) => {
      const text = typeof block?.words === "string" ? block.words.trim() : "";
      return text ? { text, box: normalizedBox(block.location, dimensions) } : null;
    })
    .filter((line) => line?.box);
  const text = blocks
    .map((block) => typeof block?.words === "string" ? block.words.trim() : "")
    .filter(Boolean)
    .join("");
  return createTranscription({ text, lines });
}
