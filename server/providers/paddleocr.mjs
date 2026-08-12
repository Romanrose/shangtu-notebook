import { createTranscription } from "../transcription-contract.mjs";

function decodePngDataUrl(image) {
  if (!image || image.mimeType !== "image/png" || typeof image.data !== "string") return null;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(image.data);
  return match?.[1] ?? null;
}

function firstOcrResult(payload) {
  return payload?.result?.ocrResults?.[0]?.prunedResult ?? null;
}

function normalizedBox(box, width, height) {
  if (!Array.isArray(box) || box.length !== 4 || !width || !height) return null;
  const [left, top, right, bottom] = box;
  if (![left, top, right, bottom].every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  return { x: Math.max(0, left / width), y: Math.max(0, top / height), width: Math.max(0, (right - left) / width), height: Math.max(0, (bottom - top) / height) };
}

/**
 * Adapt PaddleOCR 3.x self-hosted /ocr JSON into the notebook contract.
 * The provider receives only the cropped PNG and remains behind runTranscriptionProvider.
 */
export async function invokePaddleOcr({ image, endpoint = process.env.PADDLEOCR_ENDPOINT, fetchImpl = fetch, signal }) {
  const base64 = decodePngDataUrl(image);
  if (!base64 || !endpoint) return null;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: base64, fileType: 1 }),
    signal,
  });
  if (!response.ok) throw new Error(`paddleocr_http_${response.status}`);
  const payload = await response.json();
  const result = firstOcrResult(payload);
  if (!result || !Array.isArray(result.rec_texts)) return null;
  const texts = result.rec_texts.filter((text) => typeof text === "string" && text.trim());
  const boxes = Array.isArray(result.rec_boxes) ? result.rec_boxes : [];
  const width = Number(payload?.result?.dataInfo?.width ?? payload?.result?.dataInfo?.imageWidth);
  const height = Number(payload?.result?.dataInfo?.height ?? payload?.result?.dataInfo?.imageHeight);
  const lines = texts.map((text, index) => ({ text, box: normalizedBox(boxes[index], width, height) })).filter((line) => line.box);
  return createTranscription({ text: texts.join(""), lines });
}
