import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { validateTimingPayload } from "./summarize-transcription-timings.mjs";

const SAMPLE_ID_PATTERN = /^[A-Za-z0-9]{12}$/;
const COHORT_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
const PROVIDER_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;

function validateManifest(manifest) {
  if (!Array.isArray(manifest) || !manifest.length) throw new Error("consented_user manifest 必须是非空数组。");
  const ids = [];
  const cohortIds = new Set();
  for (const [index, sample] of manifest.entries()) {
    const metadata = sample?.metadata;
    if (!sample || typeof sample.id !== "string" || !SAMPLE_ID_PATTERN.test(sample.id) || typeof sample.expected !== "string" || !sample.expected.trim() || sample.expected.trim().length > 240 || typeof sample.imagePath !== "string" || extname(sample.imagePath).toLowerCase() !== ".png") {
      throw new Error(`consented_user manifest 第 ${index + 1} 条样本必须包含 12 位 sampleId、PNG imagePath 和人工校对文本。`);
    }
    if (metadata?.evidence !== "consented_user" || typeof metadata.cohortId !== "string" || !COHORT_ID_PATTERN.test(metadata.cohortId) || metadata.consent !== "confirmed") {
      throw new Error(`consented_user manifest 第 ${index + 1} 条样本必须声明 evidence=consented_user、有效 cohortId 和 consent=confirmed。`);
    }
    ids.push(sample.id);
    cohortIds.add(metadata.cohortId);
  }
  if (new Set(ids).size !== ids.length) throw new Error("consented_user manifest 包含重复 sampleId。");
  if (cohortIds.size !== 1) throw new Error("consented_user manifest 不能混合不同 cohortId。");
  return { ids, cohortId: [...cohortIds][0] };
}

export function validateTranscriptionCohort({ manifest, timingPayloads, provider } = {}) {
  const { ids, cohortId } = validateManifest(manifest);
  if (!Array.isArray(timingPayloads) || timingPayloads.length !== ids.length) throw new Error("timing 文件必须与 manifest 样本一一对应。");
  if (provider !== undefined && (typeof provider !== "string" || !PROVIDER_PATTERN.test(provider))) throw new Error("preflight provider 标签无效。");
  const seenTimingIds = new Set();
  const providerLabels = new Set();
  let resultCount = 0;
  let confirmationCount = 0;
  let editedCount = 0;
  for (const [index, payload] of timingPayloads.entries()) {
    validateTimingPayload(payload);
    if (typeof payload.sampleId !== "string" || !SAMPLE_ID_PATTERN.test(payload.sampleId)) throw new Error(`timing 文件第 ${index + 1} 条缺少有效 sampleId。`);
    if (seenTimingIds.has(payload.sampleId)) throw new Error("timing 文件包含重复 sampleId。");
    if (payload.sampleId !== ids[index]) throw new Error("timing 文件顺序必须与 manifest sampleId 顺序一致。");
    seenTimingIds.add(payload.sampleId);
    const result = payload.timings.find((timing) => timing.event === "transcription_result");
    const confirmation = payload.timings.find((timing) => timing.event === "transcription_confirmed");
    if (result?.status === "ok") {
      resultCount += 1;
      if (!result.provider || !PROVIDER_PATTERN.test(result.provider)) throw new Error("成功 transcription_result 必须包含有效 provider 标签。");
      if (provider !== undefined && result.provider !== provider) throw new Error("timing provider 与 preflight provider 不一致。");
      providerLabels.add(result.provider);
    }
    if (confirmation) {
      confirmationCount += 1;
      if (confirmation.edited) editedCount += 1;
    }
  }
  const comparisonReady = resultCount === ids.length && confirmationCount === ids.length && (provider === undefined ? providerLabels.size === 1 : providerLabels.size === 1 && providerLabels.has(provider));
  return {
    schema: "shangtu-transcription-cohort-preflight-v1",
    status: comparisonReady ? "ready" : "needs_result_or_confirmation",
    evidence: "consented_user",
    cohortId,
    samples: ids.length,
    sampleIds: ids,
    provider: provider ?? (providerLabels.size === 1 ? [...providerLabels][0] : null),
    timingSampleIdCoverage: 1,
    resultAvailableRate: resultCount / ids.length,
    confirmationAvailableRate: confirmationCount / ids.length,
    editedConfirmationRate: confirmationCount ? editedCount / confirmationCount : null,
    comparisonReady,
    textIncluded: false,
  };
}

async function loadManifest(manifestPath) {
  const manifestRoot = resolve(dirname(manifestPath));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const sample of manifest) {
    const imagePath = resolve(manifestRoot, sample?.imagePath ?? "");
    if (imagePath !== manifestRoot && !imagePath.startsWith(`${manifestRoot}/`)) throw new Error("manifest imagePath 必须位于清单目录内。");
    if (extname(imagePath).toLowerCase() !== ".png") throw new Error("manifest imagePath 必须是 PNG。");
    await stat(imagePath);
  }
  return manifest;
}

function parseArgs(argv) {
  let manifestPath;
  let output;
  let provider;
  const timingPaths = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--manifest" && argv[index + 1]) manifestPath = argv[++index];
    else if (argv[index] === "--timing" && argv[index + 1]) timingPaths.push(argv[++index]);
    else if (argv[index] === "--provider" && argv[index + 1]) provider = argv[++index];
    else if (argv[index] === "--output" && argv[index + 1]) output = argv[++index];
    else throw new Error("用法：--manifest manifest.json --timing timing-a.json [--timing timing-b.json] [--provider paddleocr] [--output report.json]");
  }
  if (!manifestPath || !timingPaths.length) throw new Error("必须提供 --manifest 和至少一个 --timing；不会读取默认目录。");
  return { manifestPath, timingPaths, provider, output };
}

export { validateManifest };

if (import.meta.main) {
  const { manifestPath, timingPaths, provider, output } = parseArgs(process.argv.slice(2));
  const manifest = await loadManifest(manifestPath);
  const timingPayloads = await Promise.all(timingPaths.map(async (path) => JSON.parse(await readFile(resolve(path), "utf8"))));
  const result = validateTranscriptionCohort({ manifest, timingPayloads, provider });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (output) await writeFile(resolve(output), serialized, "utf8");
  console.log(serialized.trim());
  if (output) console.log(`Preflight written to: ${resolve(output)}`);
}
