import { access } from "node:fs/promises";
import path from "node:path";
import type {
  ServerUpdateCheck,
  ServerUpdateRequest,
  ServerUpdateRun,
  ServerUpdateStatus,
} from "@rakazo/contracts";
import { ServerUpdateRunSchema } from "@rakazo/contracts";
import {
  DEFAULT_UPDATE_BRANCH,
  detectRestartSupervisor,
  isOfficialRepoUrl,
  manualUpgradeCommands,
  OFFICIAL_REPO_URL,
  OFFICIAL_SERVER_IMAGE,
  resolveInstallKind,
  restartSupervisorAdvice,
} from "@rakazo/core";
import { outgoingCorrelationHeaders } from "@rakazo/logging";

const PRODUCT_VERSION = "0.1.0";
const STATE_TIMEOUT_MS = 15_000;
const PLAN_TIMEOUT_MS = 180_000;
const APPLY_TIMEOUT_MS = 2_100_000;
export const MAX_UPDATER_RESPONSE_BYTES = 1024 * 1024;

export interface UpdaterProxyConfig {
  url: string | null;
  token: string | null;
  gitSha: string | undefined;
  /** Current `RAKAZO_IMAGE_TAG` when known; selects compose pull vs rebuild commands. */
  imageTag?: string | null;
  disabled?: boolean;
  /** Override for tests; defaults to process.cwd(). */
  checkoutRoot?: string;
  fetch?: typeof fetch;
}

export class UpdaterProxyError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "UpdaterProxyError";
  }
}

/** True only when the API can authenticate to the sidecar. The token never leaves this process. */
export function isUpdaterConfigured(config: UpdaterProxyConfig): boolean {
  return Boolean(config.url?.trim() && config.token?.trim());
}

export async function hasGitCheckout(root: string): Promise<boolean> {
  try {
    await access(path.join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function probeSidecar(config: UpdaterProxyConfig, fetchImpl: typeof fetch): Promise<boolean> {
  if (!isUpdaterConfigured(config) || !config.url || !config.token) return false;
  try {
    const response = await fetchImpl(new URL("/health", ensureTrailingSlash(config.url)), {
      method: "GET",
      headers: outgoingCorrelationHeaders(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    // Confirm the bearer works: /health is open, so a wrong token would still look "up".
    const state = await fetchImpl(new URL("/state", ensureTrailingSlash(config.url)), {
      method: "GET",
      headers: { authorization: `Bearer ${config.token}`, ...outgoingCorrelationHeaders() },
      signal: AbortSignal.timeout(5_000),
    });
    return state.ok;
  } catch {
    return false;
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

export async function readServerUpdateStatus(
  config: UpdaterProxyConfig,
): Promise<ServerUpdateStatus> {
  const fetchImpl = config.fetch ?? fetch;
  const checkoutRoot = config.checkoutRoot ?? process.cwd();
  const hasCheckout = await hasGitCheckout(checkoutRoot);
  const urlConfigured = Boolean(config.url?.trim());
  const reachable = await probeSidecar(config, fetchImpl);
  const install = resolveInstallKind({
    updaterUrlConfigured: urlConfigured,
    updaterReachable: reachable,
    hasCheckout,
    disabled: config.disabled === true,
  });
  const supervisor = detectRestartSupervisor(process.env);
  const imageTagHint = config.imageTag?.trim() || process.env.RAKAZO_IMAGE_TAG?.trim() || null;
  const base: ServerUpdateStatus = {
    supported: install.kind === "sidecar",
    unsupportedReason: install.kind === "sidecar" ? null : install.reason,
    installKind: install.kind,
    manualCommands: [...manualUpgradeCommands(install.kind, { imageTag: imageTagHint })],
    mode: install.mode,
    strategy: null,
    strategyNote: null,
    version: PRODUCT_VERSION,
    revision: config.gitSha ?? null,
    commit: config.gitSha ?? null,
    branch: null,
    remoteUrl: null,
    dirty: false,
    dirtyPaths: [],
    image: null,
    imageTag: imageTagHint,
    previousImageTag: null,
    canRollback: false,
    source: {
      repoUrl: OFFICIAL_REPO_URL,
      branch: DEFAULT_UPDATE_BRANCH,
      official: true,
    },
    officialRepoUrl: OFFICIAL_REPO_URL,
    restartSupervisor: supervisor.kind,
    restartAdvice: restartSupervisorAdvice(supervisor),
    running: false,
    lastRun: null,
  };

  if (install.kind !== "sidecar" || !config.url || !config.token) return base;

  try {
    const state = await sidecarJson<{
      image?: string;
      imageRef?: string;
      currentTag?: string;
      previousTag?: string | null;
      running?: boolean;
      lastRun?: unknown;
      checkout?: {
        present?: boolean;
        commit?: string | null;
        branch?: string | null;
        remoteUrl?: string | null;
        dirty?: boolean;
        dirtyPaths?: string[];
      };
    }>(config, fetchImpl, "GET", "/state", undefined, STATE_TIMEOUT_MS);

    const remoteUrl = state.checkout?.remoteUrl ?? null;
    const official = remoteUrl ? isOfficialRepoUrl(remoteUrl) : true;
    const parsedLastRun = ServerUpdateRunSchema.safeParse(state.lastRun);
    return {
      ...base,
      supported: true,
      unsupportedReason: null,
      strategy: official ? "pull" : "build",
      strategyNote: official
        ? "Official releases pull the published image."
        : "This fork builds on the server.",
      commit: state.checkout?.commit ?? base.commit,
      branch: state.checkout?.branch ?? null,
      remoteUrl,
      dirty: state.checkout?.dirty === true,
      dirtyPaths: state.checkout?.dirtyPaths ?? [],
      image: state.image ?? OFFICIAL_SERVER_IMAGE,
      imageTag: state.currentTag ?? null,
      previousImageTag: state.previousTag ?? null,
      canRollback: Boolean(state.previousTag),
      source: {
        repoUrl:
          remoteUrl && isOfficialRepoUrl(remoteUrl)
            ? OFFICIAL_REPO_URL
            : (remoteUrl ?? OFFICIAL_REPO_URL),
        branch: state.checkout?.branch ?? DEFAULT_UPDATE_BRANCH,
        official,
      },
      running: state.running === true,
      lastRun: parsedLastRun.success ? parsedLastRun.data : null,
    };
  } catch (error) {
    return {
      ...base,
      supported: false,
      unsupportedReason:
        error instanceof Error ? error.message : "The updater sidecar did not respond.",
      installKind: "compose",
      mode: "unavailable",
      manualCommands: [
        ...manualUpgradeCommands("compose", {
          imageTag: imageTagHint,
        }),
      ],
    };
  }
}

export async function checkServerUpdate(
  config: UpdaterProxyConfig,
  input: ServerUpdateRequest = {},
): Promise<ServerUpdateCheck> {
  await requireSidecar(config);
  const fetchImpl = config.fetch ?? fetch;
  const plan = await sidecarJson<{
    upToDate?: boolean;
    reason?: string;
    targetCommit?: string | null;
    targetTag?: string | null;
    checkout?: { commit?: string | null; dirty?: boolean; dirtyPaths?: string[] };
  }>(config, fetchImpl, "POST", "/plan", requestBody(input), PLAN_TIMEOUT_MS);

  if (plan.checkout?.dirty === true) {
    return {
      status: "dirty",
      reason: "The deployment checkout has local changes.",
      changed: plan.checkout.dirtyPaths ?? [],
      commit: plan.checkout.commit ?? null,
      targetCommit: plan.targetCommit ?? null,
      targetTag: plan.targetTag ?? null,
      behindBy: 0,
    };
  }
  if (plan.upToDate === true) {
    return {
      status: "up-to-date",
      reason: plan.reason ?? null,
      changed: [],
      commit: plan.checkout?.commit ?? null,
      targetCommit: plan.targetCommit ?? null,
      targetTag: plan.targetTag ?? null,
      behindBy: 0,
    };
  }
  return {
    status: "available",
    reason: plan.reason ?? null,
    changed: [],
    commit: plan.checkout?.commit ?? null,
    targetCommit: plan.targetCommit ?? null,
    targetTag: plan.targetTag ?? null,
    behindBy:
      plan.targetCommit && plan.checkout?.commit && plan.targetCommit !== plan.checkout.commit
        ? 1
        : 0,
  };
}

/**
 * Proxies `/apply` to the sidecar.
 *
 * A successful recreate replaces this API container while the request is still open, so the
 * JSON body often never reaches the browser. Clients must treat a mid-flight transport failure
 * as "recreate in progress" and re-fetch `status` once the API is healthy again.
 */
export async function applyServerUpdate(
  config: UpdaterProxyConfig,
  input: ServerUpdateRequest = {},
): Promise<ServerUpdateRun> {
  await requireSidecar(config);
  const fetchImpl = config.fetch ?? fetch;
  return sidecarJson<ServerUpdateRun>(
    config,
    fetchImpl,
    "POST",
    "/apply",
    requestBody(input),
    APPLY_TIMEOUT_MS,
  );
}

/**
 * Hard gate: Settings apply/check never run git (or anything else) inside the API.
 * Sidecar `/rollback` remains for ops only and is not exposed on the owner RPC surface.
 * Only the updater sidecar holds the Docker socket and outlives a recreate.
 */
async function requireSidecar(config: UpdaterProxyConfig): Promise<void> {
  if (config.disabled === true) {
    throw new UpdaterProxyError("Self-update is switched off for this deployment.");
  }
  if (!isUpdaterConfigured(config)) {
    throw new UpdaterProxyError(
      "The updater sidecar is not configured. Use the host Compose commands, or enable the updater profile.",
    );
  }
  const fetchImpl = config.fetch ?? fetch;
  if (!(await probeSidecar(config, fetchImpl))) {
    throw new UpdaterProxyError(
      "The updater sidecar is not reachable. Start the opt-in updater profile, or upgrade from the host.",
    );
  }
}

function requestBody(input: ServerUpdateRequest): Record<string, string> {
  const body: Record<string, string> = {};
  if (input.repoUrl?.trim()) body.repoUrl = input.repoUrl.trim();
  if (input.branch?.trim()) body.branch = input.branch.trim();
  return body;
}

async function sidecarJson<T>(
  config: UpdaterProxyConfig,
  fetchImpl: typeof fetch,
  method: string,
  route: string,
  body: unknown | undefined,
  timeoutMs: number,
): Promise<T> {
  if (!config.url || !config.token) {
    throw new UpdaterProxyError("The updater sidecar is not configured.");
  }
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await withAbort(
      fetchImpl(new URL(route.replace(/^\//, ""), ensureTrailingSlash(config.url)), {
        method,
        headers: {
          authorization: `Bearer ${config.token}`,
          ...outgoingCorrelationHeaders(),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      }),
      signal,
    );
  } catch (error) {
    throw new UpdaterProxyError(
      error instanceof Error ? error.message : "The updater sidecar did not respond.",
      502,
    );
  }
  if (response.status === 401) {
    cancelResponseBody(response);
    throw new UpdaterProxyError("The updater sidecar rejected the deployment credential.", 502);
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_UPDATER_RESPONSE_BYTES) {
    cancelResponseBody(response);
    throw new UpdaterProxyError("The updater sidecar response is too large.", 502);
  }
  let bytes: Uint8Array;
  try {
    bytes = await readSidecarBody(response, signal);
  } catch (error) {
    if (error instanceof Error && error.message === "Response is too large") {
      throw new UpdaterProxyError("The updater sidecar response is too large.", 502);
    }
    throw new UpdaterProxyError(
      error instanceof Error ? error.message : "The updater sidecar response could not be read.",
      502,
    );
  }
  let payload = {} as T & { error?: string };
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes)) as T & { error?: string };
  } catch {
    // Keep the existing generic status handling for empty or malformed sidecar responses.
  }
  if (!response.ok) {
    throw new UpdaterProxyError(
      typeof payload.error === "string" && payload.error
        ? payload.error
        : `Updater sidecar returned ${response.status}.`,
      response.status >= 400 && response.status < 500 ? 400 : 502,
    );
  }
  return payload;
}

function cancelResponseBody(response: Response): void {
  try {
    void Promise.resolve(response.body?.cancel()).catch(() => undefined);
  } catch {
    // Best-effort release only; an untrusted cancellation must not delay the error.
  }
}

async function readSidecarBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) {
    const buffer = await withAbort(response.arrayBuffer(), signal);
    if (buffer.byteLength > MAX_UPDATER_RESPONSE_BYTES) {
      throw new Error("Response is too large");
    }
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > MAX_UPDATER_RESPONSE_BYTES) {
        cancelReader(reader);
        throw new Error("Response is too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    cancelReader(reader);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already cancelled or released
    }
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void Promise.resolve(reader.cancel()).catch(() => undefined);
  } catch {
    // Best-effort release only; an untrusted cancellation must not delay the error.
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Request timed out"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Request timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Exported for tests that assert the API never treats a source tree as applyable. */
export function assertNoGitApplyPath(installKind: string): void {
  if (installKind === "source" || installKind === "compose") {
    throw new UpdaterProxyError(
      "Settings cannot apply updates without the updater sidecar. Use the documented host commands.",
    );
  }
}
