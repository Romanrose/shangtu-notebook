import { readFile, writeFile } from "node:fs/promises";

const PROVIDERS = new Set(["fixture", "paddleocr", "paddleocr-vl", "tesseract", "vlm-openai-compatible"]);
const EVIDENCE_VALUES = new Set(["unknown", "public_casia", "consented_user"]);

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateReport(report) {
  if (!report || !Array.isArray(report.reports) || !report.reports.length) throw new Error("比较输入必须包含非空 reports 数组。");
  if (report.evidence !== undefined && !EVIDENCE_VALUES.has(report.evidence)) throw new Error("benchmark 报告 evidence 无效。");
  if (report.cohortId !== undefined && (typeof report.cohortId !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(report.cohortId))) throw new Error("benchmark 报告 cohortId 无效。");
  for (const entry of report.reports) {
    if (!PROVIDERS.has(entry.provider) || !Number.isInteger(entry.samples) || entry.samples < 1 || !Number.isInteger(entry.runs) || entry.runs < 1 || !Number.isInteger(entry.warmup) || entry.warmup < 0 || !entry.summary || !Array.isArray(entry.results) || entry.results.length !== entry.samples) {
      throw new Error("provider 报告缺少有效 provider、cohort 或 results。");
    }
    const summary = entry.summary;
    if (!finite(summary.meanOkRate) || !summary.statusCounts || typeof summary.statusCounts !== "object") throw new Error("provider 报告缺少可用率或状态计数。");
  }
  return report;
}

function compareTranscriptionReports(reports, { evidence } = {}) {
  if (!Array.isArray(reports) || !reports.length) throw new Error("至少需要一份 provider 报告。");
  const validated = reports.map(validateReport);
  const reportEvidences = new Set(validated.map((report) => report.evidence ?? "unknown"));
  if (reportEvidences.size !== 1) throw new Error("provider 报告必须使用相同 evidence，不能混合证据等级。");
  const reportEvidence = [...reportEvidences][0];
  if (evidence !== undefined && evidence !== reportEvidence) throw new Error("--evidence 与 benchmark 报告内的 evidence 不一致，不能重标样本来源。");
  const reportCohortIds = new Set(validated.map((report) => report.cohortId ?? null));
  if (reportCohortIds.size !== 1) throw new Error("provider 报告必须使用相同 cohortId，不能混合样本来源。");
  const cohortId = [...reportCohortIds][0];
  const cohorts = new Set(validated.flatMap((report) => report.reports.map((entry) => `${entry.samples}:${entry.runs}:${entry.warmup}`)));
  if (cohorts.size !== 1) throw new Error("provider 报告必须使用相同 samples、runs 和 warmup，不能混合 cohort。");
  const entries = validated.flatMap((report) => report.reports.map((entry) => {
    const qualityAvailable = finite(entry.summary.meanCharacterErrorRate) && finite(entry.summary.sampleExactStableRate) && finite(entry.summary.sampleCandidateHitStableRate);
    return {
      provider: entry.provider,
      samples: entry.samples,
      runs: entry.runs,
      warmup: entry.warmup,
      evidence: reportEvidence,
      rankable: reportEvidence === "consented_user" && qualityAvailable,
      meanOkRate: entry.summary.meanOkRate,
      meanCharacterErrorRate: qualityAvailable ? entry.summary.meanCharacterErrorRate : null,
      sampleExactStableRate: qualityAvailable ? entry.summary.sampleExactStableRate : null,
      sampleCandidateHitStableRate: qualityAvailable ? entry.summary.sampleCandidateHitStableRate : null,
      meanP50Ms: finite(entry.summary.meanP50Ms) ? entry.summary.meanP50Ms : null,
      meanP95Ms: finite(entry.summary.meanP95Ms) ? entry.summary.meanP95Ms : null,
      statusCounts: entry.summary.statusCounts,
    };
  }));
  const ranked = entries.filter((entry) => entry.rankable).sort((left, right) => (left.meanCharacterErrorRate - right.meanCharacterErrorRate) || (right.sampleExactStableRate - left.sampleExactStableRate) || (left.meanP50Ms - right.meanP50Ms));
  return {
    schema: "shangtu-transcription-comparison-v1",
    evidence: reportEvidence,
    cohort: { samples: validated[0].reports[0].samples, runs: validated[0].reports[0].runs, warmup: validated[0].reports[0].warmup, ...(cohortId ? { id: cohortId } : {}) },
    decision: ranked.length ? { status: "rankable", recommendedProvider: ranked[0].provider } : { status: "insufficient_evidence", recommendedProvider: null },
    providers: entries,
  };
}

function parseArgs(argv) {
  const inputs = [];
  let output;
  let evidence;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--input" && argv[index + 1]) inputs.push(argv[++index]);
    else if (argv[index] === "--output" && argv[index + 1]) output = argv[++index];
    else if (argv[index] === "--evidence" && argv[index + 1]) evidence = argv[++index];
    else throw new Error("用法：--input report-a.json [--input report-b.json] [--evidence public_casia|consented_user]");
  }
  if (!inputs.length) throw new Error("至少需要一个 --input provider 报告。");
  if (evidence !== undefined && !EVIDENCE_VALUES.has(evidence)) throw new Error("--evidence 必须是 unknown、public_casia 或 consented_user。");
  return { inputs, output, evidence };
}

export { compareTranscriptionReports, validateReport };

if (import.meta.main) {
  const { inputs, output, evidence } = parseArgs(process.argv.slice(2));
  const reports = await Promise.all(inputs.map(async (input) => JSON.parse(await readFile(input, "utf8"))));
  const comparison = compareTranscriptionReports(reports, { evidence });
  const serialized = `${JSON.stringify(comparison, null, 2)}\n`;
  if (output) await writeFile(output, serialized, "utf8");
  console.log(serialized.trim());
  if (output) console.log(`Comparison written to: ${output}`);
}
