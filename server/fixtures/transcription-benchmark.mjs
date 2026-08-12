import { fixtureTranscription } from "../transcription-adapter.mjs";

// Contract-only sample. It contains no user handwriting and cannot establish
// real recognition accuracy; consented ink samples are added later.
export const transcriptionBenchmarkCases = [{
  id: "fixture-li-bai-question",
  expected: fixtureTranscription,
  image: { mimeType: "image/png", data: "data:image/png;base64,iVBORw0KGgo=" },
}];
