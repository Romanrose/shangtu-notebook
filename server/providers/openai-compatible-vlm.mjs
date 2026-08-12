import { createTranscription } from "../transcription-contract.mjs";

function decodePngDataUrl(image) {
  if (!image || image.mimeType !== "image/png" || typeof image.data !== "string") return null;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(image.data);
  return match?.[1] ?? null;
}

function contentText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => typeof part === "string" ? part : part?.type === "text" ? part.text : "")
    .filter((text) => typeof text === "string" && text.trim())
    .join("\n")
    .trim();
}

function parseModelContent(content) {
  const text = contentText(content);
  if (!text) return null;
  const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = JSON.parse(jsonText);
    if (parsed && typeof parsed === "object") return createTranscription(parsed);
  } catch {
    // A plain text response is still an editable machine transcription.
  }
  return createTranscription({ text });
}

/**
 * Adapt an OpenAI-compatible vision chat endpoint into the notebook contract.
 * The endpoint and bearer token are server-only; neither is returned to the browser.
 */
export async function invokeOpenAiCompatibleVlm({
  image,
  modelId,
  endpoint = process.env.VISION_VLM_ENDPOINT,
  apiKey = process.env.VISION_VLM_API_KEY,
  fetchImpl = fetch,
  signal,
}) {
  const base64 = decodePngDataUrl(image);
  if (!base64 || !modelId || !endpoint || !apiKey) return null;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      temperature: 0,
      max_tokens: 256,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "请只转写图片中的手写文字。保留原有语言、标点和书名号。只输出 JSON：{\"text\":\"...\",\"candidates\":[\"...\"]}，不要解释、不要补充事实。" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
        ],
      }],
    }),
    signal,
  });
  if (!response.ok) throw new Error(`vlm_http_${response.status}`);
  const payload = await response.json();
  return parseModelContent(payload?.choices?.[0]?.message?.content);
}
