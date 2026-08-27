/**
 * Apply/rollback recreate the API container mid-request. ORPC then surfaces a generic transport
 * failure instead of the sidecar's completed run. Treat those as "wait for the new API".
 */
export function isLikelyUpdaterRecreateDisconnect(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("network request failed") ||
    message.includes("load failed") ||
    message.includes("fetch failed") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("socket hang up") ||
    message.includes("aborted") ||
    message.includes("the operation was aborted")
  );
}

/**
 * After reconnect, only claim success from a live sidecar status: supported sidecar install,
 * idle run lock, and an image tag that actually moved. A compose/source fallback with a changed
 * configured tag is not proof the update finished.
 */
export function confirmUpdaterRecreate(input: {
  beforeImageTag: string | null;
  afterImageTag: string | null;
  running: boolean;
  supported: boolean;
  installKind: string;
}): { confirmed: boolean; reason: "waiting" | "running" | "unchanged" | "changed" } {
  if (input.supported !== true || input.installKind !== "sidecar") {
    return { confirmed: false, reason: "waiting" };
  }
  if (input.running) return { confirmed: false, reason: "running" };
  if (input.beforeImageTag && input.afterImageTag && input.afterImageTag !== input.beforeImageTag) {
    return { confirmed: true, reason: "changed" };
  }
  return { confirmed: false, reason: "unchanged" };
}
