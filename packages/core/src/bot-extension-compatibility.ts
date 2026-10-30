export const BOT_EXTENSION_HOST_API_VERSION = 1;

export const SUPPORTED_BOT_EXTENSION_SURFACES = [
  "tools",
  "lifecycle-observers",
  "prompt-transforms",
  "tool-gates",
  "headless-commands",
  "bot-state",
  "product-messages",
] as const;

export type BotExtensionManifest = {
  extensionId: string;
  version: string;
  digest: string;
  hostApiVersion: number;
  requiredSurfaces: readonly string[];
  operatorApproved: boolean;
  withdrawn: boolean;
};

export type BotExtensionCompatibility =
  | { compatible: true }
  | { compatible: false; reasons: string[] };

/** Static compatibility is necessary but does not prove that an artifact is safe or sandboxed. */
export function checkBotExtensionCompatibility(
  manifest: BotExtensionManifest,
  hostEnabled: boolean,
): BotExtensionCompatibility {
  const reasons: string[] = [];
  if (!hostEnabled) reasons.push("extension-host-disabled");
  if (!manifest.operatorApproved) reasons.push("operator-approval-required");
  if (manifest.withdrawn) reasons.push("artifact-withdrawn");
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.digest)) reasons.push("invalid-artifact-digest");
  if (manifest.hostApiVersion !== BOT_EXTENSION_HOST_API_VERSION) {
    reasons.push("unsupported-host-api-version");
  }
  const supported = new Set<string>(SUPPORTED_BOT_EXTENSION_SURFACES);
  for (const surface of new Set(manifest.requiredSurfaces)) {
    if (!supported.has(surface)) reasons.push(`unsupported-surface:${surface}`);
  }
  return reasons.length ? { compatible: false, reasons } : { compatible: true };
}
