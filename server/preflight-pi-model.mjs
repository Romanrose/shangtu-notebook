import { findEnvKeys, getModel } from "@earendil-works/pi-ai/compat";

/**
 * Local-only deployment check. It reads neither credential values nor network
 * state; it only confirms that a selected Pi model is in the installed static
 * catalog and that its provider has a recognized server-side auth variable.
 */
export function inspectPiModelConfiguration({
  provider = process.env.PI_MODEL_PROVIDER,
  modelId = process.env.PI_MODEL_ID,
  env = process.env,
} = {}) {
  if (!provider || !modelId) return { status: "pi_unconfigured" };
  const model = getModel(provider, modelId);
  if (!model) return { status: "pi_model_unknown", provider, modelId };
  const authEnvNames = findEnvKeys(provider, env) ?? [];
  return {
    status: authEnvNames.length > 0 ? "pi_ready_for_controlled_call" : "pi_auth_missing",
    provider,
    modelId,
    authConfigured: authEnvNames.length > 0,
  };
}

if (import.meta.main) {
  console.log(JSON.stringify(inspectPiModelConfiguration()));
}
