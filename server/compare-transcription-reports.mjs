import { readFile, writeFile } from "node:fs/promises";

const PROVIDERS = new Set(["fixture", "huawei-handwriting", "paddleocr", "paddleocr-vl", "tesseract", "vlm-openai-compatible"]);
const EVIDENCE_VALUES = new Set(["unknown", "public_casia", "consented_user"]);
const PREPROCESSING_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateTimingSummary(summary) {
  if (!summary || summary.schema !== "shangtu-transcription-timing-summary-v1" || !Number.isInteger(summary.trials) || summary.trials < 1 || !Array.isArray(summary.sampleIds) || summary.sampleIdCoverage !== 1 || new Set(summary.sampleIds).size !== summary.sampleIds.length || summary.sampleIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9]{12}$/.test(id)) || !Array.isArray(summary.byProviderStatus)) {
    throw new Error("timing summary 必须完整覆盖唯一的 12 位 sampleId，且使用有效 schema。");
  }
  if (summary.provider !== undefined && (typeof summary.provider !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(summary.provider))) throw new Error("timing summary provider 标签无效。");
  for (const group of summary.byProviderStatus) {
    if (typeof group?.provider !== "string" || !Number.isInteger(group.trials) || group.trials < 1 || !group.confirmation || !Number.isInteger(group.confirmation.count) || group.confirmation.count < 0 || !finite(group.confirmationAvailableRate) || group.confirmationAvailableRate < 0 || group.confirmationAvailableRate > 1 || (group.editedConfirmationRate !== null && (!finite(group.editedConfirmationRate) || group.editedConfirmationRate < 0 || group.editedConfirmationRate > 1))) throw new Error("timing summary 缺少有效 provider 确认/修改率。");
    if (summary.provider !== undefined && group.provider !== summary.provider) throw new Error("timing summary 顶层 provider 与分组 provider 不一致。");
  }
  return summary;
}

function validateReport(report) {
  if (!report || !Array.isArray(report.reports) || !report.reports.length) throw new Error("比较输入必须包含非空 reports 数组。");
  if (report.evidence !== undefined && !EVIDENCE_VALUES.has(report.evidence)) throw new Error("benchmark 报告 evidence 无效。");
  if (report.cohortId !== undefined && (typeof report.cohortId !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(report.cohortId))) throw new Error("benchmark 报告 cohortId 无效。");
  if (report.consent !== undefined && report.consent !== "confirmed") throw new Error("benchmark 报告 consent 必须是 confirmed。");
  if (report.preprocessing !== undefined && (typeof report.preprocessing !== "string" || !PREPROCESSING_PATTERN.test(report.preprocessing))) throw new Error("benchmark 报告 preprocessing 无效。");
  if (report.runId !== undefined && (typeof report.runId !== "string" || !PREPROCESSING_PATTERN.test(report.runId))) throw new Error("benchmark 报告 runId 无效。");
  const providers = report.reports.map((entry) => entry?.provider);
  if (new Set(providers).size !== providers.length) throw new Error("benchmark 报告不能重复包含同一个 provider。");
  for (const entry of report.reports) {
    if (!PROVIDERS.has(entry.provider) || !Number.isInteger(entry.samples) || entry.samples < 1 || !Number.isInteger(entry.runs) || entry.runs < 1 || !Number.isInteger(entry.warmup) || entry.warmup < 0 || !entry.summary || !Array.isArray(entry.results) || entry.results.length !== entry.samples) {
      throw new Error("provider 报告缺少有效 provider、cohort 或 results。");
    }
    const summary = entry.summary;
    if (!finite(summary.meanOkRate) || !summary.statusCounts || typeof summary.statusCounts !== "object") throw new Error("provider 报告缺少可用率或状态计数。");
    const ids = entry.results.map((result) => result?.id);
    if (ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) throw new Error("provider 报告 results 必须包含唯一样本 id。");
  }
  return report;
}

function compareTranscriptionReports(reports, { evidence, timingSummaries = [] } = {}) {
  if (!Array.isArray(reports) || !reports.length) throw new Error("至少需要一份 provider 报告。");
  const validated = reports.map(validateReport);
  const reportEvidences = new Set(validated.map((report) => report.evidence ?? "unknown"));
  if (reportEvidences.size !== 1) throw new Error("provider 报告必须使用相同 evidence，不能混合证据等级。");
  const reportEvidence = [...reportEvidences][0];
  if (evidence !== undefined && evidence !== reportEvidence) throw new Error("--evidence 与 benchmark 报告内的 evidence 不一致，不能重标样本来源。");
  const reportCohortIds = new Set(validated.map((report) => report.cohortId ?? null));
  if (reportCohortIds.size !== 1) throw new Error("provider 报告必须使用相同 cohortId，不能混合样本来源。");
  const cohortId = [...reportCohortIds][0];
  const preprocessingValues = new Set(validated.map((report) => report.preprocessing ?? "unknown"));
  if (preprocessingValues.size !== 1) throw new Error("provider 报告必须使用相同 preprocessing，不能混合输入预处理。");
  const preprocessing = [...preprocessingValues][0];
  const runIds = new Set(validated.map((report) => report.runId ?? "unknown"));
  if (runIds.size !== 1) throw new Error("provider 报告必须使用相同 runId，不能混合不同实验轮次。");
  const runId = [...runIds][0];
  const consentStates = new Set(validated.map((report) => report.consent ?? null));
  if (consentStates.size !== 1) throw new Error("provider 报告必须使用相同 consent 状态，不能混合样本授权记录。");
  const consent = [...consentStates][0];
  const cohorts = new Set(validated.flatMap((report) => report.reports.map((entry) => `${entry.samples}:${entry.runs}:${entry.warmup}`)));
  if (cohorts.size !== 1) throw new Error("provider 报告必须使用相同 samples、runs 和 warmup，不能混合 cohort。");
  const sampleSets = new Set(validated.flatMap((report) => report.reports.map((entry) => JSON.stringify(entry.results.map((result) => result.id)))));
  if (sampleSets.size !== 1) throw new Error("provider 报告必须使用相同且顺序一致的样本 id，不能混合 cohort。");
  if (!Array.isArray(timingSummaries)) throw new Error("timingSummaries 必须是数组。");
  const benchmarkSampleIds = validated[0].reports[0].results.map((result) => result.id);
  const timingByProvider = new Map();
  for (const rawSummary of timingSummaries) {
    const summary = validateTimingSummary(rawSummary);
    if (JSON.stringify(summary.sampleIds) !== JSON.stringify(benchmarkSampleIds)) throw new Error("timing summary 必须使用与 benchmark 相同且顺序一致的 sampleId。");
    const providerGroups = new Map();
    for (const group of summary.byProviderStatus) {
      const current = providerGroups.get(group.provider) ?? { trials: 0, confirmationCount: 0, editedCount: 0, editedKnown: true };
      current.trials += group.trials;
      current.confirmationCount += group.confirmation.count;
      if (group.editedConfirmationRate === null) current.editedKnown = current.editedKnown && group.confirmation.count === 0;
      else current.editedCount += group.editedConfirmationRate * group.confirmation.count;
      providerGroups.set(group.provider, current);
    }
    for (const [provider, metrics] of providerGroups) {
      if (timingByProvider.has(provider)) throw new Error("timing summary 不能重复提供同一 provider。");
      timingByProvider.set(provider, {
        confirmationAvailableRate: metrics.trials ? metrics.confirmationCount / metrics.trials : null,
        editedConfirmationRate: metrics.confirmationCount && metrics.editedKnown ? metrics.editedCount / metrics.confirmationCount : null,
      });
    }
  }
  const entries = validated.flatMap((report) => report.reports.map((entry) => {
    const qualityAvailable = finite(entry.summary.meanCharacterErrorRate) && finite(entry.summary.sampleExactStableRate) && finite(entry.summary.sampleCandidateHitStableRate);
    const timing = timingByProvider.get(entry.provider) ?? null;
    return {
      provider: entry.provider,
      samples: entry.samples,
      runs: entry.runs,
      warmup: entry.warmup,
      evidence: reportEvidence,
      rankable: reportEvidence === "consented_user" && consent === "confirmed" && qualityAvailable && timingSummaries.length > 0 && timing?.confirmationAvailableRate !== null && timing?.editedConfirmationRate !== null,
      meanOkRate: entry.summary.meanOkRate,
      meanCharacterErrorRate: qualityAvailable ? entry.summary.meanCharacterErrorRate : null,
      sampleExactStableRate: qualityAvailable ? entry.summary.sampleExactStableRate : null,
      sampleCandidateHitStableRate: qualityAvailable ? entry.summary.sampleCandidateHitStableRate : null,
      meanP50Ms: finite(entry.summary.meanP50Ms) ? entry.summary.meanP50Ms : null,
      meanP95Ms: finite(entry.summary.meanP95Ms) ? entry.summary.meanP95Ms : null,
      confirmationAvailableRate: timing?.confirmationAvailableRate ?? null,
      editedConfirmationRate: timing?.editedConfirmationRate ?? null,
      statusCounts: entry.summary.statusCounts,
    };
  }));
  const ranked = entries.filter((entry) => entry.rankable).sort((left, right) => (left.meanCharacterErrorRate - right.meanCharacterErrorRate) || (right.sampleExactStableRate - left.sampleExactStableRate) || (left.editedConfirmationRate - right.editedConfirmationRate) || (left.meanP50Ms - right.meanP50Ms));
  return {
    schema: "shangtu-transcription-comparison-v1",
    evidence: reportEvidence,
    cohort: { samples: validated[0].reports[0].samples, runs: validated[0].reports[0].runs, warmup: validated[0].reports[0].warmup, preprocessing, runId, ...(cohortId ? { id: cohortId } : {}) },
    ...(consent ? { consent } : {}),
    decision: ranked.length ? { status: "rankable", recommendedProvider: ranked[0].provider } : { status: "insufficient_evidence", recommendedProvider: null },
    providers: entries,
  };
}

function parseArgs(argv) {
  const inputs = [];
  let output;
  let evidence;
  const timingInputs = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--input" && argv[index + 1]) inputs.push(argv[++index]);
    else if (argv[index] === "--timing" && argv[index + 1]) timingInputs.push(argv[++index]);
    else if (argv[index] === "--output" && argv[index + 1]) output = argv[++index];
    else if (argv[index] === "--evidence" && argv[index + 1]) evidence = argv[++index];
    else throw new Error("用法：--input report-a.json [--input report-b.json] [--timing timing-summary.json] [--evidence public_casia|consented_user]");
  }
  if (!inputs.length) throw new Error("至少需要一个 --input provider 报告。");
  if (evidence !== undefined && !EVIDENCE_VALUES.has(evidence)) throw new Error("--evidence 必须是 unknown、public_casia 或 consented_user。");
  return { inputs, timingInputs, output, evidence };
}

export { compareTranscriptionReports, validateReport };

if (import.meta.main) {
  const { inputs, timingInputs, output, evidence } = parseArgs(process.argv.slice(2));
  const reports = await Promise.all(inputs.map(async (input) => JSON.parse(await readFile(input, "utf8"))));
  const timingSummaries = await Promise.all(timingInputs.map(async (input) => JSON.parse(await readFile(input, "utf8"))));
  const comparison = compareTranscriptionReports(reports, { evidence, timingSummaries });
  const serialized = `${JSON.stringify(comparison, null, 2)}\n`;
  if (output) await writeFile(output, serialized, "utf8");
  console.log(serialized.trim());
  if (output) console.log(`Comparison written to: ${output}`);
}
