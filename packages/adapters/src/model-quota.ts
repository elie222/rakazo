import { createHash } from "node:crypto";
import type { ModelQuota, ModelQuotaWindow } from "@rakazo/contracts";
import { isCommandCodeBaseUrl, isOpenCodeGoBaseUrl } from "@rakazo/contracts";

const MAX_BYTES = 64 * 1024;
const MAX_AGE_MS = 60_000;
const FAILURE_TTL_MS = 15_000;
const MAX_ENTRIES = 256;

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("schema");
  return value as ObjectValue;
}
function percent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)
    throw new Error("schema");
  return value;
}
function reset(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const time =
    typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || time < 0) throw new Error("schema");
  return new Date(time).toISOString();
}

/** Parse only applicable provider windows; a missing required window is unknown. */
export function parseCodexQuota(payload: unknown): ModelQuotaWindow[] {
  const body = object(payload);
  const limits = object(body.rate_limit);
  const windows: ModelQuotaWindow[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const raw = limits[key];
    if (raw === null || raw === undefined) continue;
    const window = object(raw);
    windows.push({
      id: key,
      usedPercent: percent(window.used_percent),
      resetsAt: reset(window.reset_at),
      modelIds: null,
    });
  }
  if (!windows.length) throw new Error("schema");
  // Additional buckets can constrain particular models. Do not silently discard
  // unknown bucket shapes and report an apparently complete allowance.
  if (
    body.additional_rate_limits !== undefined &&
    body.additional_rate_limits !== null &&
    (!Array.isArray(body.additional_rate_limits) || body.additional_rate_limits.length > 0)
  )
    throw new Error("schema");
  return windows;
}

export function parseClaudeQuota(payload: unknown): ModelQuotaWindow[] {
  const body = object(payload);
  const windows: ModelQuotaWindow[] = [];
  for (const key of ["five_hour", "seven_day"]) {
    const window = object(body[key]);
    windows.push({
      id: key,
      usedPercent: percent(window.utilization),
      resetsAt: reset(window.resets_at),
      modelIds: null,
    });
  }
  // Model-specific windows must not gate unrelated models. Until the provider
  // supplies an unambiguous model mapping, report this observation unavailable.
  for (const [key, value] of Object.entries(body)) {
    if (
      key.startsWith("seven_day_") &&
      key !== "seven_day_breakdown" &&
      value !== null &&
      value !== undefined
    )
      throw new Error("schema");
  }
  if (body.limits !== undefined) {
    if (!Array.isArray(body.limits)) throw new Error("schema");
    for (const raw of body.limits) {
      const limit = object(raw);
      const id =
        limit.kind === "session" ? "five_hour" : limit.kind === "weekly_all" ? "seven_day" : null;
      if (
        !id ||
        limit.scope !== null ||
        percent(limit.percent) !== windows.find((window) => window.id === id)?.usedPercent
      )
        throw new Error("schema");
    }
  }
  return windows;
}

/** OpenCode's official API reports all three subscription windows for this key. */
export function parseGoQuota(payload: unknown): ModelQuotaWindow[] {
  const usage = object(object(payload).usage);
  const ids = { rolling: "five_hour", weekly: "seven_day", monthly: "monthly" };
  if (Object.keys(usage).some((key) => !Object.hasOwn(ids, key))) throw new Error("schema");
  return Object.entries(ids).map(([key, id]) => {
    const window = object(usage[key]);
    if (window.status !== "ok" && window.status !== "rate-limited") throw new Error("schema");
    const resetsAt = reset(window.resetsAt);
    if (!resetsAt) throw new Error("schema");
    return { id, usedPercent: percent(window.percent), resetsAt, modelIds: null };
  });
}

/** GOAT includes 70 monthly plan credits; purchased credits do not expand that pool. */
export function parseCommandCodeQuota(
  creditsPayload: unknown,
  subscriptionPayload: unknown,
): ModelQuotaWindow[] {
  const billing = object(creditsPayload);
  const credits = object(billing.credits);
  const limits = object(billing.windowLimits);
  const subscription = object(object(subscriptionPayload).data);
  if (
    subscription.status !== "active" ||
    typeof subscription.planId !== "string" ||
    !/^individual-goat(?:$|-)/.test(subscription.planId.toLowerCase().replace(/_/g, "-")) ||
    limits.limited !== true ||
    typeof credits.monthlyCredits !== "number" ||
    !Number.isFinite(credits.monthlyCredits) ||
    credits.monthlyCredits < 0 ||
    credits.monthlyCredits > 70
  )
    throw new Error("schema");
  const windows = [
    ["fiveHour", "five_hour"],
    ["weekly", "seven_day"],
  ].map(([key, id]) => {
    const window = object(limits[key!]);
    if (
      typeof window.used !== "number" ||
      !Number.isFinite(window.used) ||
      window.used < 0 ||
      typeof window.cap !== "number" ||
      !Number.isFinite(window.cap) ||
      window.cap <= 0
    )
      throw new Error("schema");
    // CommandCode numeric dates are milliseconds, unlike Codex reset_at seconds.
    const resetsAt = commandCodeReset(window.resetAt);
    if (!resetsAt && window.used !== 0) throw new Error("schema");
    return {
      id: id!,
      usedPercent: Math.min(100, (100 * window.used) / window.cap),
      resetsAt,
      modelIds: null,
    };
  });
  const resetsAt = commandCodeReset(subscription.currentPeriodEnd);
  if (!resetsAt) throw new Error("schema");
  windows.push({
    id: "monthly",
    usedPercent: (100 * (70 - credits.monthlyCredits)) / 70,
    resetsAt,
    modelIds: null,
  });
  return windows;
}

function commandCodeReset(value: unknown): string | null {
  if (value === null || value === undefined || value === 0) return null;
  if (typeof value !== "string" && typeof value !== "number") throw new Error("schema");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) throw new Error("schema");
  return date.toISOString();
}

export type QuotaConnection = {
  userId: string;
  credentialId: string;
  provider: string;
  /** Changes whenever encrypted credential material changes. Never returned to clients. */
  revision: string;
  accessToken: string | null;
  accountId?: string;
  baseUrl?: string;
};
export type QuotaRead = { view: ModelQuota };

async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("http");
  }
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error("size");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) throw new Error("size");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function staleOr(previous: QuotaRead | undefined, empty: QuotaRead): QuotaRead {
  if (!previous?.view.observedAt) return empty;
  return { view: { ...previous.view, status: "stale", checkedAt: empty.view.checkedAt } };
}

/** Read-only, bounded readers. Authentication and refresh remain with the caller. */
export class ModelQuotaReader {
  private readonly cache = new Map<string, { read: QuotaRead; retryAt: number }>();
  private readonly pending = new Map<string, Promise<QuotaRead>>();
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now = Date.now,
  ) {}

  async read(connection: QuotaConnection, options: { fresh?: boolean } = {}): Promise<QuotaRead> {
    const commandCode =
      connection.provider === "openai-compatible" && isCommandCodeBaseUrl(connection.baseUrl);
    const supported =
      commandCode ||
      (connection.provider === "openai-compatible" && isOpenCodeGoBaseUrl(connection.baseUrl)) ||
      ["openai-codex", "anthropic", "opencode-go"].includes(connection.provider);
    const empty: QuotaRead = {
      view: {
        credentialId: connection.credentialId,
        status: supported ? "unavailable" : "unsupported",
        observedAt: null,
        checkedAt: new Date(this.now()).toISOString(),
        windows: [],
      },
    };
    if (!supported) return empty;
    const revision = createHash("sha256").update(connection.revision).digest("hex");
    const key = JSON.stringify([
      connection.userId,
      connection.provider,
      connection.credentialId,
      connection.baseUrl,
      revision,
    ]);
    const cached = this.cache.get(key);
    if (!connection.accessToken) return staleOr(cached?.read, empty);
    if (!options.fresh && cached && cached.retryAt > this.now()) return cached.read;
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const task = this.refresh(key, connection, empty, cached?.read).finally(() =>
      this.pending.delete(key),
    );
    this.pending.set(key, task);
    return task;
  }

  private async refresh(
    key: string,
    connection: QuotaConnection,
    empty: QuotaRead,
    previous?: QuotaRead,
  ): Promise<QuotaRead> {
    const observedAt = this.now();
    let read = empty;
    try {
      const codex = connection.provider === "openai-codex";
      const go =
        connection.provider === "opencode-go" ||
        (connection.provider === "openai-compatible" && isOpenCodeGoBaseUrl(connection.baseUrl));
      const commandCode =
        connection.provider === "openai-compatible" && isCommandCodeBaseUrl(connection.baseUrl);
      if (codex && !connection.accountId) throw new Error("identity");
      const headers: Record<string, string> = {
        authorization: `Bearer ${connection.accessToken}`,
        accept: "application/json",
      };
      if (codex) headers["chatgpt-account-id"] = connection.accountId!;
      else if (!go && !commandCode) headers["anthropic-beta"] = "oauth-2025-04-20";
      const get = async (url: string) =>
        jsonResponse(
          await this.fetchImpl(url, {
            headers,
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          }),
        );
      let commandCodeWindows: ModelQuotaWindow[] | undefined;
      if (commandCode) {
        const who = object(await get("https://api.commandcode.ai/alpha/whoami?limits=1"));
        const org = who.org === null || who.org === undefined ? null : object(who.org);
        if (org && (typeof org.id !== "string" || !org.id)) throw new Error("identity");
        const query = org ? `?${new URLSearchParams({ orgId: org.id as string })}` : "";
        const [credits, subscription] = await Promise.all([
          get(`https://api.commandcode.ai/alpha/billing/credits${query}`),
          get(`https://api.commandcode.ai/alpha/billing/subscriptions${query}`),
        ]);
        commandCodeWindows = parseCommandCodeQuota(credits, subscription);
      }
      const payload = commandCode
        ? null
        : await get(
            codex
              ? "https://chatgpt.com/backend-api/wham/usage"
              : go
                ? "https://opencode.ai/zen/go/v1/usage"
                : "https://api.anthropic.com/api/oauth/usage",
          );
      read = {
        view: {
          ...empty.view,
          status: "fresh",
          observedAt: new Date(observedAt).toISOString(),
          windows:
            commandCodeWindows ??
            (codex
              ? parseCodexQuota(payload)
              : go
                ? parseGoQuota(payload)
                : parseClaudeQuota(payload)),
        },
      };
    } catch {
      // Provider errors can contain tokens and account identifiers. Preserve only
      // the last good observation with its original timestamp, never the body.
      read = staleOr(previous, empty);
    }
    if (this.cache.size >= MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, {
      read,
      retryAt: this.now() + (read.view.status === "fresh" ? MAX_AGE_MS : FAILURE_TTL_MS),
    });
    return read;
  }
}
