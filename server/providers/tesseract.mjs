import { spawn } from "node:child_process";
import { createTranscription } from "../transcription-contract.mjs";

const MAX_OUTPUT_BYTES = 200_000;

function decodePngDataUrl(image) {
  if (!image || image.mimeType !== "image/png" || typeof image.data !== "string") return null;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(image.data);
  return match?.[1] ?? null;
}

/**
 * Run the classic Tesseract CLI server-side through stdin, keeping the image
 * out of temporary files. This is an experiment-only provider; it is not a
 * handwriting-specialized model.
 */
export function invokeTesseract({ image, command = process.env.TESSERACT_BIN, language = process.env.TESSERACT_LANG ?? "chi_sim", tessdataPrefix = process.env.TESSDATA_PREFIX, psm = process.env.TESSERACT_PSM ?? "7", spawnImpl = spawn, signal }) {
  const base64 = decodePngDataUrl(image);
  if (!base64 || !command) return null;
  return new Promise((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    const output = [];
    let child;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => {
      child?.kill?.("SIGTERM");
      finish(reject, new Error("tesseract_aborted"));
    };
    try {
      child = spawnImpl(command, ["stdin", "stdout", "--psm", String(psm), "-l", language], {
        stdio: ["pipe", "pipe", "ignore"],
        env: { PATH: process.env.PATH ?? "", ...(tessdataPrefix ? { TESSDATA_PREFIX: tessdataPrefix } : {}) },
      });
      child.stdout.on("data", (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          child.kill?.("SIGTERM");
          finish(reject, new Error("tesseract_output_too_large"));
          return;
        }
        output.push(chunk);
      });
      child.on("error", (error) => finish(reject, error));
      child.on("close", (code) => {
        if (code !== 0) {
          finish(reject, new Error(`tesseract_exit_${code ?? "unknown"}`));
          return;
        }
        finish(resolve, createTranscription({ text: Buffer.concat(output).toString("utf8").trim() }));
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      child.stdin.end(Buffer.from(base64, "base64"));
    } catch (error) {
      finish(reject, error);
    }
  });
}
