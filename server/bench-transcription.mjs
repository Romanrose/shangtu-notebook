import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { benchmarkTranscription, summarizeTranscriptionBenchmark } from "./transcription-benchmark.mjs";
import { transcriptionBenchmarkCases } from "./fixtures/transcription-benchmark.mjs";
import { transcribeInk } from "./transcription-adapter.mjs";

async function loadCases(manifestPath) {
  if (!manifestPath) return transcriptionBenchmarkCases;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(manifest) || !manifest.length) throw new Error("TRANSCRIPTION_BENCHMARK_MANIFEST 必须是非空 JSON 数组。");
  const manifestRoot = resolve(dirname(manifestPath));
  return Promise.all(manifest.map(async (sample) => {
    if (!sample?.id || !sample.expected || !sample.imagePath || extname(sample.imagePath).toLowerCase() !== ".png") {
      throw new Error("每条实验样本必须包含 id、expected 和 PNG imagePath。");
    }
    const imagePath = resolve(dirname(manifestPath), sample.imagePath);
    if (imagePath !== manifestRoot && !imagePath.startsWith(`${manifestRoot}/`)) throw new Error("实验样本 imagePath 必须位于清单目录内。");
    if (sample.metadata !== undefined && (!sample.metadata || typeof sample.metadata !== "object" || Array.isArray(sample.metadata))) throw new Error("实验样本 metadata 必须是对象。");
    const metadata = Object.fromEntries(Object.entries(sample.metadata ?? {}).filter(([key, value]) => ["writer", "inputMode", "orientation", "textType"].includes(key)).map(([key, value]) => {
      if (typeof value !== "string" || value.length > 40) throw new Error("实验样本 metadata 只能包含不超过 40 字符的字符串。");
      return [key, value];
    }));
    const data = (await readFile(imagePath)).toString("base64");
    return { id: sample.id, expected: sample.expected, ...(Object.keys(metadata).length ? { metadata } : {}), image: { mimeType: "image/png", data: `data:image/png;base64,${data}` } };
  }));
}

const provider = process.env.TRANSCRIPTION_BENCH_PROVIDER ?? process.env.VISION_MODEL_PROVIDER ?? "fixture";
const providers = (process.env.TRANSCRIPTION_BENCH_PROVIDERS ?? provider).split(",").map((value) => value.trim()).filter(Boolean);
const manifestPath = process.env.TRANSCRIPTION_BENCHMARK_MANIFEST;
if (!providers.length || providers.some((candidate) => !["fixture", "paddleocr", "paddleocr-vl", "vlm-openai-compatible"].includes(candidate))) throw new Error(`暂不支持实验 provider: ${providers.join(",")}`);
if (providers.some((candidate) => candidate !== "fixture") && !manifestPath) throw new Error("真实转写实验必须提供 TRANSCRIPTION_BENCHMARK_MANIFEST；不会使用合同夹具冒充真实样本。");
const cases = await loadCases(manifestPath);
const runs = Number(process.env.TRANSCRIPTION_BENCH_RUNS ?? 3);
if (!Number.isInteger(runs) || runs < 1) throw new Error("TRANSCRIPTION_BENCH_RUNS 必须是正整数。");
const warmup = Number(process.env.TRANSCRIPTION_BENCH_WARMUP ?? 0);
if (!Number.isInteger(warmup) || warmup < 0) throw new Error("TRANSCRIPTION_BENCH_WARMUP 必须是非负整数。");
const showText = process.env.TRANSCRIPTION_BENCH_SHOW_TEXT === "1";
const reports = [];
for (const candidate of providers) {
  const report = await benchmarkTranscription({
    cases,
    runs,
    warmup,
    transcribe: ({ image }) => candidate === "fixture"
      ? transcribeInk({ image, fixtureMode: true })
      : transcribeInk({ image, provider: candidate, modelId: process.env.VISION_MODEL_ID ?? (candidate === "paddleocr" ? "PP-OCRv5" : candidate === "paddleocr-vl" ? "PaddleOCR-VL-0.9B" : undefined) }),
  });
  const summary = summarizeTranscriptionBenchmark(report);
  reports.push({ provider: candidate, samples: cases.length, runs, warmup, summary, results: report });
  console.log(`Provider: ${candidate}; samples: ${cases.length}; runs: ${runs}; warmup: ${warmup}`);
  console.log("Summary:", summary);
  console.table(report.map(({ expected, actual, ...summary }) => showText ? { ...summary, expected, actual } : summary));
  if (candidate === "fixture") console.log("Contract fixture only: this does not measure real handwriting recognition accuracy.");
}
const outputPath = process.env.TRANSCRIPTION_BENCH_OUTPUT;
if (outputPath) {
  await writeFile(outputPath, `${JSON.stringify({ providers, samples: cases.length, runs, warmup, reports }, null, 2)}\n`, "utf8");
  console.log(`Report written to: ${outputPath}`);
}
