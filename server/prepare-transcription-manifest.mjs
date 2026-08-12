import { readdir, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

const ALLOWED_METADATA = ["writer", "inputMode", "orientation", "textType", "evidence", "cohortId", "consent"];
const EXPORTED_SAMPLE_PATTERN = /^shangtu-ink-([A-Za-z0-9]{12})-page-\d{2}-\d{14}\.png$/;

export function sampleIdFromInkFile(file) {
  return EXPORTED_SAMPLE_PATTERN.exec(file)?.[1] ?? null;
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

async function main() {
  const sampleDirectory = process.env.TRANSCRIPTION_SAMPLE_DIR;
  const outputPath = process.env.TRANSCRIPTION_MANIFEST_OUTPUT;
  if (!sampleDirectory || !outputPath) throw new Error("请设置 TRANSCRIPTION_SAMPLE_DIR 和 TRANSCRIPTION_MANIFEST_OUTPUT；脚本不会扫描默认 Downloads。");
  const directory = resolve(sampleDirectory);
  const files = await collectPngFiles(directory);
  if (!files.length) throw new Error("样本目录中没有 PNG 文件。");
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
