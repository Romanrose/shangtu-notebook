import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { benchmarkTranscription } from "./transcription-benchmark.mjs";
import { transcriptionBenchmarkCases } from "./fixtures/transcription-benchmark.mjs";
import { transcribeInk } from "./transcription-adapter.mjs";

async function loadCases(manifestPath) {
  if (!manifestPath) return transcriptionBenchmarkCases;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(manifest) || !manifest.length) throw new Error("TRANSCRIPTION_BENCHMARK_MANIFEST 必须是非空 JSON 数组。");
  return Promise.all(manifest.map(async (sample) => {
    if (!sample?.id || !sample.expected || !sample.imagePath || extname(sample.imagePath).toLowerCase() !== ".png") {
      throw new Error("每条实验样本必须包含 id、expected 和 PNG imagePath。");
    }
    const imagePath = resolve(dirname(manifestPath), sample.imagePath);
    const data = (await readFile(imagePath)).toString("base64");
    return { id: sample.id, expected: sample.expected, image: { mimeType: "image/png", data: `data:image/png;base64,${data}` } };
  }));
}

const provider = process.env.TRANSCRIPTION_BENCH_PROVIDER ?? process.env.VISION_MODEL_PROVIDER ?? "fixture";
const manifestPath = process.env.TRANSCRIPTION_BENCHMARK_MANIFEST;
if (provider !== "fixture" && provider !== "paddleocr") throw new Error(`暂不支持实验 provider: ${provider}`);
if (provider === "paddleocr" && !manifestPath) throw new Error("真实 PaddleOCR 实验必须提供 TRANSCRIPTION_BENCHMARK_MANIFEST；不会使用合同夹具冒充真实样本。");
const cases = await loadCases(manifestPath);
const runs = Number(process.env.TRANSCRIPTION_BENCH_RUNS ?? 3);
if (!Number.isInteger(runs) || runs < 1) throw new Error("TRANSCRIPTION_BENCH_RUNS 必须是正整数。");
const report = await benchmarkTranscription({
  cases,
  runs,
  transcribe: ({ image }) => provider === "fixture"
    ? transcribeInk({ image, fixtureMode: true })
    : transcribeInk({ image, provider, modelId: process.env.VISION_MODEL_ID ?? "PP-OCRv5" }),
});

console.log(`Provider: ${provider}; samples: ${cases.length}; runs: ${runs}`);
console.table(report.map(({ expected, actual, ...summary }) => summary));
if (provider === "fixture") console.log("Contract fixture only: this does not measure real handwriting recognition accuracy.");
