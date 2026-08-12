function percentile(values, ratio) {
  if (!values.length) return 0;
  const index = Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1);
  return [...values].sort((left, right) => left - right)[index];
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
    let result;
    for (let run = 0; run < warmup; run += 1) await transcribe({ image: sample.image });
    for (let run = 0; run < runs; run += 1) {
      const startedAt = now();
      result = await transcribe({ image: sample.image });
      durations.push(now() - startedAt);
    }
    const actual = result?.status === "ok" ? result.transcription?.text ?? "" : "";
    report.push({
      id: sample.id,
      expected: sample.expected,
      actual,
      exact: actual === sample.expected,
      characterErrorRate: characterErrorRate(sample.expected, actual),
      providerStatus: result?.providerStatus ?? "unknown",
      runs,
      warmup,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
    });
  }
  return report;
}
