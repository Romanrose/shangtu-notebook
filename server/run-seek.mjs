import { createPiNotebookSession, notebookSystemPrompt } from "./notebook-agent.mjs";
import { retrieveFixture } from "./cnkgraph-fixture.mjs";
import { normalizeSeekOutcome } from "./seek-outcome.mjs";

function textFromLastAssistant(session) {
  const last = [...session.messages].reverse().find((message) => message.role === "assistant");
  return last ? last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim() : "";
}

function cacheRequestRetrieval(retrieve) {
  const results = new Map();
  return (query) => {
    if (!results.has(query)) results.set(query, Promise.resolve().then(() => retrieve(query)));
    return results.get(query);
  };
}

/** Future /api/seek boundary. Image stays opaque until the replaceable vision step. */
export async function runSeek({ transcription, image, createSession = createPiNotebookSession, retrieve = retrieveFixture }) {
  if (!transcription?.trim()) return { status: "needs_transcription" };
  const requestRetrieval = cacheRequestRetrieval(retrieve);
  const session = await createSession({ retrieve: requestRetrieval });
  if (!session) return { status: "model_unconfigured" };
  try {
    const prompt = `${notebookSystemPrompt(transcription)}\n\n只返回 JSON，不要 Markdown。kind 只能为 evidence、clarification 或 evidence_gap。evidence 必须提供 sourceIds 与 path；clarification 必须提供 text 与至少两个 candidates；association 如有必须以文化联想表达，不能陈述事实。`;
    const images = image ? [{ type: "image", data: image.data, mimeType: image.mimeType }] : undefined;
    await session.prompt(prompt, { images });
    await session.waitForIdle();
    const graph = await requestRetrieval(transcription);
    return { status: "ok", outcome: normalizeSeekOutcome({ transcription: transcription.trim(), raw: textFromLastAssistant(session), graph }) };
  } finally {
    session.dispose();
  }
}
