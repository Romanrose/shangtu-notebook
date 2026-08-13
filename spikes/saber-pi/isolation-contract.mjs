import { access, readFile, readdir } from "node:fs/promises";

const SPIKE_ROOT = new URL("./", import.meta.url);

export const SABER_ISOLATION_CONTRACT = Object.freeze({
  sourceMode: "external-reference-only",
  copiedSaberSource: false,
  saberDependency: false,
  saberSubmodule: false,
  allowedSpikeFiles: ["README.md", "bridge.mjs", "check-fixture.mjs", "client.mjs", "check-client.mjs", "isolation-contract.mjs", "check-isolation.mjs"],
  responsibilities: Object.freeze({
    saber: ["page", "ink", "undo_redo", "render", "local_persistence", "sync"],
    bridge: ["transport_boundary", "request_validation", "fixture_routing"],
    pi: ["transcription", "entity_clarification", "bounded_cnkgraph_retrieval", "evidence_validation", "annotation_composition"],
  }),
});

export async function checkSaberIsolation() {
  const entries = await readdir(SPIKE_ROOT, { withFileTypes: true });
  const unexpected = entries
    .filter((entry) => !SABER_ISOLATION_CONTRACT.allowedSpikeFiles.includes(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (unexpected.length) throw new Error(`Spike 目录出现未声明文件：${unexpected.join(", ")}`);

  const workspaceRoot = new URL("../../", import.meta.url);
  const packageJson = JSON.parse(await readFile(new URL("package.json", workspaceRoot), "utf8"));
  const dependencyNames = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
  if (dependencyNames.some((name) => name.toLowerCase().includes("saber"))) {
    throw new Error("当前仓库 package.json 不得引入 Saber 依赖。");
  }
  for (const forbidden of ["pubspec.yaml", "saber", "submodules/saber"]) {
    try {
      await access(new URL(forbidden, workspaceRoot));
      throw new Error(`当前仓库存在未授权的 Saber 工程路径：${forbidden}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("当前仓库存在")) throw error;
    }
  }

  return {
    ...SABER_ISOLATION_CONTRACT,
    spikeFiles: entries.map((entry) => entry.name).sort(),
    status: "isolated",
  };
}
