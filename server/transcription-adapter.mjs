const MAX_IMAGE_BYTES = 2_000_000;

function decodeDataUrl(image) {
  if (!image || typeof image !== "object") return null;
  if (image.mimeType !== "image/png" || typeof image.data !== "string") return null;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(image.data);
  if (!match) return null;
  if (Buffer.byteLength(match[1], "base64") > MAX_IMAGE_BYTES) return null;
  return match[1];
}

/**
 * Replace this adapter on the server when a vision provider is selected.
 * It deliberately accepts an opaque PNG and never exposes provider settings
 * or credentials to the browser.
 */
export async function transcribeInk({ image, provider = process.env.VISION_MODEL_PROVIDER, modelId = process.env.VISION_MODEL_ID }) {
  if (!decodeDataUrl(image)) return { status: "invalid_ink" };
  if (!provider || !modelId) return { status: "vision_unconfigured" };
  return {
    status: "provider_not_implemented",
    provider,
    message: "视觉转写适配器尚未接入已配置的服务商。",
  };
}
