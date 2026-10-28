import { describe, expect, it, vi } from "vitest";
import {
  ModelQuotaReader,
  parseClaudeQuota,
  parseCodexQuota,
  parseCommandCodeQuota,
  parseGoQuota,
} from "./model-quota.js";

const codex = {
  rate_limit: {
    primary_window: { used_percent: 59, reset_at: 1_900_000_000 },
    secondary_window: null,
  },
  additional_rate_limits: [],
};
const claude = {
  five_hour: { utilization: 0, resets_at: "2030-03-17T12:00:00Z" },
  seven_day: { utilization: 91, resets_at: "2030-03-20T12:00:00Z" },
  seven_day_sonnet: null,
};
const connection = {
  userId: "user-a",
  credentialId: "connection-a",
  provider: "openai-codex",
  revision: "revision-a",
  accessToken: "test-access-token",
  accountId: "test-account",
};
const response = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("model quota observations", () => {
  it("accepts the weekly usage breakdown without treating it as another allowance", () => {
    expect(
      parseClaudeQuota({
        ...claude,
        seven_day_breakdown: { rows: [{ key: "model-a", percent: 91 }] },
        limits: [
          { kind: "session", scope: null, percent: 0 },
          { kind: "weekly_all", scope: null, percent: 91 },
        ],
      }),
    ).toHaveLength(2);
    expect(() =>
      parseClaudeQuota({ ...claude, limits: [{ kind: "unknown_scope", scope: null, percent: 0 }] }),
    ).toThrow();
  });
  it("keeps known zero distinct from unknown and preserves provider resets", () => {
    expect(parseClaudeQuota(claude)).toMatchObject([{ usedPercent: 0 }, { usedPercent: 91 }]);
    expect(parseCodexQuota(codex)).toEqual([
      {
        id: "primary_window",
        usedPercent: 59,
        resetsAt: "2030-03-17T17:46:40.000Z",
        modelIds: null,
      },
    ]);
  });
  it.each([
    null,
    {},
    { rate_limit: {} },
    { rate_limit: { primary_window: { used_percent: -1 } } },
    { rate_limit: { primary_window: { used_percent: 101 } } },
    { ...codex, additional_rate_limits: [{}] },
  ])("rejects incomplete or unknown limiting windows: %j", (value) => {
    expect(() => parseCodexQuota(value)).toThrow();
  });
  it("does not apply an unmapped Claude model window to every model", () => {
    expect(() => parseClaudeQuota({ ...claude, seven_day_sonnet: { utilization: 100 } })).toThrow();
  });
  it("refreshes admission reads instead of reusing the settings cache", async () => {
    let clock = Date.parse("2030-01-01T00:00:00Z");
    const fetcher = vi.fn(async () => {
      const result = response(codex);
      clock += 1000;
      return result;
    });
    const reader = new ModelQuotaReader(fetcher, () => clock);
    const first = await reader.read(connection);
    await reader.read(connection);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const fresh = await reader.read(connection, { fresh: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fresh.view.observedAt).not.toBe(first.view.observedAt);
    expect(fresh.view.observedAt).toBe(new Date(clock - 1000).toISOString());
  });
  it("deduplicates concurrent refreshes and retains a bounded successful cache", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request) => response(codex));
    const reader = new ModelQuotaReader(fetcher);
    const results = await Promise.all(Array.from({ length: 10 }, () => reader.read(connection)));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.view.status === "fresh")).toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(JSON.stringify(results)).not.toContain("test-access-token");
    expect(JSON.stringify(results)).not.toContain("test-account");
  });
  it("retains the original observation time after failure and invalidates changed credentials", async () => {
    let now = 1_900_000_000_000;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(codex))
      .mockRejectedValue(new Error("private provider diagnostic"));
    const reader = new ModelQuotaReader(fetcher, () => now);
    const first = await reader.read(connection);
    now += 61_000;
    const stale = await reader.read(connection);
    expect(stale.view.status).toBe("stale");
    expect(stale.view.observedAt).toBe(first.view.observedAt);
    expect(stale.view.checkedAt).not.toBe(first.view.checkedAt);
    expect(JSON.stringify(stale)).not.toContain("private provider diagnostic");
    const changed = await reader.read({ ...connection, revision: "revision-b" });
    expect(changed.view.status).toBe("unavailable");
    expect(changed.view.observedAt).toBeNull();
  });
  it("keeps the last reading as stale while an expired token refreshes", async () => {
    const fetcher = vi.fn(async () => response(codex));
    const reader = new ModelQuotaReader(fetcher);
    const first = await reader.read(connection);
    const expired = await reader.read({ ...connection, accessToken: null });
    expect(expired.view.status).toBe("stale");
    expect(expired.view.windows).toEqual(first.view.windows);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("never dispatches for unsupported, expired or unidentified Codex accounts", async () => {
    const fetcher = vi.fn();
    const reader = new ModelQuotaReader(fetcher);
    expect((await reader.read({ ...connection, provider: "other" })).view.status).toBe(
      "unsupported",
    );
    expect((await reader.read({ ...connection, accessToken: null })).view.status).toBe(
      "unavailable",
    );
    expect((await reader.read({ ...connection, accountId: undefined })).view.status).toBe(
      "unavailable",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reads Claude subscription windows with the connected OAuth credential", async () => {
    const fetcher = vi.fn(async () => response(claude));
    const result = await new ModelQuotaReader(fetcher).read({
      ...connection,
      provider: "anthropic",
    });
    expect(result.view.status).toBe("fresh");
    expect(result.view.windows).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized responses without returning a partial quota", async () => {
    const result = await new ModelQuotaReader(async () => new Response(" ".repeat(65_537))).read(
      connection,
    );
    expect(result.view.status).toBe("unavailable");
    expect(result.view.windows).toEqual([]);
  });
  it("keeps HTTP failures unavailable and blocks redirects", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
      expect(options?.redirect).toBe("error");
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return new Response("private error", { status: 401 });
    });
    expect((await new ModelQuotaReader(fetcher).read(connection)).view.status).toBe("unavailable");
  });
});

const go = {
  usage: {
    rolling: { status: "ok", percent: 0, resetsAt: "2030-03-17T17:00:00Z" },
    weekly: { status: "ok", percent: 54, resetsAt: "2030-03-20T12:00:00Z" },
    monthly: { status: "rate-limited", percent: 100, resetsAt: "2030-04-01T12:00:00Z" },
  },
};
it("reads all Go windows from the exact saved key without claiming a verified account pool", async () => {
  const fetcher = vi.fn(async () => response(go));
  const result = await new ModelQuotaReader(fetcher).read({
    ...connection,
    provider: "opencode-go",
    accountId: undefined,
  });
  expect(fetcher).toHaveBeenCalledWith(
    "https://opencode.ai/zen/go/v1/usage",
    expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer test-access-token" }),
      redirect: "error",
    }),
  );
  expect(result.view).toMatchObject({
    status: "fresh",
    windows: [
      { id: "five_hour", usedPercent: 0 },
      { id: "seven_day", usedPercent: 54 },
      { id: "monthly", usedPercent: 100 },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("test-access-token");
});
it("rejects incomplete and unknown Go windows", () => {
  expect(() => parseGoQuota({ usage: { ...go.usage, monthly: null } })).toThrow();
  expect(() =>
    parseGoQuota({ usage: { ...go.usage, monthly: { ...go.usage.monthly, status: "unknown" } } }),
  ).toThrow();
  expect(() => parseGoQuota({ usage: { ...go.usage, extra: go.usage.weekly } })).toThrow();
});

const commandCodeCredits = {
  credits: { monthlyCredits: 2, purchasedCredits: 500 },
  windowLimits: {
    limited: true,
    fiveHour: { used: 0, cap: 14, resetAt: 0 },
    weekly: { used: 35.01, cap: 35, resetAt: 1_900_000_000_000 },
  },
};
const commandCodeSubscription = {
  data: { status: "active", planId: "individual-goat", currentPeriodEnd: "2030-04-01T12:00:00Z" },
};
it("reads CommandCode's three subscription windows with the exact compatible key", async () => {
  const fetcher = vi.fn(async (url: string | URL | Request) =>
    response(
      String(url).includes("/whoami")
        ? { org: { id: "test org" } }
        : String(url).includes("/credits")
          ? commandCodeCredits
          : commandCodeSubscription,
    ),
  );
  const result = await new ModelQuotaReader(fetcher).read({
    ...connection,
    provider: "openai-compatible",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    accountId: undefined,
  });
  expect(fetcher.mock.calls.map((call) => String(call[0]))).toEqual([
    "https://api.commandcode.ai/alpha/whoami?limits=1",
    "https://api.commandcode.ai/alpha/billing/credits?orgId=test+org",
    "https://api.commandcode.ai/alpha/billing/subscriptions?orgId=test+org",
  ]);
  expect(result.view).toMatchObject({
    status: "fresh",
    windows: [
      { id: "five_hour", usedPercent: 0, resetsAt: null },
      { id: "seven_day", usedPercent: 100, resetsAt: "2030-03-17T17:46:40.000Z" },
      { id: "monthly", usedPercent: (100 * 68) / 70, resetsAt: "2030-04-01T12:00:00.000Z" },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("test org");
  expect(JSON.stringify(result)).not.toContain("test-access-token");
});
it("does not send arbitrary compatible credentials to CommandCode", async () => {
  const fetcher = vi.fn();
  for (const baseUrl of [
    undefined,
    "http://api.commandcode.ai/provider/v1",
    "https://api.commandcode.ai.evil.test/provider/v1",
    "https://api.commandcode.ai/provider/v1?key=other",
    "https://other.example.test/v1",
  ]) {
    const result = await new ModelQuotaReader(fetcher).read({
      ...connection,
      provider: "openai-compatible",
      baseUrl,
    });
    expect(result.view.status).toBe("unsupported");
  }
  expect(fetcher).not.toHaveBeenCalled();
});
it("rejects incomplete CommandCode billing and never counts purchased credits as subscription headroom", async () => {
  for (const credits of [
    null,
    {},
    { ...commandCodeCredits, credits: { monthlyCredits: -1 } },
    { ...commandCodeCredits, credits: { monthlyCredits: 71 } },
    {
      ...commandCodeCredits,
      windowLimits: {
        ...commandCodeCredits.windowLimits,
        weekly: { used: 1, cap: 35, resetAt: 0 },
      },
    },
  ]) {
    expect(() => parseCommandCodeQuota(credits, commandCodeSubscription)).toThrow();
  }
  expect(() =>
    parseCommandCodeQuota(commandCodeCredits, {
      data: { ...commandCodeSubscription.data, status: "inactive" },
    }),
  ).toThrow();
});
it("reads individual CommandCode usage without adding an organization and keeps failures private", async () => {
  let fail = false;
  const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    expect(options?.redirect).toBe("error");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.headers).toEqual({
      authorization: "Bearer test-access-token",
      accept: "application/json",
    });
    if (fail) return new Response("private upstream diagnostic", { status: 401 });
    return response(
      String(url).includes("/whoami")
        ? {}
        : String(url).endsWith("/credits")
          ? commandCodeCredits
          : commandCodeSubscription,
    );
  });
  const reader = new ModelQuotaReader(fetcher);
  const goat = {
    ...connection,
    provider: "openai-compatible",
    baseUrl: "https://api.commandcode.ai/provider/v1",
  };
  const first = await reader.read(goat);
  expect(first.view.status).toBe("fresh");
  expect(fetcher.mock.calls.map((call) => String(call[0]))).toContain(
    "https://api.commandcode.ai/alpha/billing/credits",
  );
  fail = true;
  const failed = await reader.read(goat, { fresh: true });
  expect(failed.view.status).toBe("stale");
  expect(failed.view.observedAt).toBe(first.view.observedAt);
  expect(JSON.stringify(failed)).not.toContain("private upstream diagnostic");
});

it("recognizes a manually saved OpenCode Go compatible URL and reads its native usage", async () => {
  const fetcher = vi.fn(async () => response(go));
  const result = await new ModelQuotaReader(fetcher).read({
    ...connection,
    provider: "openai-compatible",
    baseUrl: "https://opencode.ai/zen/go/v1",
  });
  expect(fetcher).toHaveBeenCalledWith(
    "https://opencode.ai/zen/go/v1/usage",
    expect.objectContaining({
      headers: { authorization: "Bearer test-access-token", accept: "application/json" },
    }),
  );
  expect(result.view).toMatchObject({
    status: "fresh",
    windows: [{ id: "five_hour" }, { id: "seven_day" }, { id: "monthly" }],
  });
});
