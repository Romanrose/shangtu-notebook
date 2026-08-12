import { readFile, writeFile } from "node:fs/promises";

const EVENTS = new Set(["pen_up", "local_awakening", "transcription_request", "transcription_result", "transcription_confirmed"]);

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function summarizeValues(values) {
  return {
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
  };
}

function validateTimingPayload(payload) {
  if (!payload || payload.schema !== "shangtu-transcription-timing-v1" || !Array.isArray(payload.timings) || !payload.timings.length) {
    throw new Error("时延文件必须是 shangtu-transcription-timing-v1 且包含 timings。");
  }
  if (payload.sampleId !== undefined && (typeof payload.sampleId !== "string" || !/^[A-Za-z0-9]{12}$/.test(payload.sampleId))) throw new Error("时延文件 sampleId 必须是 12 位匿名标识。");
  const seen = new Set();
  for (const timing of payload.timings) {
    if (!timing || !EVENTS.has(timing.event) || seen.has(timing.event) || typeof timing.elapsedMs !== "number" || !Number.isFinite(timing.elapsedMs) || timing.elapsedMs < 0 || (timing.event === "transcription_confirmed" && typeof timing.edited !== "boolean") || (timing.event !== "transcription_confirmed" && timing.edited !== undefined) || (timing.provider !== undefined && (timing.event !== "transcription_result" || typeof timing.provider !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(timing.provider)))) {
      throw new Error("时延事件必须是唯一、已知且非负毫秒数。");
    }
    seen.add(timing.event);
  }
  if (!seen.has("pen_up")) throw new Error("时延文件缺少 pen_up 事件。");
  return payload.timings;
}

function summarizeTranscriptionTimings(payloads) {
  const sampleIds = payloads.map((payload) => payload.sampleId ?? null);
  const presentSampleIds = sampleIds.filter(Boolean);
  if (new Set(presentSampleIds).size !== presentSampleIds.length) throw new Error("时延输入包含重复 sampleId，不能重复计入同一实验。");
  const timingSets = payloads.map(validateTimingPayload);
  const trials = timingSets.map((timings) => {
    const byEvent = Object.fromEntries(timings.map((timing) => [timing.event, timing]));
    const result = byEvent.transcription_result;
    return {
      localAwakeningMs: byEvent.local_awakening?.elapsedMs ?? null,
      transcriptionRequestMs: byEvent.transcription_request?.elapsedMs ?? null,
      transcriptionResultMs: result?.elapsedMs ?? null,
      provider: result?.provider ?? "unknown",
      confirmationMs: byEvent.transcription_confirmed?.elapsedMs ?? null,
      edited: byEvent.transcription_confirmed?.edited ?? null,
      status: result?.status ?? "missing_result",
      providerStatus: result?.providerStatus ?? "missing_result",
    };
  });
  const durations = (key) => trials.map((trial) => trial[key]).filter((value) => typeof value === "number");
  const groups = new Map();
  for (const trial of trials) {
    const key = `${trial.provider}:${trial.providerStatus}:${trial.status}`;
    const group = groups.get(key) ?? { provider: trial.provider, providerStatus: trial.providerStatus, status: trial.status, trials: 0, localAwakening: [], transcriptionRequest: [], transcriptionResult: [], confirmation: [], edited: [] };
    group.trials += 1;
    if (trial.localAwakeningMs !== null) group.localAwakening.push(trial.localAwakeningMs);
    if (trial.transcriptionRequestMs !== null) group.transcriptionRequest.push(trial.transcriptionRequestMs);
    if (trial.transcriptionResultMs !== null) group.transcriptionResult.push(trial.transcriptionResultMs);
    if (trial.confirmationMs !== null) group.confirmation.push(trial.confirmationMs);
    if (typeof trial.edited === "boolean") group.edited.push(trial.edited);
    groups.set(key, group);
  }
  const compactGroup = ({ provider, providerStatus, status, trials: count, localAwakening, transcriptionRequest, transcriptionResult, confirmation, edited }) => ({
    provider,
    providerStatus,
    status,
    trials: count,
    localAwakening: summarizeValues(localAwakening),
    transcriptionRequest: summarizeValues(transcriptionRequest),
    transcriptionResult: summarizeValues(transcriptionResult),
    confirmation: summarizeValues(confirmation),
    confirmationAvailableRate: count ? confirmation.length / count : null,
    editedConfirmationRate: edited.length ? edited.filter(Boolean).length / edited.length : null,
  });
  const eventCounts = Object.fromEntries([...EVENTS].map((event) => [event, timingSets.filter((timings) => timings.some((timing) => timing.event === event)).length]));
  return {
    schema: "shangtu-transcription-timing-summary-v1",
    trials: payloads.length,
    sampleIdCoverage: payloads.length ? presentSampleIds.length / payloads.length : null,
    sampleIds: presentSampleIds,
    eventCounts,
    localAwakening: summarizeValues(durations("localAwakeningMs")),
    transcriptionRequest: summarizeValues(durations("transcriptionRequestMs")),
    transcriptionResult: summarizeValues(durations("transcriptionResultMs")),
    confirmation: summarizeValues(durations("confirmationMs")),
    resultAvailableRate: trials.length ? durations("transcriptionResultMs").length / trials.length : null,
    confirmationAvailableRate: trials.length ? durations("confirmationMs").length / trials.length : null,
    editedConfirmationRate: trials.filter((trial) => typeof trial.edited === "boolean").length ? trials.filter((trial) => trial.edited === true).length / trials.filter((trial) => typeof trial.edited === "boolean").length : null,
    byProviderStatus: [...groups.values()].map(compactGroup),
  };
}

function parseArgs(argv) {
  const inputs = [];
  let output;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--input" && argv[index + 1]) inputs.push(argv[++index]);
    else if (argv[index] === "--output" && argv[index + 1]) output = argv[++index];
    else throw new Error("用法：--input timing-a.json [--input timing-b.json] [--output summary.json]");
  }
  if (!inputs.length) throw new Error("至少需要一个 --input 时延 JSON。");
  return { inputs, output };
}

export { summarizeTranscriptionTimings, validateTimingPayload };

if (import.meta.main) {
  const { inputs, output } = parseArgs(process.argv.slice(2));
  const payloads = await Promise.all(inputs.map(async (input) => JSON.parse(await readFile(input, "utf8"))));
  const summary = summarizeTranscriptionTimings(payloads);
  const serialized = `${JSON.stringify(summary, null, 2)}\n`;
  if (output) await writeFile(output, serialized, "utf8");
  console.log(serialized.trim());
  if (output) console.log(`Summary written to: ${output}`);
}
