import { benchmarkTranscription } from "./transcription-benchmark.mjs";
import { transcriptionBenchmarkCases } from "./fixtures/transcription-benchmark.mjs";
import { transcribeInk } from "./transcription-adapter.mjs";

const report = await benchmarkTranscription({
  cases: transcriptionBenchmarkCases,
  transcribe: ({ image }) => transcribeInk({ image, fixtureMode: true }),
});

console.table(report.map(({ expected, actual, ...summary }) => summary));
console.log("Contract fixture only: this does not measure real handwriting recognition accuracy.");
