import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { benchmarkTranscription, summarizeTranscriptionBenchmark } from "./transcription-benchmark.mjs";
import { transcriptionBenchmarkCases } from "./fixtures/transcription-benchmark.mjs";
import { transcribeInk } from "./transcription-adapter.mjs";
import { validateConsentedUserCases } from "./transcription-manifest-contract.mjs";

const EVIDENCE_VALUES = new Set(["unknown", "public_casia", "consented_user"]);
const PREPROCESSING_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

async function loadCases(manifestPath, { allowUnlabeled = false } = {}) {
  if (!manifestPath) return transcriptionBenchmarkCases;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(manifest) || !manifest.length) throw new Error("TRANSCRIPTION_BENCHMARK_MANIFEST 必须是非空 JSON 数组。");
  const manifestRoot = resolve(dirname(manifestPath));
  return Promise.all(manifest.map(async (sample) => {
    if (!sample?.id || (!allowUnlabeled && !sample.expected) || (allowUnlabeled && sample.expected !== undefined && typeof sample.expected !== "string") || !sample.imagePath || extname(sample.imagePath).toLowerCase() !== ".png") {
      throw new Error(allowUnlabeled ? "每条实验样本必须包含 id 和 PNG imagePath；expected 可选。" : "每条实验样本必须包含 id、expected 和 PNG imagePath。");
    }
    const imagePath = resolve(dirname(manifestPath), sample.imagePath);
    if (imagePath !== manifestRoot && !imagePath.startsWith(`${manifestRoot}/`)) throw new Error("实验样本 imagePath 必须位于清单目录内。");
    if (sample.metadata !== undefined && (!sample.metadata || typeof sample.metadata !== "object" || Array.isArray(sample.metadata))) throw new Error("实验样本 metadata 必须是对象。");
    const metadata = Object.fromEntries(Object.entries(sample.metadata ?? {}).filter(([key, value]) => ["writer", "inputMode", "orientation", "textType", "evidence", "cohortId", "consent"].includes(key)).map(([key, value]) => {
      if (typeof value !== "string" || value.length > 40) throw new Error("实验样本 metadata 只能包含不超过 40 字符的字符串。");
      return [key, value];
    }));
    if (metadata.evidence !== undefined && !EVIDENCE_VALUES.has(metadata.evidence)) throw new Error("实验样本 metadata.evidence 必须是 unknown、public_casia 或 consented_user。");
    if (metadata.cohortId !== undefined && !/^[A-Za-z0-9._-]{1,80}$/.test(metadata.cohortId)) throw new Error("实验样本 metadata.cohortId 无效。");
    const data = (await readFile(imagePath)).toString("base64");
    return { id: sample.id, ...(sample.expected !== undefined ? { expected: sample.expected } : {}), ...(Object.keys(metadata).length ? { metadata } : {}), image: { mimeType: "image/png", data: `data:image/png;base64,${data}` } };
  }));
}

const provider = process.env.TRANSCRIPTION_BENCH_PROVIDER ?? process.env.VISION_MODEL_PROVIDER ?? "fixture";
const providers = (process.env.TRANSCRIPTION_BENCH_PROVIDERS ?? provider).split(",").map((value) => value.trim()).filter(Boolean);
const manifestPath = process.env.TRANSCRIPTION_BENCHMARK_MANIFEST;
if (!providers.length || providers.some((candidate) => !["fixture", "deepseek-vision", "huawei-handwriting", "paddleocr", "paddleocr-vl", "tesseract", "vlm-openai-compatible"].includes(candidate))) throw new Error(`暂不支持实验 provider: ${providers.join(",")}`);
if (providers.some((candidate) => candidate !== "fixture") && !manifestPath) throw new Error("真实转写实验必须提供 TRANSCRIPTION_BENCHMARK_MANIFEST；不会使用合同夹具冒充真实样本。");
const allowUnlabeled = process.env.TRANSCRIPTION_BENCHMARK_UNLABELED === "1";
const cases = await loadCases(manifestPath, { allowUnlabeled });
const manifestEvidence = new Set(cases.map((sample) => sample.metadata?.evidence).filter(Boolean));
const manifestCohortIds = new Set(cases.map((sample) => sample.metadata?.cohortId).filter(Boolean));
const manifestConsents = new Set(cases.map((sample) => sample.metadata?.consent).filter(Boolean));
if (manifestEvidence.size > 1) throw new Error("实验清单不能混合不同 evidence。");
if (manifestCohortIds.size > 1) throw new Error("实验清单不能混合不同 cohortId。");
if (manifestConsents.size > 1) throw new Error("实验清单不能混合不同 consent 状态。");
const requestedEvidence = process.env.TRANSCRIPTION_BENCH_EVIDENCE;
if (requestedEvidence !== undefined && !EVIDENCE_VALUES.has(requestedEvidence)) throw new Error("TRANSCRIPTION_BENCH_EVIDENCE 必须是 unknown、public_casia 或 consented_user。");
const evidence = requestedEvidence ?? [...manifestEvidence][0] ?? "unknown";
if (manifestEvidence.size && evidence !== [...manifestEvidence][0]) throw new Error("TRANSCRIPTION_BENCH_EVIDENCE 与 manifest metadata.evidence 不一致。");
const cohortId = [...manifestCohortIds][0] ?? null;
const consent = [...manifestConsents][0] ?? null;
const requestedCohortId = process.env.TRANSCRIPTION_BENCH_COHORT_ID;
if (requestedCohortId !== undefined && (!/^[A-Za-z0-9._-]{1,80}$/.test(requestedCohortId) || requestedCohortId !== cohortId)) throw new Error("TRANSCRIPTION_BENCH_COHORT_ID 必须与 manifest metadata.cohortId 一致。");
const preprocessing = process.env.TRANSCRIPTION_BENCH_PREPROCESSING ?? "unknown";
if (!PREPROCESSING_PATTERN.test(preprocessing)) throw new Error("TRANSCRIPTION_BENCH_PREPROCESSING 必须是 1–80 位安全标签。");
const runId = process.env.TRANSCRIPTION_BENCH_RUN_ID ?? "unknown";
if (!PREPROCESSING_PATTERN.test(runId)) throw new Error("TRANSCRIPTION_BENCH_RUN_ID 必须是 1–80 位安全标签。");
if (evidence === "consented_user") {
  if (!manifestPath || allowUnlabeled || manifestEvidence.size !== 1 || !cohortId || consent !== "confirmed") throw new Error("consented_user 实验必须使用已标注 manifest，并在每条样本中声明 evidence、cohortId 和 consent=confirmed。");
  validateConsentedUserCases(cases);
}
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
      : transcribeInk({ image, provider: candidate, modelId: process.env.VISION_MODEL_ID ?? (candidate === "deepseek-vision" ? "deepseek-v4-flash-vision-exp" : candidate === "huawei-handwriting" ? "handwriting-v1" : candidate === "paddleocr" ? "PP-OCRv5" : candidate === "paddleocr-vl" ? "PaddleOCR-VL-0.9B" : candidate === "tesseract" ? (process.env.TESSERACT_LANG ?? "chi_sim") : undefined) }),
  });
  const summary = summarizeTranscriptionBenchmark(report);
  const reportOutput = showText ? report : report.map(({ expected, actual, ...result }) => result);
  reports.push({ provider: candidate, samples: cases.length, runs, warmup, summary, results: reportOutput });
  console.log(`Provider: ${candidate}; samples: ${cases.length}; runs: ${runs}; warmup: ${warmup}`);
  console.log("Summary:", summary);
  console.table(report.map(({ expected, actual, ...summary }) => showText ? { ...summary, expected, actual } : summary));
  if (candidate === "fixture") console.log("Contract fixture only: this does not measure real handwriting recognition accuracy.");
}
const outputPath = process.env.TRANSCRIPTION_BENCH_OUTPUT;
if (outputPath) {
  await writeFile(outputPath, `${JSON.stringify({ schema: "shangtu-transcription-benchmark-v1", providers, samples: cases.length, runs, warmup, evidence, preprocessing, runId, textIncluded: showText, ...(cohortId ? { cohortId } : {}), ...(consent ? { consent } : {}), reports }, null, 2)}\n`, "utf8");
  console.log(`Report written to: ${outputPath}`);
}
