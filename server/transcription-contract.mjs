const MAX_TEXT_LENGTH = 240;
const MAX_CANDIDATES = 3;

function shortText(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text && text.length <= MAX_TEXT_LENGTH ? text : null;
}

function relativeBox(value) {
  if (!value || typeof value !== "object") return null;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every((part) => typeof part === "number" && Number.isFinite(part) && part >= 0 && part <= 1)) return null;
  if (x + width > 1 || y + height > 1 || !width || !height) return null;
  return { x, y, width, height };
}

/**
 * Canonical server-to-browser shape for a proposed transcription. Coordinates,
 * when available, are relative to the cropped ink image rather than the page.
 */
export function createTranscription({ text, candidates = [], lines } = {}) {
  const primary = shortText(text);
  if (!primary) return null;
  const alternatives = [...new Set(candidates.map(shortText).filter((candidate) => candidate && candidate !== primary))].slice(0, MAX_CANDIDATES);
  const recognizedLines = Array.isArray(lines)
    ? lines.map((line) => {
      const lineText = shortText(line?.text);
      const box = relativeBox(line?.box);
      return lineText && box ? { text: lineText, box } : null;
    }).filter(Boolean)
    : [];
  return { text: primary, candidates: alternatives, ...(recognizedLines.length ? { lines: recognizedLines } : {}) };
}
