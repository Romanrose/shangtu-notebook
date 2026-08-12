import { retrieveFixture } from "./cnkgraph-fixture.mjs";
import { runSeek } from "./run-seek.mjs";

function fixtureProposal(transcription) {
  if (/李贺|李賀/.test(transcription)) {
    return { kind: "clarification", text: "这页提到的是哪一位诗人？", candidates: ["李白", "李贺"] };
  }
  if (/李白|太白|青莲/.test(transcription)) {
    return { kind: "evidence", sourceIds: ["source:jiangjinjiu-li-bai"], path: ["李白", "作者", "将进酒"] };
  }
  return { kind: "evidence_gap", text: "当前演练图谱没有这条可核验的直接关联。" };
}

function createFixtureSession(transcription) {
  const messages = [];
  return {
    messages,
    async prompt() {
      messages.push({ role: "assistant", content: [{ type: "text", text: JSON.stringify(fixtureProposal(transcription)) }] });
    },
    async waitForIdle() {},
    dispose() {},
  };
}

/** Development rehearsal only: no model or network call is made in this path. */
export function runFixtureSeek({ transcription, image }) {
  return runSeek({ transcription, image, createSession: async () => createFixtureSession(transcription), retrieve: retrieveFixture });
}
