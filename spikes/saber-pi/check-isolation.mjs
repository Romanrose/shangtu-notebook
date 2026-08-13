import { checkSaberIsolation } from "./isolation-contract.mjs";

const result = await checkSaberIsolation();
if (result.copiedSaberSource || result.saberDependency || result.saberSubmodule) {
  throw new Error("Saber GPL 源码、依赖或 submodule 不得进入当前仓库 Spike。");
}
if (!result.responsibilities.saber.includes("ink") || !result.responsibilities.pi.includes("evidence_validation")) {
  throw new Error("Saber/Pi 职责边界发生漂移。");
}
console.log(`Saber isolation verified: external reference only; ${result.spikeFiles.length} declared Spike files.`);
