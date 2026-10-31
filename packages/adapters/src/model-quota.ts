import { createHash } from "node:crypto";
import type { ModelQuota, ModelQuotaBalance, ModelQuotaWindow } from "@rakazo/contracts";
import {
  isCommandCodeBaseUrl,
  isOpenCodeGoBaseUrl,
  isOpenRouterBaseUrl,
  isSyntheticBaseUrl,
} from "@rakazo/contracts";

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
  // Model-scoped weekly limits constrain only the named model. They are reported
  // as their own windows, and a malformed entry never hides the shared allowance.
  const scoped = (name: string, used: unknown, resetsAt: unknown) => {
    try {
      const window: ModelQuotaWindow = {
        id: `seven_day_model_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
        usedPercent: percent(used),
        resetsAt: reset(resetsAt),
        modelIds: [name],
        label: name.slice(0, 128),
      };
      if (!windows.some((existing) => existing.id === window.id)) windows.push(window);
    } catch {
      // Skip this entry only.
    }
  };
  for (const [key, name] of [
    ["seven_day_opus", "Opus"],
    ["seven_day_sonnet", "Sonnet"],
  ] as const) {
    const value = body[key];
    if (value && typeof value === "object" && !Array.isArray(value))
      scoped(name, (value as ObjectValue).utilization, (value as ObjectValue).resets_at);
  }
  if (Array.isArray(body.limits)) {
    for (const raw of body.limits) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const limit = raw as ObjectValue;
      if (limit.kind !== "weekly_scoped") continue;
      const scope = limit.scope;
      if (!scope || typeof scope !== "object" || Array.isArray(scope)) continue;
      const model = (scope as ObjectValue).model;
      if (!model || typeof model !== "object" || Array.isArray(model)) continue;
      const { id, display_name: displayName } = model as ObjectValue;
      const name =
        typeof displayName === "string" && displayName.trim()
          ? displayName.trim()
          : typeof id === "string" && id.trim()
            ? id.trim()
            : null;
      if (name) scoped(name, limit.percent, limit.resets_at);
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

function amount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Percent used from an explicit percentage or from limit and usage counts. */
function syntheticUsedPercent(window: ObjectValue): number {
  for (const key of ["usedPercent", "percentUsed"]) {
    if (window[key] !== undefined) return percent(window[key]);
  }
  for (const key of ["percentRemaining", "remainingPercent"]) {
    if (window[key] !== undefined) return 100 - percent(window[key]);
  }
  const limit = amount(window.limit);
  let used = amount(window.requests) ?? amount(window.used);
  const remaining = amount(window.remaining);
  if (used === null && limit !== null && remaining !== null) used = limit - remaining;
  if (limit === null || limit <= 0 || used === null || used < 0) throw new Error("schema");
  return Math.min(100, (used / limit) * 100);
}

/**
 * Synthetic's rolling request allowance and weekly limit both gate every model.
 * The hourly search allowance gates only its search tool, so it is not read.
 */
export function parseSyntheticQuota(payload: unknown): ModelQuotaWindow[] {
  const body = object(payload);
  const root = body.data && typeof body.data === "object" ? object(body.data) : body;
  const rolling = root.rollingFiveHourLimit ?? root.subscription;
  const fiveHour = object(rolling);
  const windows: ModelQuotaWindow[] = [
    {
      id: "five_hour",
      usedPercent: syntheticUsedPercent(fiveHour),
      resetsAt: reset(fiveHour.renewsAt ?? fiveHour.resetsAt),
      modelIds: null,
    },
  ];
  const weeklyRaw = root.weeklyTokenLimit ?? root.planWeeklyLimit;
  if (weeklyRaw !== undefined && weeklyRaw !== null) {
    const weekly = object(weeklyRaw);
    // The weekly limit regenerates in small steps, so the next step is not
    // reported as a reset.
    windows.push({
      id: "seven_day",
      usedPercent: syntheticUsedPercent(weekly),
      resetsAt: null,
      modelIds: null,
    });
  }
  return windows;
}

/**
 * The key's own spending limit and any budgets applied to it, plus the account
 * balance when the key may read it. Lifetime usage is never subtracted from a
 * resetting limit: the reported remaining amount is authoritative.
 */
export function parseOpenRouterQuota(
  keyPayload: unknown,
  creditsPayload: unknown,
): { windows: ModelQuotaWindow[]; balance: ModelQuotaBalance | null } {
  const key = object(object(keyPayload).data);
  if (amount(key.usage) === null) throw new Error("schema");
  const windows: ModelQuotaWindow[] = [];
  const spent = (limit: number, remaining: number) =>
    limit === 0 ? 100 : Math.min(100, Math.max(0, (1 - remaining / limit) * 100));
  if (key.budgets !== undefined && key.budgets !== null && !Array.isArray(key.budgets))
    throw new Error("schema");
  const budgets = ((key.budgets as unknown[] | null | undefined) ?? []).map(object);
  if (key.limit !== null && key.limit !== undefined) {
    const limit = amount(key.limit);
    const remaining = amount(key.limit_remaining);
    if (limit === null || remaining === null || remaining > limit) throw new Error("schema");
    // The key's own limit is also listed among its budgets, with its reset time.
    const own = budgets.find((budget) => budget.scope === "key_limit");
    windows.push({
      id: "key_limit",
      usedPercent: spent(limit, remaining),
      resetsAt: reset(own?.resets_at),
      modelIds: null,
    });
  }
  budgets
    .filter((budget) => budget.scope !== "key_limit")
    .forEach((budget, index) => {
      const limit = amount(budget.limit_usd);
      const remaining = amount(budget.remaining_usd);
      if (limit === null || remaining === null || remaining > limit) throw new Error("schema");
      windows.push({
        id: `budget_${index + 1}`,
        usedPercent: spent(limit, remaining),
        resetsAt: reset(budget.resets_at),
        modelIds: null,
      });
    });
  let balance: ModelQuotaBalance | null = null;
  if (creditsPayload && typeof creditsPayload === "object") {
    const credits = (creditsPayload as ObjectValue).data;
    if (credits && typeof credits === "object" && !Array.isArray(credits)) {
      const total = amount((credits as ObjectValue).total_credits);
      const used = amount((credits as ObjectValue).total_usage);
      if (total !== null && used !== null)
        balance = { remaining: Math.max(0, total - used), currency: "USD" };
    }
  }
  return { windows, balance };
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
  /** How the connection authenticates; an API key has no subscription allowance. */
  authKind?: "api_key" | "oauth";
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

function isOpenRouter(connection: QuotaConnection): boolean {
  return (
    connection.provider === "openrouter" ||
    (connection.provider === "openai-compatible" && isOpenRouterBaseUrl(connection.baseUrl))
  );
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
      (connection.provider === "openai-compatible" && isSyntheticBaseUrl(connection.baseUrl)) ||
      isOpenRouter(connection) ||
      (connection.provider === "anthropic" && connection.authKind !== "api_key") ||
      ["openai-codex", "opencode-go"].includes(connection.provider);
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
      const synthetic =
        connection.provider === "openai-compatible" && isSyntheticBaseUrl(connection.baseUrl);
      const openRouter = isOpenRouter(connection);
      if (codex && !connection.accountId) throw new Error("identity");
      const headers: Record<string, string> = {
        authorization: `Bearer ${connection.accessToken}`,
        accept: "application/json",
      };
      if (codex) headers["chatgpt-account-id"] = connection.accountId!;
      else if (!go && !commandCode && !synthetic && !openRouter)
        headers["anthropic-beta"] = "oauth-2025-04-20";
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
      let openRouterQuota: ReturnType<typeof parseOpenRouterQuota> | undefined;
      if (openRouter) {
        const [keyPayload, creditsPayload] = await Promise.all([
          get("https://openrouter.ai/api/v1/key"),
          // Account credits may require a management key; a refusal leaves the balance unknown.
          get("https://openrouter.ai/api/v1/credits").catch(() => null),
        ]);
        openRouterQuota = parseOpenRouterQuota(keyPayload, creditsPayload);
      }
      const payload =
        commandCode || openRouter
          ? null
          : await get(
              codex
                ? "https://chatgpt.com/backend-api/wham/usage"
                : go
                  ? "https://opencode.ai/zen/go/v1/usage"
                  : synthetic
                    ? "https://api.synthetic.new/v2/quotas"
                    : "https://api.anthropic.com/api/oauth/usage",
            );
      read = {
        view: {
          ...empty.view,
          status: "fresh",
          observedAt: new Date(observedAt).toISOString(),
          ...(openRouterQuota ? { balance: openRouterQuota.balance } : {}),
          windows:
            openRouterQuota?.windows ??
            commandCodeWindows ??
            (codex
              ? parseCodexQuota(payload)
              : go
                ? parseGoQuota(payload)
                : synthetic
                  ? parseSyntheticQuota(payload)
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
