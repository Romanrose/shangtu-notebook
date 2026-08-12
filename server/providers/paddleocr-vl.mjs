import { createTranscription } from "../transcription-contract.mjs";

function decodePngDataUrl(image) {
  if (!image || image.mimeType !== "image/png" || typeof image.data !== "string") return null;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(image.data);
  return match?.[1] ?? null;
}

function normalizedBox(box, width, height) {
  if (!Array.isArray(box) || box.length !== 4 || !width || !height) return null;
  const [left, top, right, bottom] = box;
  if (![left, top, right, bottom].every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  return { x: Math.max(0, left / width), y: Math.max(0, top / height), width: Math.max(0, (right - left) / width), height: Math.max(0, (bottom - top) / height) };
}

/** Adapt PaddleOCR-VL's full pipeline /layout-parsing response into the notebook contract. */
export async function invokePaddleOcrVl({ image, endpoint = process.env.PADDLEOCR_VL_ENDPOINT, fetchImpl = fetch, signal }) {
  const base64 = decodePngDataUrl(image);
  if (!base64 || !endpoint) return null;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: base64, fileType: 1, visualize: false, returnMarkdownImages: false }),
    signal,
  });
  if (!response.ok) throw new Error(`paddleocr_vl_http_${response.status}`);
  const payload = await response.json();
  const result = payload?.result?.layoutParsingResults?.[0]?.prunedResult;
  if (!result || !Array.isArray(result.parsing_res_list)) return null;
  const width = Number(payload?.result?.dataInfo?.width ?? result.width);
  const height = Number(payload?.result?.dataInfo?.height ?? result.height);
  const blocks = result.parsing_res_list.filter((block) => typeof block?.block_content === "string" && block.block_content.trim());
  return createTranscription({
    text: blocks.map((block) => block.block_content.trim()).join(""),
    lines: blocks.map((block) => ({ text: block.block_content, box: normalizedBox(block.block_bbox, width, height) })),
  });
}
