function percentile(values, ratio) {
  if (!values.length) return 0;
  const index = Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1);
  return [...values].sort((left, right) => left - right)[index];
}

function mean(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

/**
 * Condenses the per-sample report into provider-level comparison signals.
 * Rates are averaged across samples so a long sample cannot outweigh a short
 * sample merely because it has more characters.
 */
export function summarizeTranscriptionBenchmark(report) {
  const statusCounts = {};
  for (const sample of report) {
    for (const [status, count] of Object.entries(sample.statusCounts ?? {})) {
      statusCounts[status] = (statusCounts[status] ?? 0) + count;
    }
  }
  return {
    samples: report.length,
    totalRuns: report.reduce((total, sample) => total + sample.runs, 0),
    meanOkRate: mean(report.map((sample) => sample.okRate)),
    meanExactRate: mean(report.map((sample) => sample.exactRate)),
    meanCandidateHitRate: mean(report.map((sample) => sample.candidateHitRate)),
    sampleExactRate: report.length ? report.filter((sample) => sample.exact).length / report.length : 0,
    sampleCandidateHitRate: report.length ? report.filter((sample) => sample.candidateHitRate > 0).length / report.length : 0,
    meanCharacterErrorRate: mean(report.map((sample) => sample.characterErrorRate)),
    meanP50Ms: mean(report.map((sample) => sample.p50Ms)),
    meanP95Ms: mean(report.map((sample) => sample.p95Ms)),
    statusCounts,
  };
}

export function characterErrorRate(expected, actual) {
  const source = [...expected];
  const target = [...actual];
  const row = Array.from({ length: target.length + 1 }, (_, index) => index);
  for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
    let previous = row[0];
    row[0] = sourceIndex;
    for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
      const saved = row[targetIndex];
      row[targetIndex] = Math.min(
        row[targetIndex] + 1,
        row[targetIndex - 1] + 1,
        previous + Number(source[sourceIndex - 1] !== target[targetIndex - 1]),
      );
      previous = saved;
    }
  }
  return source.length ? row[target.length] / source.length : Number(target.length > 0);
}

/**
 * Runs adapters only in the server process. It intentionally measures the
 * adapter boundary, not local awakening or a user's confirmation time.
 */
export async function benchmarkTranscription({ cases, transcribe, runs = 3, warmup = 0, now = () => performance.now() }) {
  const report = [];
  for (const sample of cases) {
    const durations = [];
    const statusCounts = {};
    let okRuns = 0;
    let exactRuns = 0;
    let candidateHitRuns = 0;
    let result;
    for (let run = 0; run < warmup; run += 1) await transcribe({ image: sample.image });
    for (let run = 0; run < runs; run += 1) {
      const startedAt = now();
      result = await transcribe({ image: sample.image });
      durations.push(now() - startedAt);
      const status = result?.providerStatus ?? "unknown";
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      const transcription = result?.status === "ok" ? result.transcription : null;
      const actual = transcription?.text ?? "";
      if (transcription) {
        okRuns += 1;
        if (actual === sample.expected) exactRuns += 1;
        if ([actual, ...(transcription.candidates ?? [])].includes(sample.expected)) candidateHitRuns += 1;
      }
    }
    const actual = result?.status === "ok" ? result.transcription?.text ?? "" : "";
    report.push({
      id: sample.id,
      expected: sample.expected,
      ...(sample.metadata ? { metadata: sample.metadata } : {}),
      actual,
      exact: actual === sample.expected,
      characterErrorRate: characterErrorRate(sample.expected, actual),
      providerStatus: result?.providerStatus ?? "unknown",
      okRate: okRuns / runs,
      exactRate: exactRuns / runs,
      candidateHitRate: candidateHitRuns / runs,
      statusCounts,
      runs,
      warmup,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
    });
  }
  return report;
}
