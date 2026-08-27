/**
 * Apply recreates the API container mid-request. ORPC then surfaces a generic transport
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

export type RecreateLastRun = {
  ok: boolean;
  fromTag: string | null;
  toTag: string | null;
  finishedAt: string | null;
  error: string | null;
  restartAdvice: string;
};

/**
 * After reconnect, only claim success from a finished sidecar run that started from the
 * pre-action tag. A changed env pin alone is not enough: recreate can fail, restore the prior
 * image, and still leave `RAKAZO_IMAGE_TAG` pointing at the target.
 */
export function confirmUpdaterRecreate(input: {
  beforeImageTag: string | null;
  afterImageTag: string | null;
  running: boolean;
  supported: boolean;
  installKind: string;
  lastRun: RecreateLastRun | null;
}): {
  confirmed: boolean;
  reason: "waiting" | "running" | "unchanged" | "changed" | "failed";
} {
  if (input.supported !== true || input.installKind !== "sidecar") {
    return { confirmed: false, reason: "waiting" };
  }
  if (input.running) return { confirmed: false, reason: "running" };

  const run = input.lastRun;
  if (!run || run.finishedAt === null) {
    return { confirmed: false, reason: "waiting" };
  }
  if (!input.beforeImageTag || run.fromTag !== input.beforeImageTag) {
    return { confirmed: false, reason: "unchanged" };
  }
  if (!run.ok) {
    return { confirmed: false, reason: "failed" };
  }
  if (run.toTag && input.afterImageTag === run.toTag && run.toTag !== input.beforeImageTag) {
    return { confirmed: true, reason: "changed" };
  }
  return { confirmed: false, reason: "unchanged" };
}

/** Timeout copy after recreate reconnect polling. */
export function recreateWaitTimeoutError(input: {
  sawApi: boolean;
  sawSidecar: boolean;
  lastError?: unknown;
}): Error {
  if (input.sawSidecar) {
    return new Error("The updater was still running when the wait timed out.");
  }
  if (input.sawApi) {
    return new Error("The updater sidecar was unavailable after reconnect.");
  }
  return input.lastError instanceof Error
    ? input.lastError
    : new Error("The API did not come back after the update.");
}
