/**
 * Empty or unknown becomes none so the API still boots and cloud-agent tools stay
 * uninjected. `cursor` stays on without a deployment key: each user can save their own.
 */
export function resolveCloudAgentProvider(source: NodeJS.ProcessEnv = process.env): string {
  const configured = source.CLOUD_AGENT_PROVIDER;
  if (configured !== undefined && !configured.trim()) return "none";
  const requested = (configured?.trim() || "none").toLowerCase();
  if (requested === "none" || requested === "") return "none";
  if (requested === "emulator" || requested === "fake") return "emulator";
  if (requested === "cursor") return "cursor";
  // Soft-fall: do not throw at API boot for typos / future vendor names.
  return "none";
}
