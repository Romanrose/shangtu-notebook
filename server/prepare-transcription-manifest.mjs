import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { validateTimingPayload } from "./summarize-transcription-timings.mjs";

const ALLOWED_METADATA = ["writer", "inputMode", "orientation", "textType", "evidence", "cohortId", "consent"];
const EXPORTED_SAMPLE_PATTERN = /^shangtu-ink-([A-Za-z0-9]{12})-page-\d{2}-\d{14}\.png$/;
const EXPORTED_TIMING_PATTERN = /^shangtu-transcription-timing-([A-Za-z0-9]{12})-page-\d{2}-\d{14}\.json$/;

export function sampleIdFromInkFile(file) {
  return EXPORTED_SAMPLE_PATTERN.exec(file)?.[1] ?? null;
}

export function sampleIdFromTimingFile(file) {
  return EXPORTED_TIMING_PATTERN.exec(file)?.[1] ?? null;
}

export function validateTimingCoverage({ sampleFiles, timingFiles }) {
  if (!Array.isArray(sampleFiles) || !Array.isArray(timingFiles)) throw new Error("PNG 和 timing 文件必须是数组。");
  const sampleIds = sampleFiles.map(sampleIdFromInkFile);
  if (sampleIds.some((id) => !id)) throw new Error("启用 timing 校验时，所有 PNG 都必须使用实验页导出的匿名文件名。");
  if (new Set(sampleIds).size !== sampleIds.length) throw new Error("导出的 PNG 包含重复 sampleId。");
  const timingIds = timingFiles.map(sampleIdFromTimingFile);
  if (timingIds.some((id) => !id)) throw new Error("timing 目录只能包含实验页导出的匿名 JSON 文件。");
  if (new Set(timingIds).size !== timingIds.length) throw new Error("timing 文件包含重复 sampleId。");
  if (timingIds.length !== sampleIds.length || sampleIds.some((sampleId) => !timingIds.includes(sampleId))) throw new Error("PNG 与 timing 文件必须按 sampleId 一一对应。");
  return sampleIds;
}

export function createTranscriptionManifest({ files, expected, metadata = {} }) {
  if (!Array.isArray(files) || !Array.isArray(expected) || files.length !== expected.length || !files.length) throw new Error("样本文件和人工校对文本必须是一一对应的非空数组。");
  const normalizedMetadata = Object.fromEntries(Object.entries(metadata).filter(([key]) => ALLOWED_METADATA.includes(key)).map(([key, value]) => {
    if (typeof value !== "string" || value.length > 40) throw new Error("实验元数据只能包含不超过 40 字符的字符串。");
    return [key, value];
  }));
  if (normalizedMetadata.cohortId !== undefined && !/^[A-Za-z0-9._-]{1,80}$/.test(normalizedMetadata.cohortId)) throw new Error("实验元数据 cohortId 只能包含字母、数字、点、下划线或连字符。");
  if (normalizedMetadata.evidence === "consented_user" && (normalizedMetadata.cohortId === undefined || normalizedMetadata.consent !== "confirmed")) throw new Error("consented_user 清单必须同时声明 cohortId 和 consent=confirmed。");
  const derivedIds = files.map((file) => sampleIdFromInkFile(file));
  const exportedIds = derivedIds.filter(Boolean);
  if (new Set(exportedIds).size !== exportedIds.length) throw new Error("导出的样本 PNG 包含重复 sampleId。");
  return files.map((file, index) => {
    if (typeof file !== "string" || extname(file).toLowerCase() !== ".png" || basename(file) !== file) throw new Error("manifest 只接受样本目录顶层的 PNG 文件名。");
    if (typeof expected[index] !== "string" || !expected[index].trim() || expected[index].length > 240) throw new Error("每条样本都必须有 1–240 字符的人工校对文本。");
    return {
      id: derivedIds[index] ?? `sample-${String(index + 1).padStart(2, "0")}`,
      expected: expected[index].trim(),
      imagePath: file,
      ...(Object.keys(normalizedMetadata).length ? { metadata: normalizedMetadata } : {}),
    };
  });
}

async function collectPngFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".png").map((entry) => entry.name).sort();
}

async function collectTimingFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (!entries.length || entries.some((entry) => !entry.isFile() || extname(entry.name).toLowerCase() !== ".json")) throw new Error("timing 目录必须是非空且只包含顶层 JSON 文件的目录。");
  const files = entries.map((entry) => entry.name).sort();
  await Promise.all(files.map(async (file) => {
    const payload = JSON.parse(await readFile(resolve(directory, file), "utf8"));
    validateTimingPayload(payload);
  }));
  return files;
}

async function main() {
  const sampleDirectory = process.env.TRANSCRIPTION_SAMPLE_DIR;
  const outputPath = process.env.TRANSCRIPTION_MANIFEST_OUTPUT;
  if (!sampleDirectory || !outputPath) throw new Error("请设置 TRANSCRIPTION_SAMPLE_DIR 和 TRANSCRIPTION_MANIFEST_OUTPUT；脚本不会扫描默认 Downloads。");
  const directory = resolve(sampleDirectory);
  const files = await collectPngFiles(directory);
  if (!files.length) throw new Error("样本目录中没有 PNG 文件。");
  const timingDirectory = process.env.TRANSCRIPTION_TIMING_DIR ? resolve(process.env.TRANSCRIPTION_TIMING_DIR) : null;
  if (timingDirectory) validateTimingCoverage({ sampleFiles: files, timingFiles: await collectTimingFiles(timingDirectory) });
  const metadata = process.env.TRANSCRIPTION_SAMPLE_METADATA ? JSON.parse(process.env.TRANSCRIPTION_SAMPLE_METADATA) : {};
  const prompt = createInterface({ input: stdin, output: stdout });
  const expected = [];
  try {
    for (const file of files) expected.push(await prompt.question(`人工校对 ${file}：`));
  } finally {
    prompt.close();
  }
  const manifest = createTranscriptionManifest({ files, expected, metadata });
  await writeFile(resolve(outputPath), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`已写入 ${manifest.length} 条样本清单：${resolve(outputPath)}`);
}

if (import.meta.main) await main();
