import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkloadIdentityKeyResolver,
  exchangeWorkloadIdentity,
} from "./workload-identity.js";

const warn = vi.hoisted(() => vi.fn());
vi.mock("@rakazo/logging", () => ({ getLogger: () => ({ warn }) }));
vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

beforeEach(() => warn.mockClear());

const binding = {
  tokenFile: "fixture-token",
  identityProviderId: "fixture-provider",
  serviceAccountId: "fixture-account",
};

describe("workload identity exchange", () => {
  it("exchanges the mounted assertion for an expiring inference credential", async () => {
    vi.mocked(readFile).mockResolvedValue("fixture-assertion\n");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ access_token: "fixture-bearer", expires_in: 600 }));
    const token = await exchangeWorkloadIdentity(binding, new AbortController().signal, fetcher);
    expect(token.key).toBe("fixture-bearer");
    expect(token.expiresAt).toBeGreaterThan(Date.now());
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://auth.openai.com/oauth/token");
    expect(options?.redirect).toBe("error");
    expect(JSON.parse(String(options?.body))).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: "fixture-assertion",
      identity_provider_id: "fixture-provider",
      service_account_id: "fixture-account",
    });
  });

  it("logs only the safe file-read code", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(
      Object.assign(new Error("private-path-and-diagnostic"), { code: "ENOENT" }),
    );
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      exchangeWorkloadIdentity(binding, new AbortController().signal, fetcher),
    ).rejects.toMatchObject({
      kind: "SERVICE_UNAVAILABLE",
      message: "Could not read the workload identity assertion.",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([
      ["OpenAI workload identity assertion read failed", { code: "ENOENT" }],
    ]);
  });

  it.each(["ECONNRESET", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"])(
    "logs only the safe transport phase and nested error code %s",
    async (code) => {
      vi.mocked(readFile).mockResolvedValue("fixture-assertion");
      const cause = Object.assign(new Error("private-host-and-diagnostic"), { code });
      const fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new TypeError("fetch failed", { cause }));
      await expect(
        exchangeWorkloadIdentity(binding, new AbortController().signal, fetcher),
      ).rejects.toMatchObject({
        kind: "SERVICE_UNAVAILABLE",
        message: "Could not reach the OpenAI token service.",
      });
      expect(warn.mock.calls).toEqual([
        ["OpenAI workload identity transport failed", { phase: "fetch", code }],
      ]);
    },
  );

  it("does not classify an unexpected transport defect as a provider outage", async () => {
    vi.mocked(readFile).mockResolvedValue("fixture-assertion");
    const bug = new TypeError("fixture defect echoing fixture-assertion");
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(bug);
    const error = await exchangeWorkloadIdentity(
      binding,
      new AbortController().signal,
      fetcher,
    ).catch((error: unknown) => error);
    expect(error).toStrictEqual(new Error("Unexpected OpenAI token service request failure."));
    expect(error).not.toHaveProperty("cause");
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a token service outage without exposing its response", async () => {
    vi.mocked(readFile).mockResolvedValue("fixture-assertion");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ detail: "fixture-assertion" }, { status: 503 }));
    await expect(
      exchangeWorkloadIdentity(binding, new AbortController().signal, fetcher),
    ).rejects.toMatchObject({
      kind: "SERVICE_UNAVAILABLE",
      message: "The OpenAI token service is unavailable.",
    });
  });

  it("does not surface a malformed successful token response", async () => {
    vi.mocked(readFile).mockResolvedValue("fixture-assertion");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("fixture-bearer"));
    await expect(
      exchangeWorkloadIdentity(binding, new AbortController().signal, fetcher),
    ).rejects.toMatchObject({
      kind: "SERVICE_UNAVAILABLE",
      message: "The OpenAI token service returned an invalid response.",
    });
  });

  it("does not surface a rejected provider response with credentials in it", async () => {
    vi.mocked(readFile).mockResolvedValue("fixture-assertion");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ detail: "fixture-assertion" }, { status: 401 }));
    await expect(
      exchangeWorkloadIdentity(binding, new AbortController().signal, fetcher),
    ).rejects.toThrow(/^Model OAuth exchange failed. Check the workload identity binding\.$/);
  });
});

describe("deployment workload identity cache", () => {
  const env = {
    OPENAI_IDENTITY_TOKEN_FILE: "/run/identity/token",
    OPENAI_IDENTITY_PROVIDER_ID: "fixture-provider",
    OPENAI_SERVICE_ACCOUNT_ID: "fixture-account",
  };

  it("shares a refresh and does not carry tokens across a binding change", async () => {
    const exchange = vi
      .fn<typeof exchangeWorkloadIdentity>()
      .mockImplementation(async (binding) => ({
        key: (binding as { serviceAccountId: string }).serviceAccountId,
        expiresAt: Date.now() + 60_000,
      }));
    const resolve = createWorkloadIdentityKeyResolver(exchange);

    await expect(Promise.all([resolve(env), resolve(env)])).resolves.toEqual([
      "fixture-account",
      "fixture-account",
    ]);
    expect(exchange).toHaveBeenCalledTimes(1);
    await expect(resolve({ ...env, OPENAI_SERVICE_ACCOUNT_ID: "other-account" })).resolves.toBe(
      "other-account",
    );
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it("replaces a token near expiry", async () => {
    const exchange = vi
      .fn<typeof exchangeWorkloadIdentity>()
      .mockResolvedValueOnce({ key: "expiring-bearer", expiresAt: Date.now() + 10_000 })
      .mockResolvedValueOnce({ key: "fresh-bearer", expiresAt: Date.now() + 60_000 });
    const resolve = createWorkloadIdentityKeyResolver(exchange);

    await expect(resolve(env)).resolves.toBe("expiring-bearer");
    await expect(resolve(env)).resolves.toBe("fresh-bearer");
    await expect(resolve(env)).resolves.toBe("fresh-bearer");
    expect(exchange).toHaveBeenCalledTimes(2);
  });
});
